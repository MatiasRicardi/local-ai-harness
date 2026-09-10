# Docker images (Step 24.1)

Step 24.1 adds two **independently** buildable and runnable production images.

Explicitly **not** part of this step: Docker Compose, container networking, a
frontend reverse proxy, model-server access, image healthchecks and volume
persistence. All of those belong to Step 24.2.

```text
local-ai-harness-backend:local    Node 22 + compiled JavaScript (node dist/server.js)
local-ai-harness-frontend:local   nginx serving the Vite production bundle
```

## Prerequisites

* Docker with a build daemon (BuildKit is used by default in Docker 23+).
* Network access to the npm registry during the build (pnpm downloads the
  dependencies and Corepack downloads the pinned pnpm version).
* No global pnpm installation is required on the build machine. The package
  manager version comes from `"packageManager": "pnpm@11.26.0"` in the root
  `package.json` and is resolved through Corepack inside the images.

That field is also what pnpm enforces locally (its default
`package-manager-strict` behaviour), so repository commands such as `pnpm test`
now require a matching pnpm major version.

## Build context

Both images use the **repository root** as build context because the frozen
`pnpm-lock.yaml` and `pnpm-workspace.yaml` live there, and always pass the
Dockerfile explicitly with `-f`:

```bash
docker build -f backend/Dockerfile ... .
docker build -f frontend/Dockerfile ... .
```

The single root `.dockerignore` is the effective one (`.dockerignore` files
inside `backend/` or `frontend/` are not read when the context is the root).

## Backend image

```bash
# build
docker build -f backend/Dockerfile -t local-ai-harness-backend:local .

# run
docker run --rm -p 3000:3000 local-ai-harness-backend:local

# health (separate terminal)
curl http://127.0.0.1:3000/api/health
```

Expected health response:

```json
{"status":"ok","name":"Local AI Harness","version":"0.0.0"}
```

No model provider is required for the container to start or for `/api/health`
to answer.

### Stage layout

| Stage | Base | What happens |
| --- | --- | --- |
| `build` | `node:22-slim` | `corepack enable` → copy workspace manifests → `pnpm install --frozen-lockfile --filter backend` → copy backend source → `pnpm --filter backend build` (`tsc`) |
| `runtime` | `node:22-slim` | `pnpm install --frozen-lockfile --filter backend -P` (production dependencies only) → copy `dist/` from `build` → `USER node` → `node dist/server.js` |

`tsx` is never used in the image; it stays a development dependency for
`pnpm dev`. The production install is deliberately scoped with `-P` so the
runtime image contains no TypeScript, ESLint, Vitest or `tsx`.

`node:22-slim` (Debian, not Alpine) is used because it satisfies the repository
`engines` (`node >= 22`) and the `>= 22.12` requirement of Vite and `>= 22`
requirement of `unpdf`, without introducing musl/glibc risk. The image tag is a
fixed major tag; digests are intentionally not pinned.

### Port and bind behaviour

`AI_HOST` defaults to `127.0.0.1` in the application, which is correct for
`pnpm dev`. The Dockerfile sets `ENV AI_HOST=0.0.0.0` so the server is
reachable from outside the container; the application source is unchanged.

The container listens on `3000` (`AI_PORT` default) and `EXPOSE 3000` documents
that. Publish it with `-p 3000:3000`.

### Runtime environment

Baked into the image (each value can be overridden with `docker run -e ...`):

| Variable | Image value | Note |
| --- | --- | --- |
| `AI_HOST` | `0.0.0.0` | container-reachable bind; application default stays `127.0.0.1` |
| `AI_ENVIRONMENT` | `production` | logged at startup only |
| `AI_UPLOAD_DIR` | `/app/uploads` | absolute path, pre-created and owned by the runtime `node` user |
| `COREPACK_ENABLE_DOWNLOAD_PROMPT` | `0` | non-interactive Corepack during build |

Everything else keeps the application defaults documented in
`backend/.env.example` (`AI_PORT`, `AI_CORS_ORIGINS`, `AI_REQUEST_TIMEOUT_MS`,
`AI_MAX_UPLOAD_SIZE_MB`, `AI_DEFAULT_PROVIDER_TIMEOUT_MS`,
`AI_TEMP_FILE_MAX_AGE_MS`). `.env` files are excluded from the build context,
so nothing is read from disk unless you deliberately mount or pass it.

The backend runs as the non-root `node` user. Application code is root-owned;
only `/app/uploads` is writable by the runtime user. No volume is declared in
Step 24.1: uploads stay inside the container's writable layer and disappear with
it. Persistence is a Step 24.2 / later topic.

## Frontend image

```bash
# build
docker build -f frontend/Dockerfile -t local-ai-harness-frontend:local .

# run
docker run --rm -p 8080:80 local-ai-harness-frontend:local
```

Then open <http://127.0.0.1:8080>.

| Stage | Base | What happens |
| --- | --- | --- |
| `build` | `node:22-slim` | `corepack enable` → copy workspace manifests → `pnpm install --frozen-lockfile --filter frontend` → copy frontend source → `pnpm --filter frontend build` (`vue-tsc -b && vite build`) |
| `runtime` | `nginx:1-alpine` | copy `frontend/nginx.conf` and the built `dist/` → serve on port `80` |

`frontend/nginx.conf` is intentionally minimal: static root, `index.html`, and
`try_files $uri $uri/ =404`. There is **no SPA fallback** (the application has
no client-side router) and **no reverse proxy**. The container serves the standard
nginx user model (master as root, workers as `nginx`), published as `8080:80`.

### `VITE_API_URL` is a build-time value

The frontend reads the backend base URL from `import.meta.env.VITE_API_URL`,
with a source fallback of `http://127.0.0.1:3000`:

* Vite inlines `VITE_*` values into the bundle **at build time**; changing them
  later requires a rebuild, not just a container restart.
* `.env` files are excluded from the build context, so the standalone image is
  built with the source fallback (`http://127.0.0.1:3000`), which is a
  browser-side address: it points at whatever backend happens to be published on
  the developer machine's port 3000.
* No API URL, host name or credential is baked in as a Docker `ARG`/`ENV` in
  Step 24.1, and `http://backend:3000` is deliberately **not** compiled into the
  bundle because a browser cannot resolve Docker service DNS names.

The final same-origin `/api` strategy (browser → frontend container → reverse
proxy → backend container) is defined in Step 24.2.

## Running both containers side by side

Both images run independently, which is all Step 24.1 validates. Be aware that
`local-ai-harness-frontend` on `http://localhost:8080` calling a backend on
`http://localhost:3000` is a cross-origin browser request, and the backend's
default `AI_CORS_ORIGINS` only allows the Vite dev-server origins
(`5173`). This is expected: full frontend-to-backend container integration is
intentionally deferred to Step 24.2, where the reverse-proxy/same-origin design
removes the need to widen CORS. Broadening `AI_CORS_ORIGINS` is not the
intended permanent solution.

## `.dockerignore`

The root `.dockerignore` excludes `**/node_modules`, `**/dist`,
`**/*.tsbuildinfo`, `**/coverage`, `**/*.test.ts`, `**/.env*`, `**/logs`,
`**/*.log`, `**/uploads`, `**/temp`, `/tmp`, `.git`, `.github`,
editor/OS artifacts, and the unused root `package-lock.json` (kept in the
repository; it is simply not a Docker build input).

It keeps every build input: the three `package.json` manifests,
`pnpm-lock.yaml`, `pnpm-workspace.yaml`, the `tsconfig` files, `backend/src`,
`frontend/src`, `frontend/index.html`, `frontend/public`,
`frontend/vite.config.ts`, both Dockerfiles and `frontend/nginx.conf`.

`**/*.test.ts` is excluded because production images do not need test sources,
and the backend and frontend builds were confirmed to succeed without them.
Test-only helpers that do not match that pattern (`backend/src/test/`,
`src/__tests__/`) may still appear in the images; that is accepted for Step
24.1 rather than adding increasingly specific exclusions.

## Security invariants

* No API keys, provider credentials, tokens or `.env` contents are copied into
  any layer, and no Docker `ARG` is used for them.
* No model server or model weights (Ollama, llama.cpp, LM Studio) are installed
  or downloaded. Model hosting stays outside Docker.
* The backend container runs as a non-root user with only the upload directory
  writable.

## Validation status

Validated in the authoring environment (no Docker daemon available):

* `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm typecheck`, `pnpm lint`,
  `pnpm build` on the repository.
* The Dockerfile stage sequences were reproduced outside the repository, in a
  scratch directory, with the same commands: filtered frozen installs, `tsc`
  and `vue-tsc -b && vite build` with test files excluded, the `-P`
  production-only backend install (59 packages, no devDependencies), and
  `node dist/server.js` answering `GET /api/health`.

**Pending** (requires a Docker-enabled machine; not claimed as verified):
`docker build` / `docker run` for both images, host-reachable health and static
assets. See the commands at the end of this file.

## Deferred to Step 24.2

* Docker Compose for the two services and the internal network.
* Frontend web-server reverse proxy for same-origin `/api` access.
* Backend → host model server connectivity (`host.docker.internal`, including
  the Linux host-gateway mapping).
* Image/Compose healthchecks.
* Upload-directory persistence and any port/publishing changes.

## External Docker validation commands

```bash
# 1. backend image
docker build -f backend/Dockerfile -t local-ai-harness-backend:local .

# 2. backend container
docker run --rm -p 3000:3000 local-ai-harness-backend:local

# 3. health, from the host, in another terminal
curl -i http://127.0.0.1:3000/api/health

# 4. frontend image
docker build -f frontend/Dockerfile -t local-ai-harness-frontend:local .

# 5. frontend container
docker run --rm -p 8080:80 local-ai-harness-frontend:local

# 6. page and assets from the host
curl -i http://127.0.0.1:8080/

# the HTML above references /assets/index-<hash>.js; request it, e.g.
curl -I http://127.0.0.1:8080/assets/index-<hash>.js
```

Step 24.1 is complete when the two builds succeed, the backend starts with
`node dist/server.js`, `/api/health` answers from the host, the frontend page
loads and its assets are served.
