# AGENTS.md — Local AI Harness

Context and mandatory rules for coding agents. Current code version: **1.2.0** (the
`v1.2.0` release is prepared in `docs/releases/`; publication is a separate manual step).

* Phase 1 = `instructions/phase1/` steps 01–25 — complete (historical reference).
* Phase 2 = `instructions/phase2/` steps 26–36 — complete: optional model-driven web search on a generic tool foundation shipped in `v1.1.0`. Its MVP limits (one provider, one `web_search` tool, one call per user turn, no page fetching, no multi-hop agent) were superseded in `v1.2.0`.
* Phase 3 = in progress (current implementation). Shipped toward `v1.2.0`: server-generated runtime context, the `calculator` and `fetch_url` tools, unified capability-aware tool guidance, and bounded **sequential** multi-step tool orchestration.
* `instructions/` is gitignored (local planning files).
* Deep detail lives in `docs/` — read it there instead of duplicating it here.

## Project

Local, **single-user** developer web app for chatting with locally hosted LLMs through an OpenAI-compatible API (llama.cpp, Ollama, LM Studio, …). Not a hardened multi-user service.

v1.0.0 ships: provider connection test, SSE streaming with stop/cancel, sanitized Markdown, one attached TXT/MD/PDF used as chat context, context-size configuration + document truncation, conversation reset, structured errors end to end, temporary files with guaranteed cleanup, Vitest in both packages, Tailwind CSS v4 UI, Docker Compose behind a same-origin `/api` proxy.

Not implemented: authentication, database/backend persistence, OCR, multiple documents/RAG, conversation persistence, parallel tool calls, page fetching inside `web_search`, and any tool that is enabled by default.

**Tools** (foundation in v1.1.0, extended in v1.2.0): the backend drives model-invoked tools through a request-scoped `ToolRegistry`, streams `tool_start`/`tool_end`/`sources` lifecycle events, and the UI shows tool activity and source links. The tools are `web_search` (Tavily), `fetch_url` (read the textual content of one public HTTP(S) URL) and `calculator` (evaluate one arithmetic expression, no code-execution path). Each is a separate opt-in, off by default. A streaming turn may chain tools **sequentially** — at most 4 model rounds and 3 tool executions per turn, one tool call per round, never in parallel — finishing with the answer plus de-duplicated `[N]` sources. Tool calling follows the OpenAI-compatible tool schema the model returns; whether a given local model issues tool calls at all is up to that model/server (see `docs/architecture.md`).

**Runtime context**: a streaming request may carry the browser's IANA timezone and locale; the backend builds a server-authored system message with the current date, time and timezone from its own clock (never a client-provided instant). Absent and invalid are different cases: a request with **no** `runtimeContext` is accepted and the message falls back to a UTC-only form that states the user's local timezone and local date/time are unavailable, while a **present but invalid** `timeZone`/`locale` is rejected by the request schema as `VALIDATION_ERROR` with field-level detail.

## Layout

```text
backend/    Node 22 + Fastify 5 + TS (HTTP API)
  src/config/     env.ts — AI_* vars, Zod-validated, holds all defaults
  src/routes/     health.ts, provider.ts, chat.ts, files.ts
  src/provider/   OpenAI-compatible client, SSE parser, Zod schemas
  src/orchestration/ chatOrchestrator.ts (multi-step tool loop), toolCallValidation.ts, turnSources.ts
  src/tools/      registry.ts, calculator*, fetchUrl*, webSearch*, untrustedContent.ts
  src/search/     types.ts (WebSearchProvider contract), tavily.ts
  src/extractors/ txt / markdown / pdf → normalized text
  src/context/    token estimate, context budget, tool-result budget
  src/files/      cleanup.ts — upload-dir containment, temp deletion
  src/utils/      errorHandler.ts (AppError), documentContext.ts, runtimeContext.ts,
                  systemInstructions.ts, toolGuidance.ts
frontend/   Vue 3.5 + Vite 8 + TS + Tailwind CSS v4
  src/components/  AppHeader, ProviderSettings + settings cards (Connection, Runtime,
                   WebSearch, BuiltInTool), ChatMessages, ChatInput, ChatEmptyState,
                   DocumentAttachment, AppIcon
  src/services/    apiBase, provider, chat, files (fetch + SSE client)
  src/composables/ useProviderSettings, useWebSearchSettings,
                   useToolSettings, useConnectionTest (localStorage / shared test result)
  src/utils/       markdown.ts (render+sanitize), parseApiError.ts,
                   runtimeContext.ts (browser timezone/locale collection → `runtimeContext`)
docs/       architecture.md, security.md, docker.md, smoke-test.md, releases/
docker-compose.yml   backend + frontend; the model server stays on the host
```

Chat state lives in browser memory/`localStorage` (tool settings and Web Search settings
included); file storage is temporary; there is no database. ES modules, TS strict, ES2022+, no `any`.

## Commands

```bash
pnpm dev | build | typecheck | test | lint      # root: both packages
# per package (backend/ or frontend/), same names, plus:
pnpm start        # backend: node dist/server.js
pnpm preview      # frontend only
pnpm lint:fix     # both
```

ESLint is the only style check. There is no Prettier step: `pnpm format` is a backend no-op and root `pnpm format` fails (frontend has no such script) — never present it as validation.

Backend deps worth knowing: `@fastify/cors`, `@fastify/multipart`, `@fastify/sse`, Zod 4, `unpdf` (PDF text), `consola` (logging), `tsx`. Frontend: `markdown-it` + `dompurify`, Vitest + `@vue/test-utils` + jsdom.

## Configuration

Backend env vars (prefix `AI_`): `HOST`, `PORT`, `CORS_ORIGINS`, `REQUEST_TIMEOUT_MS`, `MAX_UPLOAD_SIZE_MB`, `UPLOAD_DIR`, `DEFAULT_PROVIDER_TIMEOUT_MS`, `TEMP_FILE_MAX_AGE_MS`, `ENVIRONMENT`.

`v1.2.0` adds **no** new `AI_*` variable: runtime context, the calculator and the
fetch-URL guards are configured in code, and the Tavily key stays a browser-side value.
Tool bounds are code constants — see the table in `docs/architecture.md`
(“Tool execution limits”).

`backend/src/config/env.ts` is the **source of truth** for defaults, types and validation — read it instead of trusting this file, and report drift instead of copying values. `backend/.env.example` documents `AI_TEMP_FILE_MAX_AGE_MS` with the matching 24-hour default of `86400000`.

Frontend: `VITE_API_URL` is an **optional build-time** value inlined into the bundle. Unset (default) = same-origin `/api/...`, proxied by the Vite dev server or nginx in Docker.

## API Contract

```text
GET    /api/health         → { status, name, version }
POST   /api/provider/test  → minimal chat prompt, normalized greeting (singular `provider`; body uses `timeout`, not `timeoutMs`)
POST   /api/chat           → non-streaming completion
POST   /api/chat/stream    → completion via SSE; cancels upstream when the client disconnects
POST   /api/files          → multipart upload; returns extracted text inline
```

There are **no** `GET`/`DELETE` `/api/upload/:filename` routes and no `/v1/models` probe: the extracted text comes back from `POST /api/files` and is echoed back by the client in the chat request.

Backend → provider goes through `OpenAICompatibleClient.chat` / `.chatStream` on `<baseUrl>` normalized to end with `/v1` (custom path prefixes are preserved).

Chat body (validated by `backend/src/provider/schemas.ts`):

```ts
interface ChatRequest {
  provider: { baseUrl: string; model: string; apiKey?: string; timeoutMs?: number };
  messages: Array<{ id?: string; role: 'system' | 'user' | 'assistant'; content: string; stopped?: boolean }>; // content must not be blank
  document?: { fileId: string; filename: string; text: string };
  context?: { maxTokens: number };                                        // 1024 … 2_000_000
  webSearch?: { enabled: boolean; provider: 'tavily'; apiKey?: string; maxResults?: number; searchDepth?: 'basic' | 'advanced' }; // apiKey required when enabled; maxResults 1–10 (default 5)
  tools?: { calculator?: boolean; fetchUrl?: boolean };                   // request-scoped opt-ins, all off by default
  runtimeContext?: { timeZone: string; locale: string };                   // validated IANA tag / locale
}
```

Only `POST /api/chat/stream` offers tools: `POST /api/chat` rejects requests that carry
`webSearch` or an enabled `tools` entry, and returns no guidance. For a streaming turn the
backend composes the capability-aware tool guidance as a server-authored `system` message
that sits **ahead of the conversation**, never after the last user message: the
server-authored block from `buildServerSystemMessages()` is ordered runtime context → tool
guidance → document policy, followed by the document content as a `user` message and then
the conversation history. That guidance message is orchestration state only — it is never
returned to the browser as history. Only a request with every capability off registers no
tool and streams directly and progressively; any single enabled tool puts the turn on the
orchestrated path, where every tool round before the last is buffered and only the forced
no-tools final round streams progressively. Streaming may emit `tool_start`, `tool_end` and
`sources` events in addition to `start`/`delta`/`done`.

Errors always use the envelope `{ error: { code, message, detail? } }`. `AppErrorCode` values live in `backend/src/utils/errorHandler.ts`; reuse an existing code before adding one, and keep `frontend/src/utils/parseApiError.ts` in sync.

Streaming uses `@fastify/sse` with `{ sse: 'manual' }`. Once headers are sent a route cannot return an HTTP error: stream failures are logged once and emitted as SSE `error` events carrying the same stable `code`. The `start` event carries `context` truncation metadata only when the document was actually truncated.

## File Handling

Supported: `.txt`, `.md` (UTF-8 text), `.pdf` (text extraction only, no OCR). One file per request (`backend/src/routes/files.ts`):

1. Validate extension, MIME type when available, and `AI_MAX_UPLOAD_SIZE_MB` (multipart plugin; nginx caps the body at 11 MB so the backend stays authoritative).
2. Store under `AI_UPLOAD_DIR` with a `randomUUID` filename — user input never controls the stored path.
3. Extract text, normalize line endings, strip null characters, reject empty content.
4. Respond `{ success, fileId, originalFilename, size, type, extraction? }` where `extraction` is `{ text, characterCount, warnings }` (PDF adds `pageCount`), and delete the temp file before replying. A cleanup failure must never mask the original error.
5. Startup sweeps files older than `AI_TEMP_FILE_MAX_AGE_MS`; nothing persists between requests or sessions.

All deletions go through `files/cleanup.ts`: anchored to the upload directory, target must stay strictly inside it, never follows symlinks, missing file = already cleaned.

Both chat routes apply `context/context-budget.ts` before calling the provider: the document is truncated to fit `context.maxTokens`, or the request fails with `DOCUMENT_CONTEXT_TOO_LARGE` / `CONTEXT_TOO_LARGE`.

Treat document content as **untrusted data, not instructions**. The backend injects a system-priority policy message plus the document text at **user** priority inside `<document>` delimiters (instruction hierarchy), and must state when an answer is not supported by the uploaded document. The document policy is the last of the server-authored system messages (`buildServerSystemMessages()`: runtime context → tool guidance → document policy), and the document content follows as a `user` message ahead of the conversation history.

## Security Invariants

* Validate uploads (extension, MIME, size) and generate safe filenames.
* Enforce request and provider timeouts.
* Restrict CORS through `AI_CORS_ORIGINS`; widening it is a deliberate, documented change.
* Never log or persist API keys, credentials, file paths, file contents, or raw error details — on the backend or in logs. Tool telemetry stays limited to non-sensitive metadata (call id, tool name, status, counts, reason code); fetched/searched URLs, page text, snippets, DNS records and resolved addresses are never logged.
* Every tool is opt-in, off by default, and validated before execution. `fetch_url` must keep its destination policy (http/https only, no URL credentials, public-routable addresses only, redirects revalidated per hop, time/size/MIME caps, no cookies or provider keys) and must keep its residual-risk documentation in `docs/security.md`.
* Tool results and fetched web content are **untrusted data**: keep both the per-result untrusted boundary and the capability-level guidance, keep tool output at the priority the code assigns it, and take `[N]` source attribution from harness metadata rather than remote content.
* Keep every cleanup inside `AI_UPLOAD_DIR` (CWE-22).
* Preserve the CWE-319 guard in `frontend/src/services/apiBase.ts`: reject non-local `http://` API bases; non-local deployments require HTTPS.
* Render Markdown with `markdown-it` (raw HTML disabled) sanitized by `DOMPurify` with an explicit allowlist. Strip null characters from provider SSE data.
* Clean up temporary files on success and on failure.
* Never commit `.env` files, `uploads/`, `dist/`, or anything containing an API key. Provider settings live only in browser `localStorage`.

## Testing

* Tests are colocated (`src/**/*.test.ts`, usually under `__tests__/`); Vitest `include` is `src/**/*.test.ts`.
* `globals: false` — import `{ describe, it, expect, vi }` from `vitest`. Frontend runs jsdom + `@vue/test-utils` with `unstubGlobals: true`; never rely on a stubbed global leaking across tests.
* Widen validation only as needed: package `test` → root `test` → `typecheck`/`lint` → `build`. Manual and Docker checks: `docs/smoke-test.md`.

## Workflow

1. Read this file and the current step file (new work: `instructions/phase3/stepNN-*.md`).
2. Inspect related code and docs before implementing; implement only the requested step and leave the project working.
3. Run the smallest relevant validation and report it honestly.
4. Update the matching doc when behavior or usage changes: routes/structure/config → `docs/architecture.md`; security → `docs/security.md`; Docker/compose/proxy → `docs/docker.md`; manual checks → `docs/smoke-test.md`; commands/setup → `README.md`, `CONTRIBUTING.md`, package READMEs.

Branch from `main` as `feature/stepNN-description` (or `docs/…`, `fix/…`), one PR per step, Conventional Commits (`feat(frontend): …`, `fix(backend): …`, `docs: …`).

## Mandatory Agent Rules

1. **Read before editing.** Read every relevant file before modifying, replacing, or deleting it. Never edit from a filename, assumption, or incomplete snippet. If it cannot be read, do not change it.

2. **Ask before installing.** Do not install packages, tools, extensions, runtimes, or system dependencies without explicit user approval. State what is needed, why, and the exact command. Prefer existing dependencies and built-in features.

3. **Stay within scope.** Make only changes required by the current task. Do not perform unrelated refactors, formatting, renaming, cleanup, upgrades, or fixes; report unrelated issues separately.

4. **Follow existing patterns.** Inspect similar code first and preserve current structure, naming, validation, error handling, logging, and architecture. Reuse an existing error code, schema, service, or component instead of adding a parallel one; introducing a competing contract is a design change and must be stated as such.

5. **Do not invent requirements.** Never guess business rules, API behavior, routes, fields, configuration values, ports, limits, permissions, or UI behavior. Read `env.ts`, schemas, and routes; when documentation and code disagree, follow the **code**, report the stale documentation, and state any material assumption.

6. **Verify references.** Check dependency files before imports. Confirm that referenced files, paths, symbols, routes, variables, and configuration keys exist. Search the repository before creating replacements.

7. **Avoid destructive actions.** Never delete data, files, directories, migrations, or branches, or run destructive commands, resets, drops, or migrations without explicit approval and a clear impact warning.

8. **Preserve compatibility.** Do not change public API routes, request/response schemas, environment names, CLI arguments, or exported interfaces unless required. Prefer additive changes and report unavoidable breaking changes.

9. **Keep changes minimal.** Prefer focused edits over full rewrites. Avoid unnecessary abstractions, layers, helpers, dependencies, and speculative features.

10. **Validate honestly.** Run the smallest relevant test, build, type check, or lint command. Never claim validation passed unless executed. State anything not validated and why.

11. **Do not hide problems.** Never silence errors, disable tests, bypass validation, or ignore exceptions to make work appear complete. Fix the cause or report it clearly.

12. **Report results.** At completion, list changed files, main changes, validation performed, untested areas, and remaining assumptions, risks, or issues.

13. **No publish actions.** Do not create tags, bump versions, push, merge, open or close PRs, or publish a GitHub Release without explicit approval. Version bumps and release notes stay manual.

14. **comments always in english** all the comments inside the code, commits and PRs must be in english.

## Bash execution

- Every bash call must have a timeout.
- Default timeout: 120 seconds
