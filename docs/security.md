# Security — Local AI Harness

Security posture of **Local AI Harness**, a local, single-user developer tool.

> This documents the controls implemented in the current code. It does not
> claim coverage for anything not implemented here.

## Threat model and assumptions

- The app runs **locally** and is used by a **single user** against a model
  server on the same host.
- The model server is **not** managed by this app and lives outside Docker.
- Uploaded documents are treated as **untrusted data**, never as instructions.
- The browser↔backend channel is local; the app guards against the one remote
  exposure path it could introduce (a non-local API base over cleartext).

## Controls

### 1. Upload validation and safe filenames

- Only `.txt`, `.md`, and `.pdf` extensions are accepted.
- Enforced size limit: `AI_MAX_UPLOAD_SIZE_MB` (default 10 MB), applied both in
  the multipart plugin and by the nginx `client_max_body_size` ceiling
  (11 MB, above the backend limit so the backend remains authoritative).
- Files are stored under `AI_UPLOAD_DIR` using a `randomUUID`-generated filename,
  so user input never controls the stored path.

### 2. Path safety in cleanup

`files/cleanup.ts` anchors every operation to the configured upload directory and
verifies (via resolved absolute paths + `path.relative()`) that a deletion
target stays **strictly inside** the root. It never follows symlinks or
directories, treats missing files as already cleaned, and never leaks paths,
file contents, or raw error details (mitigates CWE-22, path traversal).

### 3. Timeouts

- `AI_REQUEST_TIMEOUT_MS` bounds upstream requests.
- `AI_DEFAULT_PROVIDER_TIMEOUT_MS` bounds provider tests.
- The provider client distinguishes user/abort timeouts from provider errors.

### 4. CORS

`AI_CORS_ORIGINS` explicitly enumerates allowed origins (comma-separated). The
default allows only local development origins. Widening it is called out in
[docs/docker.md](docker.md) as an out-of-scope change.

### 5. No cleartext to remote servers (CWE-319)

`services/apiBase.ts` rejects a non-local `http://` API base before it is used,
so sensitive payloads such as `payload.apiKey` are never sent over cleartext to
a remote server. The empty (same-origin) and `https://` bases are allowed;
localhost development is explicitly permitted over HTTP because that traffic
never leaves the machine.

> **Non-local deployments require HTTPS.** An empty `VITE_API_URL` inherits the
> page origin instead of a fixed base, so an HTTP page on a non-local
> deployment can still send sensitive payloads over cleartext. This guard does
> not cover that same-origin case; serve non-local deployments over HTTPS to
> avoid cleartext transmission (CWE-319).

### 6. Temporary file lifecycle

- Files are created, processed, and deleted within a single request.
- Stale files are swept at startup by `AI_TEMP_FILE_MAX_AGE_MS` (default 24h).
- Nothing is persisted between sessions; there is no database or backend state.
- Cleanup failures are logged once, safely, and never block startup.

### 7. Untrusted content handling

- **Documents**: text extraction normalizes line endings, removes null
  characters, and rejects empty content. Extracted text is untrusted reference
  material, not executable code. The backend does not execute it, but the model
  may interpret it as user-level prompt instructions; this is mitigated by
  sending it at user priority inside `<document>` delimiters beneath a
  system-level policy (see [Context management](architecture.md#context-management)).
- **Markdown rendering**: the frontend renders with `markdown-it` (raw HTML
  disabled) and sanitizes the result with `DOMPurify` using an explicit
  allowlist of tags and attributes.
- **SSE data**: null characters are stripped from provider stream data.

### 8. Credentials

- API keys are accepted at request time for provider tests and are never logged
  or persisted by the backend.
- `VITE_API_URL` is a **build-time** value inlined into the bundle; it is never a
  runtime-injected remote endpoint.

## Out of scope (by design)

These are intentionally **not** implemented and are documented as such:

- Authentication and multi-user isolation.
- Conversation or file persistence.
- TLS/HTTPS termination for exposed deployments (the app is local/single-user).
- OCR for PDFs (text extraction only).
- Runtime templating of `nginx.conf` (e.g. `envsubst`).

## Notes for contributors

- Keep uploads and path handling anchored to the configured directory.
- Never log API keys, uploaded contents, or raw error details.
- Validate untrusted input (extensions, sizes, provider responses) at the
  boundary.
- When adding network exposure, preserve the CWE-319 guard in `apiBase.ts`.
