# Local AI Harness

Local AI Harness is a simple web interface for chatting with local AI models through an OpenAI-compatible API.

I built it because I wanted a clean way to experiment with local LLMs from a browser, connect different model servers, attach documents, and try local AI workflows without depending on a hosted AI service.

Current release: `v1.1.0`

> Local AI Harness is mainly designed as a local, single-user developer tool. It is not intended to be exposed as a hardened multi-user production service.

## Features

Right now, Local AI Harness supports:

- Connecting to OpenAI-compatible local model servers
- Testing provider connections from the UI
- Streaming chat responses in real time
- Stopping an active generation
- Rendering Markdown responses
- Attaching TXT, Markdown, and PDF documents
- Using extracted document text as conversation context
- Configuring the model context size
- Resetting and starting a new conversation
- Web search through the model (Tavily), with a sources UI
- Running locally with pnpm or Docker Compose

## Tech stack

### Frontend

- Vue 3
- TypeScript
- Vite
- Tailwind CSS

### Backend

- Node.js
- TypeScript
- Fastify
- Zod

### Testing

- Vitest
- Vue Test Utils

### Tooling

- pnpm workspace
- Docker
- Docker Compose

## Getting started

### Requirements

You need:

- Node.js 22+
- pnpm 8+

### Install

```bash
pnpm install
```

### Run locally

To run the frontend and backend together:

```bash
pnpm dev
```

Or, if you prefer, you can run them separately:

```bash
pnpm dev:backend
pnpm dev:frontend
```

## Docker

I also added Docker support so the frontend and backend can be started together with:

```bash
docker compose up --build
```

Then open:

```text
http://127.0.0.1:8080
```

The model server still runs on your host machine, outside Docker. Local AI Harness connects to it through the OpenAI-compatible endpoint you configure in the UI.

More details are available in [docs/docker.md](docs/docker.md).

## Local model servers

The app is built around OpenAI-compatible HTTP APIs.

I mainly use it with local model servers such as `llama.cpp`.

Other runtimes like LM Studio or Ollama may also work when they expose an OpenAI-compatible endpoint, although I have not tested every possible configuration.

## Documents

You can attach one document to the conversation and use its extracted text as extra context for the model.

Currently supported:

- `.txt`
- `.md`
- `.pdf`

PDF support is limited to files with selectable text. OCR is not included.

## Web search

Web search is **optional and disabled by default**. It is model-driven: your model
itself decides when to call a `web_search` tool, so it requires a local model and
server that support OpenAI-style tool calling. Not every local model does — see the
[tool-call compatibility](docs/architecture.md#tool-call-compatibility) note in the
architecture docs before relying on it.

Web search starts with **Tavily** as the first provider. To use it:

1. Create a Tavily account and generate an API key.
2. Run Local AI Harness (`pnpm dev` or `docker compose up --build`).
3. Open **Web Search settings** (separate from Provider Settings) and paste your key.
   The key is stored only in your browser and is sent to the backend only while web
   search is enabled.
4. Enable **Web Search**.
5. Choose a search depth — `basic` (default) or `advanced`.
6. Ask a question that needs fresh or external information (for example, "What is the
   weather in London today?").

The answer cites the sources it used, and the **Sources** section lists the origin
links. You can stop a turn mid-search with **Stop**.

A few things worth knowing:

- The Tavily **Base URL is backend-configurable** through `AI_TAVILY_BASE_URL`
  (default `https://api.tavily.com`). It is **not** exposed in the normal UI, and it
  is never hardcoded inside the provider — it is injected through configuration.
- Web content is untrusted external data: results are treated as reference material,
  not instructions, and no arbitrary result URLs are fetched. See the
  [security](docs/security.md) docs.
- Tavily bills per search (see the [official Tavily docs](https://docs.tavily.com/documentation/pricing) for current pricing). Only one search is allowed per user turn, with no automatic retries; `advanced` depth may consume more credits than `basic`.

If you prefer a different provider later, the search layer is built as a pluggable
provider, so additional providers can be added without changing the chat flow.

## AI-assisted development

I used local LLMs as coding assistants while building this project.

A large part of the later development and review process was done with models from the [Ornith](https://huggingface.co/ornith-ai) family running locally, including [Ornith 1.5 35B A3B](https://huggingface.co/ornith-ai/Ornith-1.5-35B-A3B).

I used them to inspect the repository, review code, reason about implementation details, spot issues, and help execute development steps.

I still made the product decisions, defined the requirements, reviewed the changes, and decided what actually went into the project.

## Documentation

If you want to look deeper into how the project works:

- [Architecture](docs/architecture.md)
- [Security](docs/security.md)
- [Docker](docs/docker.md)
- [Smoke test](docs/smoke-test.md)
- [Contributing](CONTRIBUTING.md)
- [Releases](https://github.com/MatiasRicardi/local-ai-harness/releases)

## Roadmap

After `v1.1.0`, there are a few things I would like to explore:

- Multiple documents and RAG
- Conversation persistence
- More local model runtimes
- OCR support
- Additional web-search providers beyond Tavily
- Multi-step research and more tools

## License

MIT
