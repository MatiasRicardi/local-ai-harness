# Backend — Local AI Harness

Fastify backend for Local AI Harness.

> ⚠️ **Project in development — Reference code** ⚠️

## 🧠 Purpose

This backend is part of a learning project to integrate a local LLM into a web application. The code is written by the author, with review and correction support from the local language model **Ornith 1.0 9B**.

### ⚠️ Warning

This code may contain bugs and is not suitable for production. It is under continuous development.

## Configuration

The backend uses environment variables prefixed with `AI_` for configuration. Copy `.env.example` to `.env` and modify as needed.

```bash
cp .env.example .env
```

## Development

```bash
# Start development server
pnpm dev

# Or using workspace filter
pnpm --filter backend dev
```

## Build

```bash
# Compile TypeScript
pnpm build
```

## Start

```bash
# Run compiled server
pnpm start
```

## Type Checking

```bash
pnpm typecheck
```

## Tests

```bash
pnpm test
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AI_HOST` | Server host | `127.0.0.1` |
| `AI_PORT` | Server port | `3000` |
| `AI_CORS_ORIGINS` | CORS origins (comma-separated) | `http://localhost:5173,http://127.0.0.1:5173` |
| `AI_REQUEST_TIMEOUT_MS` | Request timeout in milliseconds | `30000` |
| `AI_MAX_UPLOAD_SIZE_MB` | Maximum upload size in megabytes | `10` |
| `AI_UPLOAD_DIR` | Upload directory | `./uploads` |
| `AI_DEFAULT_PROVIDER_TIMEOUT_MS` | Default provider timeout in milliseconds | `120000` |
| `AI_ENVIRONMENT` | Environment (development, production, test) | `development` |

## Scripts

| Script | Command |
|--------|---------|
| `dev` | Start development server with tsx watch |
| `build` | Compile TypeScript to `dist/` |
| `start` | Run compiled server with Node.js |
| `typecheck` | Run TypeScript type checking |
| `test` | Run Vitest tests |
| `lint` | Lint (placeholder) |
| `format` | Format (placeholder) |
| `clean` | Remove `dist/` directory |

## Configuration

- **PORT**: Environment variable, defaults to `3000`
- **HOST**: Environment variable, defaults to `127.0.0.1`
