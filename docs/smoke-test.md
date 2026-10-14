# Smoke Test — Local AI Harness

End-to-end smoke test for **Local AI Harness**. Run one of the two flows below
against a real OpenAI-compatible model server (Ollama, llama.cpp, or LM Studio).

> This verifies the app runs and the main paths work. It does not validate the
> quality of model output.

Flows **E–H** cover the v1.2.0 features (runtime context, calculator, fetch URL and tool
composition). They are written as instructions only and have **not** been executed here:
this environment has no usable Docker and no live OpenAI-compatible model server. Run them
as part of the release validation (`releases/v1.2.0-checklist.md`). Flows E, F, G and H
need a model that actually emits tool calls.

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

3. In the **Model Settings** sidebar (left column; stacked above the chat on
   narrow screens) set:
   - **Base URL**: the model server URL from the prerequisites.
   - **Model**: the model name.
   - **API key**: leave blank for local servers that don't require one.
   - **Timeout**: leave the default.

4. Click **Test Connection**, pinned at the bottom of the sidebar.
   - ✅ Expect a success message with a short greeting from the model.
   - ❌ If it fails, re-check the base URL and model name, and confirm the
     model server is running.

5. Type a message and send it.
   - ✅ Expect streamed markdown to appear token by token.
   - ✅ Click **Stop** and confirm generation halts.

6. (Optional) Attach a `.txt`, `.md`, or `.pdf` file, then send a question
   about it.
   - ✅ Expect the answer to reference the document content.

7. (Optional) Click **New Chat** in the header and confirm the chat clears.

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
   
   Then, in **Model Settings**, set the base URL to:
   - `http://host.docker.internal:<provider-port>`

   For example, Ollama on port 11434 → `http://host.docker.internal:11434`.
   (On Linux, `host.docker.internal` is provided by the `host-gateway` mapping
   in `docker-compose.yml`.)
   
   > **Warning:** binding the model server to a non-loopback address to make it
   > reachable from Docker exposes it on the network. Ensure the host firewall
   > restricts that binding to trusted interfaces/ports before continuing.

4. **Test connection**, then send a message, exactly as in steps 4–7 of Flow A.

## Flow C — Web search (optional, Phase 2)

Web search is model-driven and requires a tool-capable local model. Before
starting, confirm your model supports OpenAI-style tool calling (see
[`docs/architecture.md`](architecture.md#tool-call-compatibility)); many small
local models do **not**.

1. Ensure the backend has `AI_TAVILY_BASE_URL` configured or defaulted
   (`https://api.tavily.com`). No code change is needed to override it (see
   step 11).
2. Configure a tool-capable local model in **Model Settings**, then send a
   message to confirm tool calling works.
3. Open **Web Search settings** (separate from provider settings) and enter your
   Tavily API key. The key is stored only in your browser and sent to the backend
   only while web search is enabled.
4. Enable **Web Search**.
5. Ask a question that needs fresh/external information (e.g. "What is the weather
   in London today?").
6. Verify a **Search activity** block appears (the tool ran) and that the answer
   cites sources.
7. Verify the **Sources** section lists the origin links.
8. Click a source to open the original URL.
9. Click **Stop** mid-turn and confirm generation halts (including the search).
10. Disable **Web Search** and confirm ordinary chat still works.
11. (Optional) Override `AI_TAVILY_BASE_URL` to a controlled test endpoint, restart
    the backend, and confirm the search still runs through the new base URL. The
    frontend has no field for the base URL, so it cannot be changed from the UI.

> Web search uses the Tavily Search API and bills per search. Only one search is
> allowed per user turn, and there are no automatic retries. `basic` search depth
> is the default; `advanced` may issue more requests and consume more credits.

### Backend-only debugging

To reach the backend directly on the host, add a
`docker-compose.override.yml` that publishes port 3000 (documented in
[`docs/docker.md`](docker.md)). Do not edit `docker-compose.yml` for this.

---

## Flow D — Interface checks

Presentation-only; no model server response is required for most of them.

1. **Header** shows the app name, the package version, and — only when they are
   actually configured — the provider name + endpoint host and the model +
   context window. Nothing in the header is invented, and the status dot stays
   neutral until a connection test has been run (it is not a health poll).
2. **Model Settings** cards (Connection Endpoint / Context & Runtime /
   Web Search) scroll independently, and the **Test Connection** footer stays
   pinned and visible while scrolling.
3. The header dot turns amber while testing, then green/red with the result
   panel in the footer.
4. Clear the **Base URL** field: **Test Connection** becomes disabled.
5. Use the context slider: the numeric **Context size** field and the two
   badges (card header, header model pill) update together, and the slider
   highlights the nearest power-of-two step.
6. On an empty chat, the canvas shows the welcome state and the composer starts
   empty; type a message and send it as usual.
7. The composer floats above the canvas; **Enter** sends, **Shift + Enter** adds
   a newline, and **Attach document** / the attached-file chip work as before.
8. Resize to a narrow viewport (or zoom): the sidebar stacks above the chat,
   the header collapses the endpoint/model pills, and no horizontal scrollbar
   appears.
9. A new remote `http://` base URL still shows the cleartext warning, and a
   loopback (`localhost` / `127.0.0.1` / `[::1]`) URL does not.

---

## Flow E — Runtime context

**Objective:** confirm the model is told the current date, time and timezone from the
**backend clock**, and that an absent or invalid runtime payload never breaks chat.

**Prerequisites:** default settings (all tools off). There is **no** Runtime-context
switch in the UI — the browser timezone and locale are collected automatically and sent on
streaming requests, which is the behaviour under test.

1. Start the app as in Flow A, on a machine set to a non-UTC timezone.
2. Ask: “What is today's date, and what time is it in my timezone right now?”
3. Compare the answer with the machine's actual date, time and timezone.
4. Change the operating-system timezone (or start the browser with a different `TZ`),
   reload, and ask again.
5. Negative cases with `curl` against `POST /api/chat/stream`: send
   `runtimeContext: { timeZone: "Not/AZone", locale: "en-US" }`, then an over-length
   `locale`, then omit `runtimeContext` entirely.

**Expected results:**

- [ ] The answer states the current date and the **browser's** timezone, consistent with
      the machine clock: the browser supplies timezone and locale only, the instant always
      comes from the backend clock.
- [ ] After the timezone changes, the next turn reflects the new zone (no restart needed).
- [ ] A malformed or over-length runtime value is rejected with `VALIDATION_ERROR` and a
      field-level `detail`; omitting the field is accepted, chat works, and the backend
      message falls back to UTC.
- [ ] Nothing about the runtime payload is logged by the backend, and the settings UI
      correctly offers no toggle for it.

---

## Flow F — Calculator

**Objective:** confirm the model can evaluate arithmetic through `calculator`, that its
input bounds hold, and that there is no code-execution path.

**Prerequisites:** a local model that emits tool calls. Enable **Calculator** in the
tools settings card.

1. Ask: “Use a calculation to work out `(128 * 7) + 42` and explain the steps.”
2. Watch the tool activity in the transcript, then read the answer.
3. Ask the model to run something that is not arithmetic, e.g. “Use the calculator to run
   `process.exit(1)`.”
4. Ask for degenerate input: division by zero, and a deeply nested expression such as
   `(((((((((((((1)))))))))))))`.
5. Disable **Calculator** and ask the first question again.

**Expected results:**

- [ ] A `tool_start` labelled “Calculating…” appears and is followed by `tool_end`, then
      the answer uses the correct result (`938` in step 1).
- [ ] The transcript never shows raw tool JSON, a provider `tool` role, or a tool-call id.
- [ ] Step 3 is refused as invalid arguments (`TOOL_INVALID_ARGUMENTS`): only numbers,
      `+ - * / % ^`, parentheses and unary signs are accepted, and nothing is evaluated as
      code.
- [ ] Step 4 produces a stable tool error (or an answer without a tool) and the backend
      stays healthy for the next message.
- [ ] With **Calculator** off the same question never triggers a `calculator` event: the
      tool is not offered, so it cannot be called.

---

## Flow G — Fetch URL

**Objective:** confirm `fetch_url` reads a public page as text, honours its guards, and
never reaches an internal address.

**Prerequisites:** a tool-calling model, and internet access from the machine running the
backend.

1. Enable **Fetch URL** in the tools settings card (Web Search may stay off).
2. Ask: “Fetch `https://example.com/` and tell me what the page says.”
3. Ask it to fetch a non-existent public path (404), then an internal address:
   `http://127.0.0.1:3000/api/health` and `http://169.254.169.254/latest/meta-data/`.
4. Ask it to fetch a binary URL (a PDF or a PNG).
5. Start a fetch of a large page and press **Stop** while it runs.
6. Turn the network off on the backend host (or point at an unreachable host) and try
   again.

**Expected results:**

- [ ] Step 2 shows “Reading a web page…”, then an answer built from the page text, and the
      conversation gains a `[1]` source titled with the page `<title>` (or the hostname
      when there is no usable title) linking to the fetched URL.
- [ ] The `[N]` label always comes from the harness: text inside the page such as `[1]`,
      “system” or another site's name never renames or invents a source.
- [ ] The 404 is a safe tool error (“could not be retrieved”); the loopback and metadata
      addresses are refused as non-public destinations, with no resolver detail and no
      internal payload in the response or the logs.
- [ ] A binary response is rejected because it is not textual, and nothing is stored.
- [ ] Stopping mid-fetch leaves a stopped message with the sources already accumulated and
      issues no further tool activity.
- [ ] The unreachable case surfaces as a connection/timeout tool error and the next
      message still works.

---

## Flow H — Tool composition (`web_search` → `fetch_url` → answer)

**Objective:** confirm a bounded multi-tool turn: sequential execution, the per-turn caps,
accumulated sources, and reliability across repeats.

**Prerequisites:** Web Search (valid Tavily key), Fetch URL and Calculator all enabled in
the same turn; a tool-calling model.

1. Ask something that needs a search and then a page, e.g. “Search for the official
   Fastify documentation on reply hijacking, open the best result, and quote the relevant
   part.”
2. Watch the sequence of tool events, then inspect the source list.
3. Ask something that wants more work than the caps allow, e.g. several searches and
   several pages in one turn.
4. Ask a mixed question, e.g. “Search for the current Fastify version, then calculate
   `(that year * 2)`.”
5. Repeat the step‑1 prompt **five times** and note how often a tool call happens at all.
6. Press **Stop** during the second tool of a chain.

**Expected results:**

- [ ] Tools run **one at a time**: at most one tool call per model round, never in
      parallel, and every `tool_start` is followed by exactly one `tool_end`.
- [ ] One turn performs at most **3** tool executions across at most **4** model rounds;
      past that the assistant answers with what it has (or says it stopped at the limit)
      and never keeps looping.
- [ ] `web_search` runs at most **once** per turn and `fetch_url` at most **twice**,
      however the model phrases its follow-ups.
- [ ] The source list is de-duplicated by URL, keeps stable `[N]` labels for the whole
      turn, and mixes search hits and fetched pages without renumbering earlier sources.
- [ ] The answer cites `[N]` markers; content that came only from a fetched page is
      attributed to that source, and a turn with no usable result says so instead of
      implying a source.
- [ ] Repeated identical prompts may or may not call tools (the model decides); every
      attempt must still produce a valid answer, valid history and no orphaned tool event.
      This is a reliability check, not a tool-call-rate check.
- [ ] Stopping mid-chain keeps the partial message plus its sources, marks the message as
      stopped, and the next message still works (history stays valid for the model).

---

## Expected results summary

| Step                         | Expected                          |
|------------------------------|-----------------------------------|
| Test connection              | Success greeting from the model   |
| Interface checks (Flow D)     | Cards scroll, footer pinned, no invented status |
| Send a message               | Streamed markdown response        |
| Stop / cancel                | Generation halts                  |
| Attach document + ask        | Answer references the document    |
| New Chat                     | Chat clears                       |

| Web search turn (Flow C)     | Search activity + cited sources   |
| Disable web search           | Ordinary chat resumes             |
| Runtime context (Flow E)     | Backend-clock date + user timezone |
| Calculator (Flow F)          | Correct result; non-arithmetic refused |
| Fetch URL (Flow G)           | Page text + `[N]` source; private targets refused |
| Tool composition (Flow H)    | Sequential tools within the caps, de-duplicated sources |

## If something fails

- Confirm the model server is up and the model name is correct.
- For Docker, confirm `host.docker.internal` resolves (see
  [`docs/docker.md`](docker.md)).
- Check the backend logs (`pnpm dev` prints them; in Docker,
  `docker compose logs backend`).
- The health endpoint is `GET /api/health` (backend only).
