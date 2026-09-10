# Docker

Two production images and a Docker Compose file that connects them.

```text
local-ai-harness-backend:local    Node 22 + compiled JavaScript (node dist/server.js)
local-ai-harness-frontend:local   nginx serving the Vite production bundle
```

Step 24.1 added the two independently buildable images. Step 24.2 adds
`docker-compose.yml`, the frontend reverse proxy, and the host model-server
networking described here.

## Prerequisites

* Docker with a build daemon (BuildKit is the default in Docker 23+).
* Docker Compose v2 (`docker compose`, as a subcommand).
* Network access to the npm registry during the build: pnpm downloads the
  dependencies and Corepack downloads the pinned pnpm version.
* A model server (llama.cpp, Ollama, LM Studio or any OpenAI-compatible server)
  **installed and running on the host**. It is never packaged or downloaded by
  these images.

No global pnpm installation is required on the build machine. The package
manager version comes from `"packageManager": "pnpm@11.26.0"` in the root
`package.json` and is resolved through Corepack inside the images.

## Quick start with Docker Compose (intended integrated Docker path)

From the repository root:

```bash
docker compose up --build
```

Then open <http://127.0.0.1:8080>.

Health, through the same proxy the browser uses:

```bash
curl -i http://127.0.0.1:8080/api/health
```

```json
{"status":"ok","name":"Local AI Harness","version":"0.0.0"}
```

Stop everything:

```bash
docker compose down
```

### Architecture

```text
Browser  →  http://127.0.0.1:8080
             └─ frontend container (nginx)
                  ├─ /      static Vite bundle
                  └─ /api/  reverse proxy → backend:3000   (Compose network)
                                             └─ http://host.docker.internal:<provider-port>
                                                (model server running on the host)
```

| Service  | Image                              | Published port | Internal address  |
| -------- | ---------------------------------- | -------------- | ----------------- |
| frontend | `local-ai-harness-frontend:local`  | `8080:80`      | —                 |
| backend  | `local-ai-harness-backend:local`   | not published  | `backend:3000`    |

Both services build from the **repository root** because the Step 24.1
Dockerfiles need the pnpm workspace manifests and the frozen lockfile, which
Compose expresses with `context: .` plus an explicit `dockerfile:`. The single
root `.dockerignore` is the effective one.

`docker compose up --build` is the only command needed; no persistent volume is
required (see [Storage](#storage)).

### Why the browser never learns the `backend` hostname

The frontend is built with a **relative** API base
(`frontend/src/services/apiBase.ts`):

```ts
export function resolveApiBase(viteApiUrl?: string): string {
  return viteApiUrl ?? ""
}
```

So `http://backend:3000` is never compiled into the bundle — a browser cannot
resolve Docker service DNS names. The browser stays on its own origin and nginx
performs the internal hop. That is also why no CORS change was needed: see
[CORS](#cors).

### Backend publishing and debug access

Only the frontend is published. `http://127.0.0.1:8080/api/health` is the normal
host-facing health check, and it proves `host → nginx → Docker DNS → backend`.

To reach the backend directly while debugging, create a local
`docker-compose.override.yml` (Compose merges it automatically; do not edit
`docker-compose.yml`):

```yaml
services:
  backend:
    ports:
      - "3000:3000"
```

```bash
curl -i http://127.0.0.1:3000/api/health
```

Remember to remove the override file afterwards: publishing port 3000 is a
debug aid, not part of the standard configuration.

### Backend healthcheck

`docker-compose.yml` defines a healthcheck that reuses the Node runtime already
in the image (no `curl`/`wget` is installed) against the existing
`GET /api/health` route: `interval: 15s`, `timeout: 5s`, `retries: 5`,
`start_period: 10s`.

```bash
docker compose ps        # backend shows "healthy" once it answers
```

The frontend has **no** `depends_on`. nginx resolves `backend` at request time
(see below), so the UI keeps serving even if the backend is down, `/api` returns
`502` meanwhile, and it recovers on its own once the backend is reachable again.
The healthcheck exists for observability, not for startup ordering.

## Model server on the host

The model server is a separate process on your machine. Set the provider base
URL in the app's **Provider settings** UI according to where the backend runs:

| Backend runs…          | Provider base URL to enter          |
| ---------------------- | ----------------------------------- |
| directly on the host   | `http://localhost:<provider-port>`  |
| inside Docker (Compose) | `http://host.docker.internal:<provider-port>` |

The authoritative rule is: **use the host and port where your compatible provider
server actually listens**. Nothing here is provider-specific and no provider URL
is rewritten automatically — `localhost` typed in the UI while the backend runs
in Docker means `localhost` inside the backend container, which is not your
model server.

### Windows and macOS

Docker Desktop provides `host.docker.internal` out of the box, pointing at the
host. The Compose `extra_hosts` entry is harmless there.

### Linux

`host.docker.internal` is not provided by the engine, so `docker-compose.yml`
maps it for the backend service:

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

This requires Docker support for the `host-gateway` special value (modern Docker
Engine versions provide it). If your engine does not support it, the container
starts but that hostname will not resolve; upgrade Docker or replace the value
with the host's address on the Docker bridge network.

### The model server must be reachable from Docker

A model server bound only to loopback (`127.0.0.1`) may not be reachable from a
container, because `host.docker.internal` enters the host through a gateway
interface rather than appearing as a local client. If `host.docker.internal`
resolves but the connection is refused, make the server listen on an address
reachable from Docker (typically `0.0.0.0`). The exact switch is
provider-specific and is intentionally not prescribed here.

## API base URL and local development

`VITE_API_URL` is a Vite **build-time** value: it is inlined into the bundle, so
changing it means rebuilding, not restarting a container.

| Situation                                | API base used                                   |
| ---------------------------------------- | ----------------------------------------------- |
| `pnpm dev`, no `VITE_API_URL`            | `""` → same-origin `/api/...` → Vite dev proxy → backend |
| `pnpm dev`, explicit `VITE_API_URL`      | that value, used directly by the browser        |
| Docker Compose frontend                  | `""` → same-origin `/api/...` → nginx proxy → `backend:3000` |

Because `.env` files are excluded from the Docker build context, the image
always builds with the relative default.

`frontend/.env.example` documents the optional override:

```bash
# Optional override.
# Leave unset to use same-origin /api through the Vite/nginx proxy.
# VITE_API_URL=http://127.0.0.1:3000
```

> **If you already have `VITE_API_URL=http://127.0.0.1:3000` in a local
> `frontend/.env`**, it keeps winning over the relative default: the browser in
> `pnpm dev` calls the backend directly on port 3000 (cross-origin, allowed by
> the dev CORS defaults) instead of going through the Vite proxy. That is
> intended — an explicit override wins, and repository steps never rewrite
> user-local configuration. To use the new same-origin/proxy default during
> development, remove or comment that line yourself. Note that a local
> `pnpm build` would then bake that absolute URL into `dist/`; the Docker image
> does not, because `.dockerignore` excludes `.env*`.

Local non-Docker development is unchanged:

```bash
pnpm install
pnpm dev            # backend + frontend, or pnpm dev:backend / pnpm dev:frontend
```

## nginx proxy behaviour

`frontend/nginx.conf` is intentionally small. The relevant behaviour of the
`/api/` block:

| Concern              | Setting                                             |
| -------------------- | --------------------------------------------------- |
| Upstream             | `http://backend:3000` + `$request_uri` (original path and query preserved) |
| DNS resolution       | `resolver 127.0.0.11 valid=10s ipv6=off;` at request time |
| SSE                  | `proxy_buffering off;`, `proxy_cache off;`, `proxy_http_version 1.1;`, `proxy_set_header Connection "";` |
| Timeouts             | `proxy_read_timeout 180s;`, `proxy_send_timeout 180s;` |
| Upload ceiling       | `client_max_body_size 11m;`                          |
| Forwarding headers   | `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto`  |

Notes:

* **Runtime DNS on purpose.** A literal `proxy_pass http://backend:3000;` is
  resolved once at config load and makes nginx refuse to start
  (`host not found in upstream "backend"`) when the backend container is absent.
  Putting the upstream in a variable makes nginx resolve it per request through
  Docker's embedded DNS, which is what keeps the static UI independent of
  backend availability.
* **One block for all routes.** `/api/health`, `/api/provider/test`,
  `/api/chat`, `/api/chat/stream` and `/api/files` are all covered by the single
  `/api/` location.
* **Timeouts are bounded, not disabled.** 180s stays above
  `AI_DEFAULT_PROVIDER_TIMEOUT_MS` (120s by default) so nginx is not the first
  timeout boundary for a slow model response.
* **Response buffering only.** `proxy_buffering off` disables *response*
  buffering for SSE; *request* buffering for uploads stays at the nginx default.

## Uploads and the 11 MiB ceiling

The backend keeps the authoritative limits: `AI_MAX_UPLOAD_SIZE_MB` is 10 MB and
the multipart `fileSize` limit is 10 MB per file.

nginx adds a small transport ceiling:

```
10 MiB file  +  ~1 MiB multipart framing/headers  =  client_max_body_size 11m
```

which equals the Fastify request ceiling (`AI_MAX_UPLOAD_SIZE_MB * 1 MiB +
1 MiB`). A backend-valid 10 MB file therefore cannot be rejected by nginx just
because of multipart overhead, and the value is deliberately not set huge.

> **Caveat:** this nginx value lives inside the frontend image. If you raise
> `AI_MAX_UPLOAD_SIZE_MB` above 10, `client_max_body_size` must be reviewed and
> the frontend image rebuilt. There is no runtime templating of the nginx config
> on purpose: for the current scope that indirection is unnecessary.

Uploads stay inside the backend container (see [Storage](#storage)).

## CORS

Unchanged by Step 24.2. `AI_CORS_ORIGINS` still defaults to the Vite dev-server
origins (`http://localhost:5173`, `http://127.0.0.1:5173`) for non-Docker
development, where the browser may call the backend directly.

With Compose, the browser makes **same-origin** requests to nginx and nginx
talks to the backend server-side, so no browser CORS authorization is involved
and `localhost:8080` was deliberately **not** added to the allowlist.

## Images without Compose

Step 24.1 validation still applies: each image builds and runs on its own.

### Backend (independently runnable)

```bash
docker build -f backend/Dockerfile -t local-ai-harness-backend:local .
docker run --rm -p 3000:3000 local-ai-harness-backend:local
curl -i http://127.0.0.1:3000/api/health
```

| Stage | Base | What happens |
| --- | --- | --- |
| `build` | `node:22-slim` | `corepack enable` → copy workspace manifests → `pnpm install --frozen-lockfile --filter backend` → copy backend source → `pnpm --filter backend build` (`tsc`) |
| `runtime` | `node:22-slim` | `pnpm install --frozen-lockfile --filter backend -P` (production dependencies only) → copy `dist/` from `build` → `USER node` → `node dist/server.js` |

`tsx` is never used in the image. `AI_HOST=0.0.0.0`, `AI_ENVIRONMENT=production`
and `AI_UPLOAD_DIR=/app/uploads` are `ENV` defaults in the image, overridable
with `-e` or Compose `environment:`. `node:22-slim` (Debian, not Alpine) matches
the repository `engines` (`node >= 22`) and the `>= 22.12` requirement of Vite
without musl/glibc risk; the tag is a fixed major tag, digests are not pinned.

### Frontend (serves the static UI only)

```bash
docker build -f frontend/Dockerfile -t local-ai-harness-frontend:local .
docker run --rm -p 8080:80 local-ai-harness-frontend:local
curl -i http://127.0.0.1:8080/          # index.html
curl -I http://127.0.0.1:8080/assets/index-<hash>.js
```

| Stage | Base | What happens |
| --- | --- | --- |
| `build` | `node:22-slim` | `corepack enable` → copy workspace manifests → `pnpm install --frozen-lockfile --filter frontend` → copy frontend source → `pnpm --filter frontend build` (`vue-tsc -b && vite build`) |
| `runtime` | `nginx:1-alpine` | copy `frontend/nginx.conf` and the built `dist/` → serve on port `80` |

> An isolated frontend container **serves the UI but has no backend**: it proxies
> `/api/` to `backend:3000`, and that name only resolves inside the Compose
> network, so `/api/...` returns `502`. Full API integration requires Docker
> Compose. The container still serves pages and assets normally.

## Storage

No volume is declared. Temporary uploads stay in `AI_UPLOAD_DIR`
(`/app/uploads`) inside the backend container's writable layer and disappear with
the container, which matches the application's temporary-only file handling. The
directory is pre-created and owned by the non-root `node` runtime user; only it
is writable.

## Environment variables

Backend runtime configuration keeps the application defaults documented in
`backend/.env.example` (`AI_HOST`, `AI_PORT`, `AI_CORS_ORIGINS`,
`AI_REQUEST_TIMEOUT_MS`, `AI_MAX_UPLOAD_SIZE_MB`, `AI_UPLOAD_DIR`,
`AI_DEFAULT_PROVIDER_TIMEOUT_MS`, `AI_TEMP_FILE_MAX_AGE_MS`, `AI_ENVIRONMENT`),
plus the image `ENV` defaults above. `docker-compose.yml` deliberately does not
repeat values that already live in the image.

## Secrets

* No API keys, provider credentials, tokens or `.env` contents are copied into
  any layer, and no Docker `ARG` is used for them.
* `.env` files are excluded from the build context (`**/.env*`), and
  `frontend/.env.example` contains commented placeholders only.
* Provider credentials stay in the existing application flow: they are typed in
  the UI and live in browser `localStorage`, never in Compose or an image.
* The backend runs as a non-root user with only the upload directory writable.

## `.dockerignore`

The root `.dockerignore` excludes `**/node_modules`, `**/dist`,
`**/*.tsbuildinfo`, `**/coverage`, `**/*.test.ts`, `**/.env*`, `**/logs`,
`**/*.log`, `**/uploads`, `**/temp`, `/tmp`, `.git`, `.github`, editor/OS
artifacts, and the unused root `package-lock.json`.

It keeps every build input: the three `package.json` manifests,
`pnpm-lock.yaml`, `pnpm-workspace.yaml`, the `tsconfig` files, `backend/src`,
`frontend/src`, `frontend/index.html`, `frontend/public`,
`frontend/vite.config.ts`, both Dockerfiles and `frontend/nginx.conf`.

## Validation status

Validated in the authoring environment, **which has no Docker daemon**
(`docker`, `docker-compose`, `podman`, `nerdctl` are not installed, and nothing
was installed for this step):

* `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm typecheck`, `pnpm lint`,
  `pnpm build` on the repository.
* Frontend coverage of the new API base rule: same-origin default, explicit
  `VITE_API_URL` override, and the service request paths (`/api/provider/test`,
  `/api/files`, `/api/chat/stream`).
* `nginx.conf` and `docker-compose.yml` reviewed structurally/by inspection.
  There is no `nginx` binary and no YAML parser available here (no `nginx`,
  `yamllint`, PyYAML, or a `yaml`/`js-yaml` package in the workspace), so
  `nginx -t` and `docker compose config` were **not** executed.

**Pending external execution** — not claimed as verified:

* `docker compose build` / `up`, page load, proxied health.
* Ordinary API call, SSE streaming and multipart upload through the proxy.
* `host.docker.internal` resolution and any host model-server connectivity.
* Real model inference (requires a compatible provider on the host).

### External runtime validation

```bash
cd <repository root>

# 0. cheapest authoritative syntax checks
docker compose config -q
docker compose build

# 1. start
docker compose up -d
docker compose ps                       # backend should become healthy
docker compose exec frontend nginx -t   # nginx accepts its config

# 2. UI and proxied health
curl -i http://127.0.0.1:8080/
curl -i http://127.0.0.1:8080/api/health

# 3. ordinary API call through the proxy (expect a JSON body, not an HTML 404)
curl -is -X POST http://127.0.0.1:8080/api/provider/test \
  -H 'Content-Type: application/json' \
  -d '{"baseUrl":"http://host.docker.internal:8080/v1","model":"<model>"}'

# 4. SSE through the proxy: with -N and no buffering, deltas must appear
#    progressively rather than all at once at the end.
curl -N -sS -X POST http://127.0.0.1:8080/api/chat/stream \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Reply with exactly: ONE TWO THREE"}],"provider":{"baseUrl":"http://host.docker.internal:8080/v1","model":"<model>","timeoutMs":120000}}'
# Expected: `Content-Type: text/event-stream`, then `event: start`, several
# `event: delta` lines arriving over time, then `event: done`.
# Without a model server you should instead see the SSE stream open and an
# `event: error` (provider unreachable) arrive through the proxy: that proves the
# proxy path, but NOT incremental delivery.

# 5. upload through the proxy
printf 'hello from docker\n' > /tmp/probe.txt
curl -sS -F "file=@/tmp/probe.txt" http://127.0.0.1:8080/api/files
# Expected: success JSON with fileId/extraction.text.

# 6. near-limit upload must be accepted (10 MiB file < 11m nginx ceiling)
dd if=/dev/zero bs=1M count=10 | tr '\0' 'a' > /tmp/ten-mib.txt
curl -s -o /dev/null -w '%{http_code}\n' -F "file=@/tmp/ten-mib.txt" \
  http://127.0.0.1:8080/api/files      # expected: 200

# 7. over-limit upload must be rejected by nginx, not by the backend
dd if=/dev/zero bs=1M count=12 | tr '\0' 'a' > /tmp/twelve-mib.txt
curl -s -o /dev/null -w '%{http_code}\n' -F "file=@/tmp/twelve-mib.txt" \
  http://127.0.0.1:8080/api/files      # expected: 413 from nginx

# 8. backend container can see the host
docker compose exec backend cat /etc/hosts | grep host.docker.internal
docker compose exec backend node -e \
  "import('node:dns').then(({lookup})=>lookup('host.docker.internal',(e,a)=>console.log(e?String(e.code||e):a)))"
# Optional, when a model server is listening on the host at <port>:
docker compose exec backend node -e \
  "fetch('http://host.docker.internal:<port>/v1/models').then(r=>console.log(r.status)).catch(e=>console.log(String(e)))"

# 9. clean shutdown
docker compose down
docker compose ps
```

In the UI: open <http://127.0.0.1:8080>, set Provider settings base URL to
`http://host.docker.internal:<provider-port>`, upload a `.txt`/`.md`/`.pdf` and
send a message, watching the answer stream token by token.

## Deferred / out of scope

Deliberately not part of Step 24.2:

* A model service/container, model weights, or installing Ollama/llama.cpp.
* Persistent volumes (including for `AI_UPLOAD_DIR`).
* Kubernetes or cloud deployment, TLS/HTTPS termination.
* Runtime templating of `nginx.conf` (e.g. `envsubst`) to make
  `client_max_body_size` dynamic.
* A committed fake OpenAI-compatible provider server for SSE validation.
* Widening `AI_CORS_ORIGINS`, and a runtime API-base injector in the browser
  bundle.
* Conversation persistence of any kind.
