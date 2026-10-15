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
- Tools are **opt-in**: nothing runs unless the user enables a tool and the model
  asks for it. Enabling a tool adds an outbound network path (`web_search`,
  `fetch_url`) that the model — not only the user — influences, which is why both
  are off by default and guarded independently.
- Model output and external web content are **not** a security boundary. They are
  untrusted data rendered to the same user, on the same machine.

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
- Tool network calls carry their own hard deadlines, independent of the model:
  15 seconds for a whole `fetch_url` operation (initial request, every redirect
  and the body read share one deadline) and 10 seconds for a Tavily search call.
  See [Tool execution limits](architecture.md#tool-execution-limits).
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

The Tavily web-search provider sends its API key in the `Authorization` header,
so the backend enforces HTTPS on the search path too: both the `AI_TAVILY_BASE_URL`
config validator (`backend/src/config/env.ts`) and the provider's
`normalizeSearchBaseUrl` reject plaintext `http://` URLs and require `https://`,
closing the same CWE-319 gap for search base URLs.

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
- **Web content returned by tools**: search snippets and fetched pages are remote
  data. Each result is wrapped in a harness-authored boundary that repeats the
  "reference data, not instructions" rule (`tools/untrustedContent.ts`) on top of
  the capability-level system guidance. The two protections are complementary by
  design: the guidance sets the policy for the turn, the per-result boundary stays
  attached to the content even after earlier conversation is truncated.
- **Markdown rendering**: the frontend renders with `markdown-it` (raw HTML
  disabled) and sanitizes the result with `DOMPurify` using an explicit
  allowlist of tags and attributes. Fetched page text is never rendered as HTML;
  only source titles/URLs are, and URLs are sanitized (`http(s)` allowlist).
- **SSE data**: null characters are stripped from provider stream data.

### 8. Credentials

- API keys are accepted at request time for provider tests and are never logged
  or persisted by the backend.
- `VITE_API_URL` is a **build-time** value inlined into the bundle; it is never a
  runtime-injected remote endpoint.

### 9. Web search security

Web search is **disabled by default** and only runs when the user enables it and the
model invokes `web_search`.

- **API key ownership and scope.** The Tavily API key is entered by the user in the
  frontend **Web Search settings**, stored only in the browser, and sent to the backend
  **only while web search is enabled**. It is request-scoped: the backend never logs or
  persists it, and it is never echoed back through SSE events, assistant messages, error
  details, or source metadata.
- **Backend-owned, configurable Base URL.** The Tavily endpoint comes from the
  backend configuration `AI_TAVILY_BASE_URL` (default `https://api.tavily.com`), not
  from the frontend UI (there is no field for it) and not hardcoded in the provider. The
  provider receives it by dependency/config injection. Both the config validator and the
  provider require `https://`, closing the CWE-319 gap for the search path.
- **External content is untrusted.** Web-search results are treated as untrusted
  external data, never as system/developer instructions, and the backend follows no
  instruction found in them. **Web search does not fetch result pages**: only the
  normalized sources (`id`, `title`, `url`) returned by the search API are surfaced.
  Reading a page is a separate, separately opt-in capability (`fetch_url`) with its own
  guards — see [§13](#13-fetch-url-and-ssrf).
- **Query leaves the local environment.** Model inference can remain local, but when Web
  Search is enabled and the model invokes `web_search`, the search query is sent to the
  configured Tavily endpoint. This is why web search should not be described as fully
  local.
- **Prompt-injection and external links.** Because results are untrusted, they carry a
  prompt-injection risk and contain external links. Sources are rendered as links the user
  can open, and result content is sanitized.
- **Source attribution comes from harness metadata.** The `[N]` label the model sees in a
  tool result and the `id` of the matching entry in the `sources` event are both assigned
  by the backend (a turn-local counter, reserved atomically per normalized URL), never
  taken from model- or page-supplied text. A remote page cannot rename itself, claim
  another page's id, or make itself look delivered: whether a source actually reached the
  model is decided from byte offsets the harness wrote around the remote content (and from
  complete block boundaries), never by searching the remote text for a URL, a title or a
  wrapper marker.

### 10. Server-authored system messages

All privileged `system` messages are authored by the backend and assembled at a
single point (`buildServerSystemMessages` / `composeSystemInstructions` in
`backend/src/utils/systemInstructions.ts`), so the messages sent to the model are
exactly the messages counted against the context budget — no server-authored
message escapes the accounting:

- **Runtime context** is always the first system message and is generated from
  the backend clock (never a client-provided "now"), so the model cannot forge
  the current instant.
- **Tool guidance** is a single capability-aware message built only from the
  tools that are actually registered on the request. A tool is advertised to the
  model **only** when it is also registered and offered (tool definition ⇔
  guidance capability), so the model is never told a tool exists when a call to
  it would be rejected. It is sent only on the streaming endpoint; the
  non-streaming endpoint rejects tool requests and advertises none. Guidance
  states only the shared global execution cap and that calls must be sequential;
  it never duplicates tool argument definitions or per-tool limits.
- **Document policy** (see [Context management](architecture.md#context-management))
  is sent only when a document is attached, and the document *content* is sent
  separately at user priority as untrusted reference material, never at system
  priority.

These messages may contain request-supplied metadata, including document
filenames and validated timezone and locale values. They never contain uploaded
document text, API keys, or raw error details, and they are never logged.

### 11. Runtime context

- The browser sends exactly two values: an **IANA timezone** and a **locale**. There is
  no use of the Geolocation API, no IP-based location, no coordinates and no device
  fingerprinting, and nothing is added to logs or persisted to satisfy this feature.
- Both values are validated server-side before use (`provider/schemas.ts`): trimmed,
  non-empty, length-capped (100 and 40 characters) and rejected unless `Intl` can build
  a formatter / canonicalize the tag. A malformed or oversized value never reaches a
  prompt.
- The **timestamp comes from the backend clock**. A client cannot forge the current
  instant, shift the model's date reasoning, or make the server claim a different time.
- Because only a timezone and a locale cross the boundary, the exposed information is a
  coarse, user-visible system setting — not a location and not an identity.
- When the payload is absent (older clients, or a browser that refuses to report), a
  UTC-only message is sent; nothing about the request fails.

### 12. Calculator

- Expressions are parsed by an explicit lexer and recursive-descent parser. There is
  **no code-execution path**: no `eval`, no `new Function`, no `vm`, no `child_process`,
  no dynamic `import` anywhere in the evaluator.
- Arguments are validated by a strict schema: exactly one `expression` key, bounded
  length, no extra keys, so a model-supplied payload cannot smuggle another instruction.
- Token-count and recursion-depth caps stop a hostile expression from exhausting memory
  or the call stack; failures are typed tool errors, not crashes.
- The evaluator performs **no I/O**: no filesystem, network or environment access.
- Arithmetic is IEEE-754 `number`, **not** arbitrary precision. Very large, very small
  or non-integer results can be inexact; this is not a financial or compliance-grade
  engine.
- Residual: the calculator computes what the model asked for. A correct evaluation of a
  wrong expression is still wrong, so treat tool output as data, not as authority.

### 13. Fetch URL and SSRF

`fetch_url` performs outbound HTTP **from the machine running the app**, which is usually
inside a private or home network. Unguarded, that is a server-side request forgery (SSRF)
primitive influenced by a model. Implemented controls:

| Control | Behaviour |
|---------|-----------|
| Protocol allowlist | Only `http:` and `https:`; anything else (`file:`, `gopher:`, `data:`, …) is rejected before resolution. |
| URL credentials | Rejected. `user:pass@host` never reaches the request. |
| Public-network-only destination checks | Every resolved address must be public routable space. |
| Blocked address ranges | IPv4 refuses `0.0.0.0/8`, `10/8`, `100.64/10` (carrier-grade NAT), `127/8` (loopback), `169.254/16` (link-local, including cloud metadata `169.254.169.254`), `172.16/12`, `192.0.0.0/24`, `192.168/16`, the documentation TEST-NETs, `198.18/15`, `224/4` (multicast) and `240/4` (reserved/broadcast). For IPv6 only global unicast `2000::/3` counts as public, so `::`, `::1`, `fc00::/7` (unique-local), `fe80::/10` (link-local), `ff00::/8` (multicast) and `2001:db8::/32` are refused, and IPv4-mapped/compatible literals are validated against the IPv4 rules instead of bypassing them. Literal-IP URLs are classified without DNS. |
| DNS result checks | Names are resolved first and **all** answers are classified; a single non-public answer rejects the whole destination, and DNS failure is a safe error that never leaks resolver diagnostics. |
| Redirect revalidation | Redirects are followed manually (`redirect: "manual"`); each `Location` hop is re-parsed and re-validated by the same policy before the next request, so a public URL cannot be used as a jump to a private target. A sixth redirect is rejected. |
| Time and size caps | 15-second deadline for the whole operation; body streaming aborts past 1 MiB (`Content-Length` is a hint, never authority). |
| Textual MIME allowlist | `text/*`, `application/json`, `application/xml`, `application/xhtml+xml` and `+json`/`+xml` variants. Missing or unknown `Content-Type` fails closed; binaries (PDF, images, archives) are rejected unread. |
| Fixed request headers | No cookies are stored or sent, no provider or API keys are attached, and the model controls only the URL — never a header. |
| No JavaScript | Pages are reduced to text; nothing is executed and no browser context exists. |
| Untrusted labelling | Fetched text is delivered inside an explicit untrusted boundary and marked as reference data. |

**Residual limitations — read before enabling `fetch_url` on a shared or sensitive
network:**

- **DNS rebinding / TOCTOU.** The policy resolves and classifies addresses *before*
  connecting, but it does **not** pin the subsequent connection to the validated
  addresses. A record that flips between validation and connection (short TTL) can route
  the request somewhere that was never approved. Redirect revalidation solves a different
  problem (a public URL pointing at a private one) and does **not** eliminate DNS
  rebinding. Closing it needs connection pinning at the transport layer.
- **Public hosts that reach internal services.** A genuinely public hostname (a proxy,
  a web preview service, an image optimizer) can fetch internal URLs on behalf of the
  caller. Address classification cannot distinguish it from an ordinary site.
- **Cleartext.** `http://` is allowed for public hosts, so such a request and its
  response can be observed or modified on path. No cookies or credentials are attached,
  and no fetched content is trusted because of the transport.
- **Information disclosure by design.** The destination learns a request came from the
  user's network, plus the requested URL and the harness user-agent; the retrieved text
  is then handed to the model, which may quote it. Do not point `fetch_url` at URLs you
  would not want revealed or fed into a model.
- **Incomplete pages.** JavaScript-rendered content, logins and paywalls are absent, so
  a page can look empty or different from what a browser shows.

These controls **reduce** SSRF risk; they do not eliminate it, and they are not a
substitute for network egress controls. Local AI Harness remains a single-user local tool:
running it as a hostile multi-user or internet-facing service would require further
hardening (pinning, egress allowlists, per-user policy, sandboxed egress).

### 14. Prompt injection from external content

- Search snippets, fetched pages and uploaded documents may all contain adversarial
  instructions aimed at the model.
- The mitigations are layered: server-authored system policy, capability-aware guidance
  that states external content is untrusted, per-result untrusted boundaries, untrusted
  material kept at **user** priority while policy stays at **system** priority, and source
  attribution taken from harness metadata rather than from remote text (so a page cannot
  rename itself or claim another source's id).
- These measures **reduce** the chance that the model obeys embedded instructions. They do
  not eliminate it: prompt injection in LLMs is not mathematically closable, and a model
  can still be steered by content it reads.
- The **blast radius is bounded by what the user already enabled**. External content can
  influence the answer and the choice of already-enabled tools, but it cannot register a
  tool, raise a per-turn cap, obtain a key, change the fetch-URL address policy, or reach
  the filesystem — those are enforced in code, not by the prompt. Nothing in page text, a
  search snippet or an uploaded document is consulted when the code decides what is a
  permitted destination: the protocol/credential rules, DNS address classification and
  redirect revalidation in [§13](#13-fetch-url-and-ssrf) run from harness state only, so
  remote content cannot widen them. That is a **risk reduction**, not a guarantee against
  SSRF: the residual gaps in §13 (notably DNS rebinding, and public hosts that front
  internal services) stay open regardless of the prompt.
- Practical guidance: enable tools only for the turns that need them, treat suggested
  links as unverified, and avoid combining untrusted documents with tool-enabled turns.

## Out of scope (by design)

These are intentionally **not** implemented and are documented as such:

- Authentication and multi-user isolation.
- Conversation or file persistence.
- TLS/HTTPS termination for exposed deployments (the app is local/single-user).
- OCR for PDFs (text extraction only).
- Runtime templating of `nginx.conf` (e.g. `envsubst`).
- Connection pinning for `fetch_url` (the DNS-rebinding caveat in [§13](#13-fetch-url-and-ssrf)
is documented rather than closed).
- Sandboxed or allowlisted network egress for tool traffic.

## Notes for contributors

- Keep uploads and path handling anchored to the configured directory.
- Never log API keys, uploaded contents, or raw error details.
- Validate untrusted input (extensions, sizes, provider responses) at the
  boundary.
- When adding network exposure, preserve the CWE-319 guard in `apiBase.ts`.
