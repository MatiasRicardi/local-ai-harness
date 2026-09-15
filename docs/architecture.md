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
│   │   ├── extractors/          # txt, markdown, pdf, text-utils
│   │   ├── files/cleanup.ts     # temporary-file lifecycle + path safety
│   │   ├── context/             # context-budget + token-estimate
│   │   └── utils/               # errorHandler, documentContext
│   ├── Dockerfile
│   └── .env.example
├── frontend/
│   ├── src/
│   │   ├── components/          # ChatInput, ChatMessages, ProviderSettings, DocumentAttachment
│   │   ├── composables/         # useProviderSettings
│   │   ├── services/            # apiBase, chat, files, provider
│   │   ├── utils/               # markdown (markdown-it + DOMPurify), parseApiError
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
  (`/api/chat`), plus stop/cancel.
- `files.ts` — document upload; the extracted text is returned inline (no separate download/delete endpoint).
- `provider.ts` — provider connection test.

**Composables**:

- `useProviderSettings.ts` — persists provider settings to `localStorage`.

**Components**:

- `ProviderSettings.vue`, `ChatMessages.vue`, `ChatInput.vue`,
  `DocumentAttachment.vue`.

**Utils**:

- `markdown.ts` — renders Markdown with `markdown-it` (HTML disabled) and
  sanitizes the output with `DOMPurify` (allowlist of tags/attributes).
- `parseApiError.ts` — maps backend/network errors to a frontend error type.

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

## Chat data flow

1. The user submits a message (optionally with an attached document).
2. `chat.ts` calls `POST /api/chat/stream` and streams SSE events.
3. If a document is attached, the backend inserts a document-context block and a
   document-content block ahead of the conversation (see [Context management](#context-management)).
4. The backend forwards the messages to the model server and pipes the SSE
   stream back to the browser.
5. On client cancel or disconnect, the backend stops upstream work silently.
6. The frontend renders streamed tokens and maps error events to user messages.

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
| `AI_TEMP_FILE_MAX_AGE_MS`        | `86400000` (24h)             | Stale temporary-file cleanup threshold.   |
| `AI_ENVIRONMENT`                 | `development`                | `development` \| `production` \| `test`   |

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
