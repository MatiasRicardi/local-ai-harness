export interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

export interface ChatRequest {
  messages: ChatMessage[]
  provider: {
    baseUrl: string
    model: string
    apiKey?: string
    timeoutMs: number
  }
}

export interface ChatResponse {
  success: boolean
  message?: ChatMessage
  model?: string
  finishReason?: string | null
  error?: string
}

export interface ChatProviderConfig {
  baseUrl: string
  model: string
  apiKey?: string
  timeoutMs: number
}

const API_BASE = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:3000";

export interface StreamEvent {
  type: "start" | "delta" | "done" | "error"
  data: {
    model?: string
    text?: string
    message?: string
  }
}

export interface StreamCallbacks {
  onStart: (model: string) => void
  onDelta: (text: string) => void
  onDone: () => void
  onStopped: () => void
  onError: (message: string) => void
}

export async function streamChat(
  messages: ChatMessage[],
  provider: ChatProviderConfig,
  callbacks: StreamCallbacks,
  options?: { signal?: AbortSignal },
): Promise<void> {
  const apiUrl = `${API_BASE}/api/chat/stream`

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let buffer = ""

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, provider }),
      signal: options?.signal,
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unknown error" }))
      callbacks.onError(error.error || "Failed to send message")
      return
    }

    if (!response.body) {
      callbacks.onError("Empty response body")
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
      // Clean up buffer on abort
      buffer = ""
      callbacks.onStopped()
      return
    }

    callbacks.onError(err instanceof Error ? err.message : "Stream read error")
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
    }

    switch (event.type) {
      case "start":
        callbacks.onStart(parsed.model ?? "")
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
      case "error":
        callbacks.onError(parsed.message ?? "Unknown error")
        break
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
    const error = await response.json().catch(() => ({ error: "Unknown error" }))
    return { success: false, error: error.error || "Failed to send message" }
  }

  return response.json()
}
