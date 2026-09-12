# Contributing — Local AI Harness

Thanks for your interest. This project is organized as a **pnpm workspace**
monorepo with a small, consistent set of conventions.

## Environment

- Node.js >= 22.0.0
- pnpm >= 8.0.0

```bash
pnpm install
```

## Project layout

```text
backend/   # Node.js + Fastify + TypeScript (the HTTP API)
frontend/  # Vue 3 + TypeScript + Vite (the chat UI)
docs/      # User and developer documentation
instructions/  # Ordered implementation steps (reference)
```

## Running services

```bash
# From the repository root
pnpm dev                 # backend + frontend
pnpm dev:backend         # backend only (tsx watch)
pnpm dev:frontend        # frontend only (Vite)
```

The browser calls `/api` (same-origin), which the Vite dev proxy forwards to the
backend on `127.0.0.1:3000`.

## Workflow

1. Create a feature branch from `main`.
   - Naming convention: `feature/stepNN-description` (matches the existing
     `feature/step*` branches).
2. Make the smallest change that satisfies the request.
3. Verify locally before opening a pull request:
   ```bash
   pnpm test                # backend + frontend tests
   pnpm typecheck           # tsc / vue-tsc
   pnpm lint                # ESLint (backend + frontend)
   pnpm build               # production builds
   ```
4. Open a pull request with a clear description and the step it addresses.

## Conventions

- **TypeScript, strict mode.** Avoid `any`; prefer `unknown` or a specific type.
- **Conventional Commits.** Scope the change, e.g.
  `feat(frontend): ...`, `fix(backend): ...`, `docs: ...`, `style: ...`.
- **Follow existing patterns.** Inspect similar code first and preserve the
  current structure, naming, validation, error handling, and logging.
- **Structured errors.** Use the shared `AppError` shape and appropriate HTTP
  status codes; keep messages user-friendly.
- **Logging.** Log actionable errors without sensitive data (API keys, uploaded
  contents, raw error details).

## Validation

Always run the smallest relevant check and report it honestly. Do not disable
tests, silence errors, or bypass validation to make work appear complete.

## Scope

Prefer focused edits over rewrites. Do not introduce new dependencies, patterns,
or features without explicit agreement. Report unrelated issues separately.

## Documentation

When behavior or usage changes, update the relevant doc:

- Backend/frontend structure → [`docs/architecture.md`](docs/architecture.md)
- Security-relevant changes → [`docs/security.md`](docs/security.md)
- Docker/compose changes → [`docs/docker.md`](docs/docker.md)
