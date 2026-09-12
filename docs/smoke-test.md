# Smoke Test — Local AI Harness

End-to-end smoke test for **Local AI Harness**. Run one of the two flows below
against a real OpenAI-compatible model server (Ollama, llama.cpp, or LM Studio).

> This verifies the app runs and the main paths work. It does not validate the
> quality of model output.

## Prerequisites

- A model server reachable from the machine running the app, e.g.:
  - **Ollama**: `http://127.0.0.1:11434`
  - **llama.cpp server**: `http://127.0.0.1:8080`
  - **LM Studio**: `http://127.0.0.1:1234`
- A model available on that server (e.g. `qwen2.5:7b`). Note the model name.

---

## Flow A — Development (`pnpm dev`)

1. Install and start:
   ```bash
   pnpm install
   pnpm dev
   ```
   This starts the backend on `127.0.0.1:3000` and the frontend on
   `http://localhost:5173`.

2. Open <http://localhost:5173>.

3. Open **Provider Settings** and set:
   - **Base URL**: the model server URL from the prerequisites.
   - **Model**: the model name.
   - **API key**: leave blank for local servers that don't require one.
   - **Timeout**: leave the default.

4. Click **Test connection**.
   - ✅ Expect a success message with a short greeting from the model.
   - ❌ If it fails, re-check the base URL and model name, and confirm the
     model server is running.

5. Type a message and send it.
   - ✅ Expect streamed markdown to appear token by token.
   - ✅ Click **Stop** and confirm generation halts.

6. (Optional) Attach a `.txt`, `.md`, or `.pdf` file, then send a question
   about it.
   - ✅ Expect the answer to reference the document content.

7. (Optional) Click **Reset conversation** and confirm the chat clears.

---

## Flow B — Docker Compose

1. Build and start (from the repository root):
   ```bash
   docker compose up --build
   ```
   The frontend is served at <http://127.0.0.1:8080>. The backend runs inside
   the compose network and is **not** published to the host.

2. Open <http://127.0.0.1:8080>.

3. The model server runs **on the host**, outside Docker. Before configuring
   its URL, confirm the server is reachable from Docker: a model service bound
   to `127.0.0.1` is **not** reachable from a container, so it must bind to an
   address Docker can reach. See the host-binding guidance in
   [`docs/docker.md`](docker.md#the-model-server-must-be-reachable-from-docker)
   first.
   
   Then, in **Provider Settings**, set the base URL to:
   - `http://host.docker.internal:<provider-port>`

   For example, Ollama on port 11434 → `http://host.docker.internal:11434`.
   (On Linux, `host.docker.internal` is provided by the `host-gateway` mapping
   in `docker-compose.yml`.)
   
   > **Warning:** binding the model server to a non-loopback address to make it
   > reachable from Docker exposes it on the network. Ensure the host firewall
   > restricts that binding to trusted interfaces/ports before continuing.

4. **Test connection**, then send a message, exactly as in steps 4–7 of Flow A.

### Backend-only debugging

To reach the backend directly on the host, add a
`docker-compose.override.yml` that publishes port 3000 (documented in
[`docs/docker.md`](docker.md)). Do not edit `docker-compose.yml` for this.

---

## Expected results summary

| Step                         | Expected                          |
|------------------------------|-----------------------------------|
| Test connection              | Success greeting from the model   |
| Send a message               | Streamed markdown response        |
| Stop / cancel                | Generation halts                  |
| Attach document + ask        | Answer references the document    |
| Reset conversation           | Chat clears                       |

## If something fails

- Confirm the model server is up and the model name is correct.
- For Docker, confirm `host.docker.internal` resolves (see
  [`docs/docker.md`](docker.md)).
- Check the backend logs (`pnpm dev` prints them; in Docker,
  `docker compose logs backend`).
- The health endpoint is `GET /api/health` (backend only).
