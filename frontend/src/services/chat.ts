import type { FrontendApiError } from "../types/error"
import { parseApiError, parseStreamErrorData, toNetworkError, toUnknownError } from "../utils/parseApiError"

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

const API_BASE = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:3000";

export interface ContextTruncationMetadata {
  documentTruncated: boolean
  originalDocumentCharacters: number
  includedDocumentCharacters: number
  estimatedOriginalDocumentTokens: number
  estimatedIncludedDocumentTokens: number
}

export interface StreamEvent {
  type: "start" | "delta" | "done" | "error"
  data: {
    model?: string
    text?: string
    message?: string
    // Stable backend error code (Step 21.2), present on `error` events.
    code?: string
    detail?: string
    context?: ContextTruncationMetadata
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
}

export async function streamChat(
  messages: ChatMessage[],
  provider: ChatProviderConfig,
  callbacks: StreamCallbacks,
  options?: {
    signal?: AbortSignal
    document?: ChatDocumentContext
    context?: ChatContext
  },
): Promise<void> {
  const apiUrl = `${API_BASE}/api/chat/stream`

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let buffer = ""

  try {
    const requestBody: Record<string, unknown> = { messages, provider }
    if (options?.document) {
      requestBody.document = options.document
    }
    if (options?.context) {
      requestBody.context = options.context
    }

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: options?.signal,
    })

    if (!response.ok) {
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
    while (true) {
      const { done, value } = await reader.read()

      if (done) {
        // If the stream was aborted, treat it as stopped
        if (options?.signal?.aborted) {
          callbacks.onStopped()
        } else {
          // Normal EOF without [DONE] — treat as done
          callbacks.onDone()
        }
        break
      }

      buffer += decoder.decode(value, { stream: true })

      // Process complete SSE events from buffer
      const lines = buffer.split("\n")
      buffer = lines.pop() || "" // Keep incomplete last line in buffer

      let currentEvent: { type: "start" | "delta" | "done" | "error"; data: string } | null = null

      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.startsWith("event: ")) {
          const eventType = trimmed.slice(7).trim() as "start" | "delta" | "done" | "error"
          currentEvent = { type: eventType, data: "" }
        } else if (trimmed.startsWith("data: ")) {
          const data = trimmed.slice(6)
          if (currentEvent) {
            currentEvent.data = data
            // Dispatch the event
            dispatchEvent(currentEvent, callbacks)
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
  event: { type: "start" | "delta" | "done" | "error"; data: string },
  callbacks: StreamCallbacks,
): void {
  try {
    const parsed = JSON.parse(event.data) as {
      model?: string
      text?: string
      message?: string
      context?: ContextTruncationMetadata
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
        break
      case "error": {
        // Mid-stream provider error carrying the stable backend code.
        callbacks.onError(parseStreamErrorData(parsed))
        break
      }
    }
  } catch {
    // Malformed JSON — log and skip without crashing
    // This ensures malformed events don't break the stream consumer
  }
}

export async function chat(
  messages: ChatMessage[],
  provider: ChatProviderConfig,
): Promise<ChatResponse> {
  const apiUrl = `${API_BASE}/api/chat`
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, provider }),
  })

  if (!response.ok) {
    // Normalize non-streaming HTTP errors through the shared parser.
    return { success: false, error: await parseApiError(response) }
  }

  return response.json()
}
