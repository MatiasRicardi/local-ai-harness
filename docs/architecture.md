# Architecture — Local AI Harness

Reference architecture of **Local AI Harness**, a local, single-user web chat
application that talks to any **OpenAI-compatible** model server.

> Scope: documentation of the actual implementation. No product behavior is
> described here that is not implemented in this repository.

## Contents

- [Layout](#layout)
- [High-level architecture](#high-level-architecture)
- [Backend](#backend)
- [Frontend](#frontend)
- [API contract](#api-contract)
- [Chat data flow](#chat-data-flow)
- [Built-in tools](#built-in-tools)
- [Tool execution limits](#tool-execution-limits)
- [Configuration](#configuration)
- [File handling](#file-handling)
- [Context management](#context-management)
- [Error handling](#error-handling)
- [Testing](#testing)

## Layout

```text
local-ai-harness/
├── backend/            # Node.js + Fastify + TypeScript
│   ├── src/
│   │   ├── config/env.ts        # Zod-validated configuration
│   │   ├── server.ts            # Entry point (startup, cleanup, signals)
│   │   ├── app.ts               # buildApp(): plugins + route registration
│   │   ├── routes/              # health, provider, chat, files
│   │   ├── provider/            # OpenAI-compatible client, SSE parser, schemas
│   │   ├── orchestration/       # chatOrchestrator, toolCallValidation, turnSources
│   │   ├── tools/               # registry + calculator / fetch_url / web_search
│   │   ├── search/              # WebSearchProvider contract + Tavily provider
│   │   ├── extractors/          # txt, markdown, pdf, text-utils
│   │   ├── files/cleanup.ts     # temporary-file lifecycle + path safety
│   │   ├── context/             # context-budget, token-estimate, toolResultBudget
│   │   └── utils/               # errorHandler, documentContext, runtimeContext,
│   │                            # systemInstructions, toolGuidance
│   ├── Dockerfile
│   └── .env.example
├── frontend/
│   ├── src/
│   │   ├── components/          # AppHeader, ProviderSettings + settings cards
│   │   │                        # (Connection, Runtime, WebSearch, BuiltInTool),
│   │   │                        # ChatMessages, ChatInput, ChatEmptyState,
│   │   │                        # DocumentAttachment, AppIcon
│   │   ├── composables/         # useProviderSettings, useWebSearchSettings,
│   │   │                        # useToolSettings, useConnectionTest
│   │   ├── services/            # apiBase, chat, files, provider
│   │   ├── utils/               # markdown (markdown-it + DOMPurify), parseApiError,
│   │   │                        # runtimeContext (browser timezone/locale collection)
│   │   ├── types/               # error types
│   │   ├── App.vue              # root component
│   │   └── main.ts              # entry point
│   ├── Dockerfile               # nginx static server
│   ├── nginx.conf               # reverse proxy for /api
│   └── .env.example
├── docs/
├── docker-compose.yml
├── pnpm-workspace.yaml
└── package.json
```

## High-level architecture

```text
Browser
  │  (same-origin /api, or http://127.0.0.1:5173/api in dev)
  ├── nginx (Docker) ──► backend:3000        # production proxy
  └── Vite dev proxy ──► 127.0.0.1:3000      # development proxy
        │
        ▼
  Fastify backend (Node 22)
        │  OpenAI-compatible HTTP / SSE
        ▼
  Model server (Ollama / llama.cpp / LM Studio, on the host)
```

The browser never talks to the model server directly, and the browser bundle
never contains a Docker service DNS name (`http://backend:3000`), which the
browser cannot resolve. **By default** browser↔backend traffic uses a relative
`/api` base that each runtime resolves to the right target.

## Backend

**Entry point** (`server.ts`):

1. Builds the app (`buildApp`).
2. Ensures the configured upload directory exists (fail-fast).
3. Best-effort removes stale temporary files from previous runs.
4. Listens on `AI_HOST:AI_PORT`.
5. Handles `SIGINT`/`SIGTERM` for a clean shutdown.

**App assembly** (`app.ts`):

- `@fastify/cors` with `AI_CORS_ORIGINS` (methods GET/POST/PUT/DELETE/OPTIONS).
- `@fastify/sse` for streaming.
- `@fastify/multipart` for uploads (`fileSize` = `AI_MAX_UPLOAD_SIZE_MB`).
- Global error handler.
- Route plugins: `health`, `provider`, `chat`, `files`.

**Routes** (`routes/`):

| Method + path            | Purpose                                                        |
|--------------------------|----------------------------------------------------------------|
| `GET /api/health`        | Liveness probe; returns `{ status, name, version }`.           |
| `POST /api/provider/test`| Sends a minimal prompt and returns a normalized greeting.      |
| `POST /api/chat`         | Non-streaming chat completion (legacy path).                   |
| `POST /api/chat/stream`  | Streamed chat completion via SSE; supports client cancel.      |
| `POST /api/files`        | Validates, stores, extracts text, returns a document context, then deletes the temp file. |

**Provider client** (`provider/`):

- `client.ts` — `OpenAICompatibleClient` talks to `<baseUrl>/v1/chat/completions`
  (streaming), using the standard OpenAI request shape. Provider tests send a
  minimal chat completion through the same client.
- `sseParser.ts` — parses the server-sent-events stream from the provider.
- `types.ts` / `schemas.ts` — Zod schemas for provider config and chat messages.

**Extractors** (`extractors/`):

- `txt.ts`, `markdown.ts`, `pdf.ts` — one per supported extension.
- `text-utils.ts` — normalizes line endings and removes null characters.
- `types.ts` — `ExtractionResult` / `PdfExtractionResult`.
- `ExtractionError.ts` — typed extraction failure.

Supported input: `.txt`, `.md` (UTF-8 text) and `.pdf` (text extraction only;
no OCR).

**Built-in tools** (`tools/`): a request-scoped `ToolRegistry` plus the tool
implementations. See [Built-in tools](#built-in-tools) for the layering, and
[Tool execution limits](#tool-execution-limits) for every bound.

- `registry.ts` / `types.ts` — registration, duplicate-name rejection, the
  harness-internal `executionPolicy.maxExecutionsPerTurn`, and the OpenAI-shaped
  tool definitions (`openAiToolDefinition.ts`).
- `calculatorExpression.ts` / `calculatorTool.ts` — explicit expression engine and
  its tool wrapper.
- `fetchUrlPolicy.ts` / `fetchUrlClient.ts` / `fetchUrlContent.ts` / `fetchUrlTool.ts`
  — destination policy, transport, extraction, tool wrapper.
- `webSearchTool.ts` / `webSearchFormat.ts` — the `web_search` tool over the search
  provider and its untrusted-result formatting.
- `untrustedContent.ts` / `sourceSanitization.ts` — shared untrusted-content
  boundaries and source sanitization.

**Search providers** (`search/`): `types.ts` keeps the provider-agnostic
`WebSearchProvider` contract and the request bounds; `tavily.ts` is the only
implementation in this release.

**Orchestration** (`orchestration/`):

- `chatOrchestrator.ts` — the bounded sequential tool loop (model round → tool
  execution → follow-up round → final answer), tool-result context budgeting and
  SSE-facing event emission.
- `toolCallValidation.ts` — validates model-supplied tool calls against the
  registry and the per-turn caps.
- `turnSources.ts` — `TurnSourceAccumulator`, the turn-local id allocator keyed by
  normalized URL.

**Context budgeting** (`context/`): `context-budget.ts` (conversation + document
budget, see [Context management](#context-management)), `token-estimate.ts`, and
`toolResultBudget.ts`, which budgets each tool result against the same cumulative
input budget (see [Tool execution limits](#tool-execution-limits)).

## Frontend

**Entry** (`main.ts`) mounts the Vue 3 app rooted at `App.vue`.

**Services** (`services/`):

- `apiBase.ts` — resolves the browser-facing API base. `VITE_API_URL` is a
  build-time value; the default empty string makes every request same-origin
  (`/api/...`). It also rejects non-local `http://` bases (CWE-319) so a
  sensitive payload is never sent over cleartext to a remote server.

  An empty `VITE_API_URL` inherits the page origin rather than a fixed `/api`
  base. That is safe for local development (loopback traffic never leaves the
  machine), but on a non-local deployment served over HTTP it would still send
  sensitive payloads over cleartext; HTTPS is required for non-local
  deployments. See [docs/security.md](security.md).
- `chat.ts` — streaming chat (`/api/chat/stream`) and non-streaming
  (`/api/chat`), plus stop/cancel. It owns the SSE parsing/normalization:
  tool-lifecycle callbacks (`onToolStart` / `onToolEnd` / `onSources`) and
  `sanitizeSourcesForDisplay()`, which re-validates source URLs (only safe
  `http:`/`https:` without credentials) so consumers render trusted metadata.
- `files.ts` — document upload; the extracted text is returned inline (no separate download/delete endpoint).
- `provider.ts` — provider connection test.

**Composables**:

- `useProviderSettings.ts` — persists provider settings to `localStorage`; also
  owns the `MIN_CONTEXT_SIZE` / `MAX_CONTEXT_SIZE` bounds and
  `clampContextSize()` used by the context control.
- `useWebSearchSettings.ts` — persists Tavily web-search settings (API key only;
  the base URL stays backend configuration) to `localStorage`.
- `useToolSettings.ts` — persists the built-in tool toggles (`calculator`,
  `fetch_url`) to `localStorage`. Both default off and are fully independent of
  the web-search settings (not nested under it). Only real `boolean` values are
  accepted; any non-boolean stored value falls back to `false` instead of being
  coerced through truthiness, so a corrupted field can never turn a tool on
  unexpectedly. Storage failures are swallowed so they can never break chat.
- `useConnectionTest.ts` — result of the explicit "Test Connection" action
  (`""` / `testing` / `success` / `error` + message), shared between the sidebar
  footer and the header status dot. It is never polled: the status stays empty
  until the user runs a test, and the request payload is passed in by
  `ProviderSettings` from the values currently in the form.

**Components**:

- `AppHeader.vue` — app identity, version badge (`__APP_VERSION__`, injected at
  build time from `package.json`), endpoint/model summary derived from the
  settings, and the new-conversation button.
- `ProviderSettings.vue` — the settings sidebar. Owns the settings draft, the
  debounced persistence and the cleartext-HTTP warning, and renders the
  `ConnectionSettings` / `RuntimeSettings` / `WebSearchSettings`
  / `BuiltInToolSettings` cards plus the
  sticky `ConnectionTestFooter` inside one `<form>` (the footer button submits
  it).
- `ConnectionSettings.vue`, `RuntimeSettings.vue` — presentational cards bound
  to that draft with `v-model`; they hold no state of their own.
- `WebSearchSettings.vue`, `BuiltInToolSettings.vue` — views over the
  `useWebSearchSettings` / `useToolSettings` singletons; not bound to the draft.
- `ConnectionTestFooter.vue` — sticky "Test Connection" submit button and the
  `.status.testing` / `.status.success` / `.status.error` result panels.
- `ChatMessages.vue`, `ChatInput.vue`, `ChatEmptyState.vue`,
  `DocumentAttachment.vue`.
- `AppIcon.vue` — the whole glyph set as inline SVG (stroke-based, inherits
  `currentColor`); the project deliberately has no icon dependency.

`App.vue` lays the app out as header / settings sidebar (`w-[340px]` on
 desktop, stacked on narrow screens) / scrolling chat canvas / composer dock, and
 renders `ChatEmptyState` instead of the transcript only while the transcript is
 empty and there is no error or stopped-turn banner.
 The palette is Tailwind v4 theme tokens (slate surfaces, indigo accent) plus a
 few `@utility` classes in `styles/tailwind.css` (`settings-card`, `field-input`,
 `chat-dots`, `shadow-subtle` / `shadow-floating`).

`ChatMessages.vue` renders the transient generation activity derived from the
busy flags: while the backend runs the search tool (`tool_start` → `tool_end`)
it shows a "Searching the web…" line in the loading area (replacing
"Generating…"); once the stream ends, backend-provided sources are rendered
under the correct assistant turn as plain-text titles with safe
`target="_blank" rel="noopener noreferrer"` links (titles are never rendered
with `v-html`).

**Utils**:

- `markdown.ts` — renders Markdown with `markdown-it` (HTML disabled) and
  sanitizes the output with `DOMPurify` (allowlist of tags/attributes).
- `parseApiError.ts` — maps backend/network errors to a frontend error type.

`types.ts` extends `Message` with an optional `sources?: WebSearchSource[]`
field, populated per assistant turn from the backend `sources` SSE event.

## API contract

All routes are under `/api`. Request/response bodies use JSON; chat streaming
uses SSE.

| Method + path           | Direction | Notes                          |
|-------------------------|-----------|--------------------------------|
| `GET /api/health`       | backend   | `{ status, name, version }`    |
| `POST /api/provider/test`| frontend  | `{ baseUrl, model, apiKey, timeout }` |
| `POST /api/chat`        | frontend  | non-streaming completion       |
| `POST /api/chat/stream` | frontend  | SSE stream, cancel support     |
| `POST /api/files`       | frontend  | multipart upload; returns document context inline |

**Chat message shape:**

```ts
interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
```

**Optional chat request fields** (all additive, validated in
`provider/schemas.ts`; a malformed value fails the whole request with
`VALIDATION_ERROR` and a field-level `detail`):

```ts
interface ChatRequestExtras {
  runtimeContext?: { timeZone: string; locale: string }   // IANA tag ≤ 100 / locale ≤ 40
  webSearch?: {                                          // streaming only
    enabled: boolean
    provider: 'tavily'
    apiKey?: string                                      // required when enabled; never logged
    maxResults?: number                                  // 1–10 (backend default 5)
    searchDepth?: 'basic' | 'advanced'                   // backend default 'basic'
  }
  tools?: {                                              // streaming only
    calculator?: boolean                                 // true enables 'calculator'
    fetchUrl?: boolean                                   // true enables 'fetch_url'
  }
}
```

Omitted or `false` keeps a tool unavailable to the model; the non-streaming
endpoint rejects `webSearch` and any enabled `tools` entry.

**Runtime context:** every chat request may carry an optional `runtimeContext`
(`{ timeZone, locale }`) sent by the frontend. The backend treats it as
presentation metadata only: it generates the authoritative current instant from
its own clock (never a client-provided "now") and prepends a server-authored
system message (`buildRuntimeContextMessage`) describing the UTC timestamp, the
user's local date/time, timezone, UTC offset, weekday and locale. When
`runtimeContext` is absent (older clients) a UTC-only message is sent and the
user-local fields are reported as unavailable; when the object is present but a
field is malformed or over-length (`isValidTimeZone` /
`isValidLocale`, `backend/src/provider/schemas.ts`) the whole request is rejected
with `VALIDATION_ERROR` and field-level detail instead of degrading to the
fallback. The message is injected ahead of
all conversation content (before tool guidance, document context and the
conversation), and its exact content is counted against the context budget.

**Server-authored system messages.** The runtime-context message is always the
first server-authored message. When one or more built-in tools are enabled on
the streaming request (the registry built from the request's `tools`/`webSearch`
flags is defined), the backend prepends a single capability-aware tool guidance
message (`buildToolGuidanceMessage`) describing which tools are available and
how to use them; it is built only from the tools that are actually registered,
so a tool is never advertised to the model unless it is also offered (tool
definition ⇔ guidance capability). The document policy message (see
[Context management](#context-management)) follows when a document is attached.
All of these are assembled at one central point
(`buildServerSystemMessages` / `composeSystemInstructions` in
`backend/src/utils/systemInstructions.ts`), so the exact messages sent to the
model are the same ones counted against the context budget — no server-authored
message escapes the accounting. The document *content* block is deliberately
**not** part of this system layer: it is a user-priority message carrying the
(untrusted) document text. The guidance is compact and never duplicates tool
argument definitions or per-tool caps; it only states the shared global cap
(`MAX_TOOL_EXECUTIONS_PER_TURN`), that tool calls must be sequential (parallel
calls are unsupported), and — when any web tool is enabled — that external web
content is untrusted reference material. The non-streaming endpoint sends only the
runtime-context message plus the document-policy message (when a document is attached): it
never advertises tool guidance, because it rejects tool requests.

## Chat data flow

1. The user submits a message (optionally with an attached document).
2. `chat.ts` calls `POST /api/chat/stream` and streams SSE events.
3. If a document is attached, the backend inserts a document-context block and a
   document-content block ahead of the conversation (see [Context management](#context-management)).
4. When **no tool is registered** — Web Search disabled **and** no built-in tool
   enabled — the backend forwards the messages
   (runtime context, document policy and content, conversation) to the model
   server and pipes the SSE stream straight back to the browser — live,
   progressive streaming, unchanged from v1.0.0. When **any tool is enabled** —
   `web_search`, `calculator` or `fetch_url` — the first model round is
   **accumulated** (buffered) rather than streamed live: the model may emit filler
   text before deciding whether to call a tool, and that preliminary text is
   discarded rather than shown (see
   [Documented decision: buffered tool rounds](#documented-decision-buffered-tool-rounds)).
   The client sends
   `tools: { calculator?: boolean; fetchUrl?: boolean }` (only the enabled tools,
   never an explicit `false`) on the streaming request, and the same buffering
   model applies to every tool. The tool guidance message is one of the
   server-authored system messages placed **ahead of** the conversation, and only
   when a tool is enabled, advertising exactly the tools that are registered.
   Each tool execution is orchestrated and its lifecycle is exposed as
   structured SSE events between `start` and the final answer: `tool_start`
   (tool name only, emitted only after the arguments validate and immediately
   before execution), `tool_end` (tool name only), and an optional `sources`
   event (backend-sanitized `{ id, title, url }` with safe `http(s)` URLs only
   — never `content`, never a key or base URL). The turn runs as a bounded loop
   of model rounds, each one with tools attached, executing at most
   `MAX_TOOL_EXECUTIONS_PER_TURN` (3) tools per turn and at most
   `MAX_MODEL_ROUNDS` (4) rounds. Every tool-enabled round is buffered; the
   loop stops as soon as the model returns plain text (that buffered text is
   flushed as the final answer), or it is forced into a final **no-tools**
   round once the execution cap is reached. That final round streams live; if a
   round returns a tool call after the cap, the turn fails via the stable error
   path instead of executing it. A tool may also declare its own per-turn limit
   via `executionPolicy.maxExecutionsPerTurn`; once a tool has reached that
   limit within the turn its call is not executed and no lifecycle events are
   emitted, and it is closed with a synthetic `role: "tool"` result (carrying
   the same `tool_call_id`) so the OpenAI-compatible history stays valid — the
   model is told the tool is unavailable this turn and the loop takes the final
   no-tools round. If the model never calls a tool, the buffered
   first-round text is flushed at the end as a single `start`/`delta`/`done`
   sequence.
5. On client cancel or disconnect, the backend stops upstream work silently.
6. The frontend renders streamed tokens and maps error events to user messages.

### Tool-call compatibility

Web search is model-driven: the model decides to call the generic `web_search`
tool, the backend executes it, and may do so across several sequential rounds
(up to `MAX_TOOL_EXECUTIONS_PER_TURN`), then streams the final answer. This
relies on **tool calling**, an OpenAI-compatible capability that not every
local model supports. Requirements:

- a local model that is trained/quantized with tool-call support;
- a compatible chat template and model server (Ollama, llama.cpp, LM Studio, …)
  that emits `tool_calls` in streaming `delta.tool_calls` events;
- support for the OpenAI-style fields used here (`type: "function"`,
  `function.name`, `function.arguments`, `tool_call_id`).

Tool calling is **not** guaranteed for all local models. Only when **every** capability
is off — Web Search disabled and `calculator` / `fetchUrl` both off — is no tool
registered, and the turn then streams live and progressive exactly like v1.0.0. When a
tool is **enabled** but the model does not call
a tool, the turn still completes — but the first round was accumulated (see
[Documented decision: buffered tool rounds](#documented-decision-buffered-tool-rounds)),
so the buffered text is flushed at the end rather than shown progressively; this
is not the same immediate streaming as the no-tools path. A model that requests
an unknown tool, malformed arguments, or more calls than the per-turn cap
(`MAX_TOOL_EXECUTIONS_PER_TURN`) receives a stable error and is told to retry
without tools. A tool that has already reached its own per-turn execution limit
(`executionPolicy.maxExecutionsPerTurn`) is skipped for the rest of the turn with a
synthetic result rather than executed again. See the roadmap for the bounded
multi-step loop limits.

**Source identity.** Source ids are resolved **before** the model-facing tool result is
rendered and **before** the request is budgeted, then never rewritten: the `[N]` label the
model reads is byte-identical to the `id` of that source in the `sources` event. Ids come
from one turn-local accumulator shared by every tool of the turn (`web_search` blocks and
`fetch_url` pages alike), which reserves an id atomically and keys it by normalized URL
(WHATWG serialization with the fragment dropped, query/path/trailing slash preserved), so
distinct URLs of a single call never share a label, ids stay unique across the whole
turn even when they cross a digit boundary (`[9]` → `[10]`), and a URL delivered by an
earlier tool keeps its original id instead of getting a second label. Two results of one
call whose normalized URLs are equal deliberately share a single id (that is the dedup),
so an id identifies a *source*, never a specific block. Which blocks entered the model
context is therefore decided by their known positions in the rendered payload measured
against the length of the content that was actually sent — truncation only ever keeps a
prefix, so delivered blocks are always a leading run — and never by source id. A source is
reported only when its text really entered the model context — a search block when the whole
`[N]` block survives context truncation, a fetched page when at least one character past the
harness-authored `<page-content>` prefix survives it — and blocks dropped by truncation
give their ids back to the accumulator. Each `sources` event carries the complete
cumulative list of the turn (the frontend replaces `message.sources` per event), so a tool
that contributes nothing, such as `calculator`, re-emits the existing list unchanged.

### Documented decision: buffered tool rounds

Whenever **any** tool is enabled — not `web_search` alone — every tool-enabled model round
is buffered before its text is emitted. This is a deliberate design decision (v1.1.0
buffering, extended to each round in v1.2.0): the model frequently emits short filler text
("I'll search for that…") before deciding whether to call a tool, and showing that
preliminary text — only to discard it when the tool is called — would be worse than
buffering it.

Consequences for what the user sees:

- **A tool enabled, model calls a tool, then a later tool-enabled round
  returns plain text** — that round's buffered text is flushed at the end as a
  single `start`/`delta`/`done` sequence; it is **not** shown progressively.
- **A tool enabled, model keeps calling tools until the cap** — the forced
  **no-tools** final round (the round after `MAX_TOOL_EXECUTIONS_PER_TURN`
  executions) is streamed **live, progressively, token by token**. This is the
  only tool-path answer that streams progressively.
- **A tool enabled, model does not call a tool** — the buffered first-round
  text is flushed at the end as a single `start`/`delta`/`done` sequence; it is
  not shown progressively.
- **All capabilities off** (Web Search disabled and `calculator` / `fetchUrl`
  off) — no tools are registered, so the turn streams live and
  progressive immediately, unchanged from v1.0.0.

The buffering is intentional, not a regression: it avoids leaking preliminary,
soon-discarded text. Reworking the orchestration to stream the first round live
while still suppressing filler is a planned follow-up, not a v1.1.0 change.

## Built-in tools

Tools are registered **per request**: `buildToolRegistry()` reads the request's
`webSearch` and `tools` flags and returns a registry, or `undefined` when nothing is
enabled. The registry is the single source of truth — the tool definitions sent to the
provider, the capability-aware guidance message (`resolveToolCapabilities` /
`buildToolGuidanceMessage`) and the execution rights all derive from the same object, so
a tool is never advertised unless it is also offered. Tools are only available on
`POST /api/chat/stream`; the non-streaming endpoint rejects tool requests and advertises
no guidance.

### Registry and policies

- `ToolRegistry.register()` rejects duplicate names and validates the internal
  `executionPolicy.maxExecutionsPerTurn` up front. That policy is harness-only: it is
  never serialized into the provider-facing definition and is neither model- nor
  user-controllable.
- Definitions use the OpenAI-compatible function shape (`type: "function"`,
  `function.name`, `function.arguments`) and carry their own argument descriptions, which
  is why the system guidance never repeats a schema.
- Model-supplied arguments are parsed with strict Zod schemas (`.strict()`): an
  unexpected key is rejected before execution, so a malformed call never reaches a tool
  implementation.
- `untrustedContent.ts` holds the shared "reference data, not instructions" text that
  every web-content tool result embeds, in addition to the capability-level guidance.

### Calculator (`calculator`)

`calculatorExpression.ts` is a deterministic, dependency-free engine: a hand-written
lexer plus a recursive-descent parser over numbers, `+ - * / % ^`, parentheses and unary
signs.

- There is **no code-execution path**: no `eval`, no `new Function`, no `vm`, no
  `child_process`, no dynamic `import`.
- Input is bounded before parsing (length, token count, recursion depth) — see
  [Tool execution limits](#tool-execution-limits).
- Arithmetic is IEEE-754 JavaScript `number`, **not** arbitrary precision: very large or
  very small magnitudes can be inexact. Division by zero and non-finite results are
  reported as tool errors instead of a guessed value.

### Fetch URL (`fetch_url`)

Reading a page is split into three layers so each guard is independently testable:

1. **Destination policy** (`fetchUrlPolicy.ts`) — WHATWG URL parsing, an `http:`/`https:`
   protocol allowlist, rejection of URL credentials, hostname normalization, then DNS
   resolution where **every** resolved address must be public routable space (loopback,
   private, link-local including cloud metadata addresses, unique-local, reserved and
   unspecified ranges are refused, IPv4 and IPv6 alike). Rejections carry a stable, safe
   reason: raw DNS diagnostics and the resolved addresses are never surfaced to the model
   or the API.
2. **Transport** (`fetchUrlClient.ts`) — one deadline for the whole operation, manual
   redirect following with the destination policy re-run on **every** hop, a redirect
   cap, a textual-MIME allowlist that fails closed on a missing or unknown
   `Content-Type`, and a streamed byte counter that aborts as soon as the real body
   exceeds the cap (`Content-Length` is treated as a hint, never as authority). Request
   headers are fixed and harness-controlled: no cookies, no provider keys, no
   model-supplied headers, and `redirect: "manual"` precisely so each hop can be
   validated before it is followed.
3. **Extraction** (`fetchUrlContent.ts`) — HTML/XML/JSON are deterministically reduced to
   text (markup, scripts and comments stripped, entities and CDATA handled), then bounded
   by an extracted-character cap with an explicit truncation marker.

Fetched text reaches the model inside a harness-authored untrusted boundary, and the
`[N]` source label comes from the turn accumulator, never from the page. There is **no
JavaScript execution and no browser rendering**: a page that needs a browser to become
useful is out of scope, as are binary payloads (PDFs, images, archives).

### Web search (`web_search`)

Model-driven Tavily search (see
[Tool-call compatibility](#tool-call-compatibility)). `search/types.ts` keeps the
provider contract provider-agnostic and `webSearchFormat.ts` renders each result as an
untrusted `[N]` block. It composes with `fetch_url`: search returns snippets, and the
model reads a page only when it decides the full text of a specific result is needed.

## Tool execution limits

Every bound below is a **code constant**, not an environment variable: v1.2.0 adds no
`AI_*` knob for tool behaviour, and changing a limit means changing code (constants live
in `orchestration/chatOrchestrator.ts`, `tools/calculatorExpression.ts`,
`tools/fetchUrlClient.ts`, `tools/fetchUrlContent.ts`, `search/types.ts`, and the
per-tool `executionPolicy` of each tool definition.

### Orchestration

| Limit | Value | Source |
|-------|-------|--------|
| Maximum model rounds | 4 | `MAX_MODEL_ROUNDS` |
| Maximum tool executions per turn | 3 | `MAX_TOOL_EXECUTIONS_PER_TURN` |
| `web_search` executions per turn | 1 | `executionPolicy.maxExecutionsPerTurn` |
| `fetch_url` executions per turn | 2 | `executionPolicy.maxExecutionsPerTurn` |
| `calculator` executions per turn | 3 | `executionPolicy.maxExecutionsPerTurn` |
| Parallel tool calls | Not supported | one tool call accepted per model round |

### Calculator

| Limit | Value | Source |
|-------|-------|--------|
| Maximum expression length | 500 characters | `MAX_EXPRESSION_LENGTH` |
| Maximum tokens | 256 | `MAX_TOKENS` |
| Maximum parse depth | 64 | `MAX_PARSE_DEPTH` |

### Fetch URL

| Limit | Value | Source |
|-------|-------|--------|
| Total timeout | 15 seconds | `FETCH_URL_TIMEOUT_MS` (initial request + every redirect + body read, one shared deadline) |
| Maximum redirects | 5 | `MAX_REDIRECTS` |
| Maximum downloaded response | 1 MiB | `MAX_RESPONSE_BYTES` (bytes read off the network) |
| Maximum extracted text | 200,000 characters | `MAX_EXTRACTED_CONTENT_CHARACTERS` |
| Maximum title | 300 characters | `MAX_TITLE_CHARACTERS` |

Web search bounds for comparison: the query is capped at 500 characters
(`WEB_SEARCH_MAX_QUERY`), `maxResults` is validated in 1–10 and defaults to 5, and the
Tavily call has its own 10-second timeout (`TAVILY_DEFAULT_TIMEOUT_MS`).

### Three separate caps on one fetched page

These apply in sequence and must not be confused:

| Stage | Bound | Meaning |
|-------|-------|---------|
| Download | 1 MiB | bytes the backend is willing to read from the network |
| Extraction | 200,000 characters | text kept after reducing HTML/XML/JSON to text |
| Model context | `context/toolResultBudget.ts` | what actually survives into the request, recomputed against the configured `context.maxTokens` every time a result is accumulated |

A page can therefore be downloaded in full, extracted in full, and still be shortened
(or omitted) before it reaches the model: tool results share one cumulative input budget
with the rest of the turn instead of each getting an independent allowance. When a
result cannot be included at all, the model receives the short
`TOOL_RESULT_CONTEXT_OMISSION_TEXT` notice rather than a silently empty message.

### What happens at a limit

Limits degrade through the existing error path, never as a crash: a call whose arguments
fail validation is never executed and emits no lifecycle events; a tool that already
reached its own per-turn cap is answered with a synthetic `role: "tool"` result (keeping
the OpenAI-compatible history valid) instead of running again; a tool call arriving after
the global cap forces the final no-tools round or the stable error path; and a network,
timeout, redirect or size failure surfaces as a tool-level error with a stable code.

## Configuration

Configuration is validated at startup with Zod (`config/env.ts`). Missing values
fall back to code defaults; `.env.example` documents the recommended values.

| Env var                          | Code default                 | Purpose                                   |
|----------------------------------|------------------------------|-------------------------------------------|
| `AI_HOST`                        | `127.0.0.1`                  | Bind host.                                |
| `AI_PORT`                        | `3000`                       | Bind port.                                |
| `AI_CORS_ORIGINS`                | `http://localhost:5173,http://127.0.0.1:5173` | Comma-separated allowed origins. |
| `AI_REQUEST_TIMEOUT_MS`          | `60000`                      | Upstream request timeout. |
| `AI_MAX_UPLOAD_SIZE_MB`          | `10`                         | Maximum upload size (MB).                 |
| `AI_UPLOAD_DIR`                  | `./uploads`                  | Temporary upload directory.               |
| `AI_DEFAULT_PROVIDER_TIMEOUT_MS` | `120000`                     | Default provider-test timeout (ms).       |
| `AI_TAVILY_BASE_URL`             | `https://api.tavily.com`     | Tavily web-search API base URL.           |
| `AI_TEMP_FILE_MAX_AGE_MS`        | `86400000` (24h)             | Stale temporary-file cleanup threshold.   |
| `AI_ENVIRONMENT`                 | `development`                | `development` \| `production` \| `test`   |

v1.2.0 adds **no** new environment variable: runtime context, the calculator and the
fetch-URL guards are all configured in code, and the Tavily key stays a browser-side
value (never `.env`). See [Tool execution limits](#tool-execution-limits) for the
in-code bounds.

Note: `.env.example` sets `AI_REQUEST_TIMEOUT_MS` to the same value as the
code default (`60000`), so a copied `.env` uses the code default.

## File handling

1. Validate extension (`.txt`, `.md`, `.pdf`) and size (`AI_MAX_UPLOAD_SIZE_MB`).
2. Generate a safe temporary filename (`randomUUID`) under `AI_UPLOAD_DIR`.
3. Stream the upload to disk, then extract text, normalize line endings, remove
   null characters, and reject empty content.
4. Return a document context inline (`fileId`, `originalFilename`, `size`, `type`, and `extraction.text`) for chat, then delete the temporary file within the same request.
5. Never persist uploaded files between sessions; there is no database or backend state.
6. Cleanup is anchored to the configured directory, never follows symlinks or
   directories, and never leaks paths, file contents, or raw error details.

## Context management

`context/` keeps a single attached document within the provider's context window:

- `token-estimate.ts` — estimates token count from character count.
- `context-budget.ts` — given the context size, system instructions, history,
  current message, and document, decides whether the document fits and, if not,
  truncates it. Produces `ContextTruncationMetadata` describing what was
  included vs. dropped.

When a document is attached, the backend builds two messages and inserts them
**before** the conversation (see [Chat data flow](#chat-data-flow)):

- A **document-context** message at **system** priority that states the server
  policy: the document is reference material, its instructions are not to be
  followed as system/developer instructions, and it must not be treated as a
  source of facts the model can invent beyond.
- A **document-content** message at **user** priority containing the extracted
  text enclosed in `<document>` delimiters.

This ordering enforces an instruction hierarchy: the system-authored policy sits
above the user-level document text. The backend does not execute the extracted
text, but the model may still interpret it as user-level prompt instructions;
the document is therefore treated as **untrusted reference material**, not as
trusted policy.

The budget accounts for both without double-counting: the document-context
(policy) message is part of the composed system instructions
(`composeSystemInstructions`), while `estimateDocumentTemplateOverhead` counts
**only** the document-content (user) wrapper — never the policy text — so the
policy is counted once, through the system instructions, and the wrapper once,
through the template overhead.

## Error handling

`utils/errorHandler.ts` defines `AppError` with a stable `code`, `statusCode`,
`message`, and optional `detail`. A global handler normalizes failures into a
consistent shape. The streaming boundary in `chat.ts` is the effective
application boundary once headers are sent, so streaming errors are logged once
there and emitted as SSE `error` events with the stable `code`.

## Testing

- Backend: [Vitest](https://vitest.dev) (`pnpm test` runs `vitest run`).
- Frontend: [Vitest](https://vitest.dev) + [@vue/test-utils](https://test-utils.vuejs.org)
  (`pnpm test`).
- Type checking: `tsc --noEmit` (backend), `vue-tsc -b --noEmit` (frontend).
- Linting: ESLint (`pnpm lint`).
