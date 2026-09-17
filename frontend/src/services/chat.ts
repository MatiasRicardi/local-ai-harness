import type { FrontendApiError } from "../types/error"
import { parseApiError, parseStreamErrorData, toNetworkError, toUnknownError } from "../utils/parseApiError"
import { API_BASE } from "./apiBase"

export interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

export interface ChatDocumentContext {
  fileId: string
  filename: string
  text: string
}

export interface ChatContext {
  maxTokens: number
}

export interface ChatRequest {
  messages: ChatMessage[]
  provider: {
    baseUrl: string
    model: string
    apiKey?: string
    timeoutMs: number
  }
  document?: ChatDocumentContext
  context?: ChatContext
}

export interface ChatResponse {
  success: boolean
  message?: ChatMessage
  model?: string
  finishReason?: string | null
  error?: FrontendApiError
}

export interface ChatProviderConfig {
  baseUrl: string
  model: string
  apiKey?: string
  timeoutMs: number
}

export interface ContextTruncationMetadata {
  documentTruncated: boolean
  originalDocumentCharacters: number
  includedDocumentCharacters: number
  estimatedOriginalDocumentTokens: number
  estimatedIncludedDocumentTokens: number
}

/**
 * A single, client-sanitized web-search source reference.
 *
 * Mirrors the backend `sources` SSE payload (`{ id, title, url }`) but is
 * re-validated on parse: only numeric ids and safe `http:`/`https:` URLs reach
 * this shape, so consumers can render links without re-checking.
 */
export interface WebSearchSource {
  id: number
  title: string
  url: string
}

/**
 * The exact `webSearch` payload sent with a chat request when web search is
 * enabled. `enabled` is always `true` here: callers omit the whole field when
 * the feature is off (see {@link buildWebSearchPayload}) so the legacy request
 * body stays untouched when the feature is unused.
 */
export interface WebSearchRequestConfig {
  enabled: true
  provider: "tavily"
  apiKey: string
  searchDepth: "basic" | "advanced"
  maxResults: number
}

/**
 * Project normalised web-search settings into the request payload.
 *
 * Returns `undefined` when web search is disabled so the caller can omit the
 * field entirely. `searchDepth` is coerced to `basic`/`advanced` as a
 * defensive guard; `maxResults` is assumed already clamped by the settings
 * layer. This is a pure projection — no clamping here.
 */
export function buildWebSearchPayload(settings: {
  enabled: boolean
  provider: string
  apiKey: string
  searchDepth: string
  maxResults: number
}): WebSearchRequestConfig | undefined {
  if (!settings.enabled) {
    return undefined
  }
  const depth = settings.searchDepth === "advanced" ? "advanced" : "basic"
  return {
    enabled: true,
    provider: "tavily",
    apiKey: settings.apiKey,
    searchDepth: depth,
    maxResults: settings.maxResults,
  }
}
export interface StreamEvent {
  type: "start" | "delta" | "done" | "error" | "tool_start" | "tool_end" | "sources"
  data: {
    model?: string
    text?: string
    message?: string
    // Stable backend error code (Step 21.2), present on `error` events.
    code?: string
    detail?: string
    context?: ContextTruncationMetadata
    // Tool lifecycle (web search). `name` is the tool name; `query`/`resultCount`
    // and `sources` are optional per event.
    name?: string
    query?: string
    resultCount?: number
    sources?: unknown
  }
}

export interface StreamCallbacks {
  onStart: (model: string, context?: ContextTruncationMetadata) => void
  onDelta: (text: string) => void
  onDone: () => void
  onStopped: () => void
  // The service layer owns parsing/normalization; consumers only decide where
  // to display an already-normalized error.
  onError: (error: FrontendApiError) => void
  // Tool lifecycle callbacks are optional: the UI may observe them (Step 34)
  // without the parser depending on any UI component. Absent callbacks are
  // simply ignored — the events still parse and advance the stream.
  onToolStart?: (payload: { name: string; query?: string }) => void
  onToolEnd?: (payload: { name: string; resultCount: number }) => void
  onSources?: (sources: WebSearchSource[]) => void
}

export async function streamChat(
  messages: ChatMessage[],
  provider: ChatProviderConfig,
  callbacks: StreamCallbacks,
  options?: {
    signal?: AbortSignal
    document?: ChatDocumentContext
    context?: ChatContext
    webSearch?: WebSearchRequestConfig
  },
): Promise<void> {
  const apiUrl = `${API_BASE}/api/chat/stream`

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let buffer = ""
  // Tracks terminal completion so the normal EOF path does not invoke the
  // completion callback a second time after a `done` SSE event already did.
  let completed = false

  try {
    const requestBody: Record<string, unknown> = { messages, provider }
    if (options?.document) {
      requestBody.document = options.document
    }
    if (options?.context) {
      requestBody.context = options.context
    }
    // Only include `webSearch` when enabled: omitting the field keeps the
    // legacy request body intact when the feature is unused.
    if (options?.webSearch) {
      requestBody.webSearch = options.webSearch
    }

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: options?.signal,
    })

    if (!response.ok) {
      // The request was cancelled while reading the error body: preserve
      // cancellation rather than surfacing a spurious error.
      if (options?.signal?.aborted) {
        callbacks.onStopped()
        return
      }
      // HTTP error received before the stream started (e.g. validation,
      // context budget, provider failure). Normalize the shared contract.
      callbacks.onError(await parseApiError(response))
      return
    }

    if (!response.body) {
      // Response was OK but carried no stream; treat as an unknown failure.
      callbacks.onError(toUnknownError())
      return
    }

    reader = response.body.getReader()
    const decoder = new TextDecoder()
    // The event under construction belongs to the whole stream, not to one read:
    // a chunk boundary may fall between the `event:` and `data:` lines, and the
    // event type has to survive until its data line completes it.
    let currentEvent:
      | { type: "start" | "delta" | "done" | "error" | "tool_start" | "tool_end" | "sources"; data: string }
      | null = null
    while (true) {
      const { done, value } = await reader.read()

      if (done) {
        // If the stream was aborted, treat it as stopped
        if (options?.signal?.aborted) {
          callbacks.onStopped()
        } else if (completed) {
          // Terminal completion already handled by a `done` event above.
          break
        } else {
          // Normal EOF without [DONE] — treat as done
          completed = true
          callbacks.onDone()
        }
        break
      }

      buffer += decoder.decode(value, { stream: true })

      // Process complete SSE events from buffer
      const lines = buffer.split("\n")
      buffer = lines.pop() || "" // Keep incomplete last line in buffer

      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.startsWith("event: ")) {
          const eventType = trimmed.slice(7).trim() as "start" | "delta" | "done" | "error" | "tool_start" | "tool_end" | "sources"
          currentEvent = { type: eventType, data: "" }
        } else if (trimmed.startsWith("data: ")) {
          const data = trimmed.slice(6)
          if (currentEvent) {
            currentEvent.data = data
            // Dispatch the event and let a terminal (done) event mark the
            // stream as completed within streamChat's scope.
            completed = dispatchEvent(currentEvent, callbacks)
            currentEvent = null
          }
          // If there's no currentEvent, this is an unexpected "data:" line
          // without a preceding "event:" — log and skip
        } else if (currentEvent) {
          // Unexpected line inside an event block — ignore it
          // This handles malformed SSE gracefully
        }
        // Lines that don't match any pattern and aren't inside an event block are also ignored
      }
    }
  } catch (err) {
    if (options?.signal?.aborted || err instanceof DOMException && err.name === "AbortError") {
      // User cancellation (Stop / New conversation): silent, never an error.
      // Clean up buffer on abort
      buffer = ""
      callbacks.onStopped()
      return
    }

    // A fetch/stream failure before receiving a normalized HTTP/SSE response is
    // a client-side network failure, not a provider error.
    callbacks.onError(toNetworkError())
  } finally {
    reader?.releaseLock()
  }
}

function dispatchEvent(
  event: { type: "start" | "delta" | "done" | "error" | "tool_start" | "tool_end" | "sources"; data: string },
  callbacks: StreamCallbacks,
): boolean {
  try {
    const parsed = JSON.parse(event.data) as {
      model?: string
      text?: string
      message?: string
      context?: ContextTruncationMetadata
      name?: string
      query?: string
      resultCount?: number
      sources?: unknown
    }

    switch (event.type) {
      case "start":
        callbacks.onStart(parsed.model ?? "", parsed.context)
        break
      case "delta":
        if (parsed.text !== undefined) {
          callbacks.onDelta(parsed.text)
        } else {
          // Delta without text — skip silently
        }
        break
      case "done":
        callbacks.onDone()
        return true
      case "error": {
        // Mid-stream provider error carrying the stable backend code.
        callbacks.onError(parseStreamErrorData(parsed))
        break
      }
      case "tool_start": {
        // Optional callback: ignore when the UI does not observe tool events.
        if (callbacks.onToolStart && typeof parsed.name === "string") {
          callbacks.onToolStart({
            name: parsed.name,
            ...(typeof parsed.query === "string" ? { query: parsed.query } : {}),
          })
        }
        break
      }
      case "tool_end": {
        if (callbacks.onToolEnd && typeof parsed.name === "string") {
          callbacks.onToolEnd({
            name: parsed.name,
            resultCount: typeof parsed.resultCount === "number" ? parsed.resultCount : 0,
          })
        }
        break
      }
      case "sources": {
        // Defensive re-validation: the backend already sanitizes, but the
        // parser drops anything that is not a safe { id, title, url } entry.
        if (callbacks.onSources) {
          callbacks.onSources(sanitizeSourcesForDisplay(parsed.sources))
        }
        break
      }
    }
    // Non-terminal event.
    return false
  } catch {
    // Malformed JSON — log and skip without crashing
    // This ensures malformed events don't break the stream consumer
    return false
  }
}

/**
 * True only for non-empty `http:`/`https:` URLs without userinfo credentials.
 *
 * Parses the value so a URL carrying credentials (e.g. `https://user:token@`)
 * is rejected (CWE-200) — the same guard the backend applies on `sources`.
 */
export function isValidSourceUrl(url: unknown): url is string {
  if (typeof url !== "string") {
    return false
  }

  const trimmed = url.trim()
  if (trimmed.length === 0) {
    return false
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return false
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false
  }

  // Reject credential-bearing URLs so source metadata never leaks userinfo.
  return !parsed.username && !parsed.password
}

/**
/** Re-validate a parsed `sources` payload on the client. Mirrors the backend
 * sanitizer: keeps only entries with a numeric id and a safe URL, and never
 * forwards `content`/snippets. Unknown or malformed input yields an empty list.
 */
export function sanitizeSourcesForDisplay(sources: unknown): WebSearchSource[] {
  if (!Array.isArray(sources)) {
    return []
  }

  const out: WebSearchSource[] = []
  for (const entry of sources) {
    if (!entry || typeof entry !== "object") {
      continue
    }
    const { id, title, url } = entry as { id?: unknown; title?: unknown; url?: unknown }
    if (typeof id !== "number" || !Number.isFinite(id) || !isValidSourceUrl(url)) {
      continue
    }
    out.push({ id, title: typeof title === "string" ? title : "", url: url.trim() })
  }
  return out
}

export async function chat(
  messages: ChatMessage[],
  provider: ChatProviderConfig,
): Promise<ChatResponse> {
  const apiUrl = `${API_BASE}/api/chat`
  let response: Response
  try {
    response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, provider }),
    })
  } catch {
    // fetch() rejected before producing a Response (network failure): normalize
    // into the shared contract instead of rejecting the promise.
    return { success: false, error: toNetworkError() }
  }

  if (!response.ok) {
    // Normalize non-streaming HTTP errors through the shared parser.
    return { success: false, error: await parseApiError(response) }
  }

  try {
    return await response.json()
  } catch {
    // 2xx response with an empty/malformed body is a decoding failure, not a
    // network failure: classify it as unknown.
    return { success: false, error: toUnknownError() }
  }
}
