# 🤖 Local AI Harness

This project is a web chat application designed to interact with **local AI models**.

The goal is to provide an interface where users can share **text, images, and documents** with the model, while also providing external tools such as **web search** and other integrations.

The project has been primarily tested using **Qwen 3.6 35B**.

## 🎯 Motivation

The idea behind this project is to learn and experiment with integrating artificial intelligence models into a real application.

The architecture was designed to work with **OpenAI-compatible APIs**, allowing different local models and servers that implement this format to be used.

This is a **100% educational project**. It may contain bugs, incomplete features, and design decisions that may not be 100% correct.

**It is not intended for use in production environments.**

## 🤖 AI-Assisted Development

A large part of the development was done using **Ornith 1.0 35B** as a local coding agent.

My role was to design the architecture, plan the development, fix some bugs that the agent struggled to identify, and implement a few features myself just so I wouldn't get bored.

This project also served as a way to test the idea of whether a **relatively small LLM**, used as a coding agent, could be effective when developing a real-world project.

## 🛠️ Tech Stack

* **Monorepo**: pnpm workspace
* **Backend**: Node.js, TypeScript, Fastify, Zod
* **Frontend**: Vue 3, TypeScript, Vite
* **Testing**: Vitest

## 🚀 Getting Started

### Prerequisites

* Node.js >= 22.0.0
* pnpm >= 8.0.0

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

## 📄 License

MIT
