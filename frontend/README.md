# Frontend — Local AI Harness

Vue 3 + TypeScript + Vite frontend for the Local AI Harness application.

> Local AI Harness is a local, single-user developer tool. It is not intended as a hardened multi-user production service.

## 🧠 Purpose

Renders the chat interface: provider settings, streamed responses, document attachment, and conversation management. API calls go through the same-origin `/api` proxy (Vite in development, nginx in Docker).

## Project Structure

```
src/
├── components/    # Vue components
├── composables/   # Vue composition utilities
├── services/      # API and external service calls
├── styles/        # Global Tailwind entry and Markdown output styles
├── types/         # TypeScript type definitions
├── App.vue        # Root component
└── main.ts        # Application entry point
```

## Scripts

| Script | Command |
|--------|---------|
| Dev | `pnpm dev` |
| Build | `pnpm build` |
| Preview | `pnpm preview` |
| Type Check | `pnpm type-check` |

## Development

```bash
pnpm install
pnpm dev
```

Open [http://localhost:5173](http://localhost:5173) to view the app.

## Build

```bash
pnpm build
```

Build output is in `dist/`.

## lint

```bash
pnpm lint
```
