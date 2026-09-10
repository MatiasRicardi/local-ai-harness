# Manual smoke test — MVP

Release-oriented checklist for the Local AI Harness MVP. Run against a real
local provider (llama.cpp, Ollama, LM Studio or any OpenAI-compatible server).
Automated tests cover the same flows with mocks; this checklist proves the real
end-to-end wiring.

Estimated time: ~10 minutes.

## Setup

```bash
pnpm install   # once, from the repository root
```

Either run both services from the root (`pnpm dev`), or start them separately in
two terminals (`pnpm --filter backend dev`, then `pnpm --filter frontend dev`).

## 1. Startup

- [ ] Backend starts without errors and prints the listening host/port.
- [ ] Frontend dev server starts and the app renders at the Vite URL.
- [ ] `GET http://127.0.0.1:3000/api/health` returns a success payload.
- [ ] No secrets, absolute server paths or stack traces in the startup logs.

## 2. Provider setup and connection test

- [ ] Provider fields load from `localStorage` on reload (settings persist).
- [ ] Valid Base URL + Model → **Test Connection** shows a green success with the
      connected model name.
- [ ] Wrong Base URL (e.g. `http://localhost:9`) → red "Connection failed"
      status with a short, human-readable message.
- [ ] Empty Base URL or empty Model → the Test Connection button stays disabled.
- [ ] Model that the server does not serve → safe failure message, no raw
      provider payload.

## 3. Basic chat and streaming

- [ ] Send a short prompt → the user message appears immediately.
- [ ] A loading/typing indicator is visible while generating.
- [ ] The assistant reply streams progressively (token by token), not all at once.
- [ ] Markdown renders as HTML: headings, lists, inline `code`, fenced code blocks,
      links — and no raw HTML from the model is injected unescaped.
- [ ] The Send button is disabled / input locked while a response is generating.
- [ ] Empty input cannot be submitted.

## 4. Stop / cancellation

- [ ] While a long answer is generating, **Stop** is shown instead of Send.
- [ ] Stop halts output within ~1 s and shows the "Generation stopped" notice
      plus the per-message "Stopped" marker; partial text is kept.
- [ ] No error is shown after Stop.
- [ ] Input and Send button become usable again; a new message can be sent.
- [ ] The backend logs no unhandled error for the cancelled request.

## 5. Document upload (TXT / Markdown / PDF)

- [ ] Upload a small `.txt` → attachment chip shows the filename, "Ready", and the
      extracted character count.
- [ ] Upload a `.md` → accepted and reported the same way.
- [ ] Upload a text-based `.pdf` → accepted; character count and page count shown.
- [ ] A PDF with extractable warnings shows them under the attachment.
- [ ] Upload an unsupported type (`.exe`, `.png`, no extension) → rejected in the
      attachment area with the allowed-extension message; no upload request sent.
- [ ] Upload an oversized file (over `AI_MAX_UPLOAD_SIZE_MB`) → size-limit error in
      the attachment area.
- [ ] **Remove** clears the attachment chip and its error state.
- [ ] **Replace** swaps in a new document; only the new one is shown/used.
- [ ] Only one upload is "in flight" at a time (busy state shown, controls disabled).

## 6. Document Q&A

- [ ] Ask a question that is answered from the attached document → the answer uses
      the document content.
- [ ] The document is **not** rendered as a visible user message; only the question
      appears in the chat.
- [ ] Ask about content that is not in the document → the model says it is not
      covered rather than inventing it.
- [ ] After Remove, the same question no longer has document context.

## 7. Context handling

- [ ] A document that fits the configured context window → normal answer, no warning.
- [ ] A document larger than the context window → truncation warning appears
      (included vs original characters) and the answer still arrives.
- [ ] A prompt that cannot fit even after truncation → clear "context too large"
      error in the chat area, with no partial/garbled assistant message.
- [ ] Reduce the context size setting → the warning/error behaviour follows the
      new limit.
- [ ] The truncation warning is styled as a warning, not as an error.

## 8. New conversation (reset)

- [ ] **Start a new conversation** asks for confirmation only when there is a real
      conversation.
- [ ] Cancelling the confirmation changes nothing.
- [ ] Confirming clears messages, attachment, errors and warnings, and the unsent
      draft.
- [ ] Provider settings (Base URL, model, context size) are preserved.
- [ ] Reset **during** generation: output disappears and no late tokens reappear.
- [ ] Reset **during** upload: the attachment does not reappear after the in-flight
      request finishes.
- [ ] The first message of the new conversation is not answered with context from
      the previous one.

## 9. Provider and network failures

- [ ] Stop the backend and send a message → "Unable to reach the local backend"
      style error; the app stays usable.
- [ ] Point the Base URL at a server that accepts the connection but is not an LLM
      → safe error, no raw response dump.
- [ ] Provider slower than the timeout setting → timeout error; input is released.
- [ ] Provider requiring a key (wrong/missing API key) → unauthorized-style error,
      key never shown back.
- [ ] Failure during streaming → error shown, busy state released, chat remains usable.
- [ ] A failing upload reports in the **attachment** area only, never duplicated in
      the chat area (and vice versa).

## 10. Malformed / no-text PDF

- [ ] Upload a scanned (image-only) PDF → clear "no extractable text" style error in
      the attachment area, not a crash.
- [ ] Upload a corrupt/zero-byte `.pdf` → extraction failure message, app stays usable.
- [ ] After either failure, a subsequent valid upload still works.
- [ ] The backend temp/upload directory holds no leftover files after these cases.

## 11. Security sanity

- [ ] The API key input is a password field; the key is never echoed in the UI,
      status messages or logs.
- [ ] No server filesystem paths, upload directory names or internal fileIds of other
      requests appear in user-visible errors.
- [ ] No raw stack trace, `Error: ...` internals or `[object Object]` in the UI.
- [ ] Browser console shows no leaked provider secrets on failed requests.
- [ ] Network tab: upload request carries only the file and the `fileId` issued by
      the backend.

## Result

- [ ] All boxes above pass on this build.
- Any failure: file it as a separate issue with the step section number, expected
  and actual behaviour, and the browser/backend logs (redacted).
