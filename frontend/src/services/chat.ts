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

export async function chat(
  messages: ChatMessage[],
  provider: ChatProviderConfig,
): Promise<ChatResponse> {
  const config = provider

  const apiUrl = `${API_BASE}/api/chat`
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, provider: config }),
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Unknown error" }))
    return { success: false, error: error.error || "Failed to send message" }
  }

  return response.json()
}
