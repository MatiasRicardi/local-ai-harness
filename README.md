# Local AI Harness

> ⚠️ **Project in development — Reference code** ⚠️

This repository contains a lightweight web application for connecting with local language models through an OpenAI-compatible API.

## 🧠 Purpose

This project has a clear goal: **learning**.

I am investigating how to integrate a local language model (LLM) into a web application, and this repository is the result of that learning process. It is not a finished product or production software.

### What are you seeing here?

- Real-time chat with streaming responses
- Configuration of local providers (llama.cpp, Ollama, LM Studio, etc.)
- Text and PDF file uploads
- Monorepo architecture with strict TypeScript

### ⚠️ Important Warning

**This project may have bugs and performance issues.**

It is being built step by step as part of a learning process. It is not a product ready for production. If you find bugs, that is part of the process — and bug reports are welcome.

## 🛠️ Tech Stack

- **Monorepo**: pnpm workspace
- **Backend**: Node.js, TypeScript, Fastify, Zod
- **Frontend**: Vue 3, TypeScript, Vite
- **Testing**: Vitest

## 📋 Current Status

This is an in-progress project. The following areas are pending implementation:

- [ ] **Frontend tests** — No tests implemented yet in the Vue layer
- [ ] **Broader test coverage** — Backend tests cover error cases, but complete chat/streaming scenarios are missing
- [ ] **Performance optimization** — Streaming may have latency issues in certain configurations
- [ ] **Documentation of known issues** — Will be added as they are discovered

## 🚀 Getting Started

### Prerequisites

- Node.js >= 22.0.0
- pnpm >= 8.0.0

### Installation

```bash
pnpm install
```

### Development

```bash
# Backend only
pnpm dev:backend

# Frontend only
pnpm dev:frontend

# Both
pnpm dev
```

## 📝 About this project

- **Built by me**: This project is my own work, built step by step as part of my learning in software development.
- **Ornith 1.0 9B support**: The implementation received support from the local language model Ornith 1.0 9B, used as a code assistant to review, correct, and improve the code.

## 📄 License
MIT
