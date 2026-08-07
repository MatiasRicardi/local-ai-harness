# Frontend — Local AI Harness

Vue 3 + TypeScript + Vite frontend for the Local AI Harness application.

> ⚠️ **Project in development — Reference code** ⚠️

## 🧠 Purpose

This frontend is part of a learning project to integrate a local LLM into a web application. The code is written by the author, with review and correction support from the local language model **Ornith 1.0 9B**.

### ⚠️ Warning

This code may contain bugs and is not suitable for production. It is under continuous development.

## Project Structure

```
src/
├── components/    # Vue components
├── composables/   # Vue composition utilities
├── services/      # API and external service calls
├── types/         # TypeScript type definitions
├── App.vue        # Root component
├── main.ts        # Application entry point
└── style.css      # Global styles
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
