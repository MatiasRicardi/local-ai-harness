const API_BASE = import.meta.env.VITE_API_URL ?? "";

export interface ProviderTestRequest {
  baseUrl: string
  model: string
  apiKey?: string
  timeout?: number
}

export interface ProviderTestResponse {
  success: boolean
  model?: string
  text?: string
  error?: string
}

export async function testProviderConnection(
  payload: ProviderTestRequest
): Promise<ProviderTestResponse> {
  const apiUrl = `${API_BASE}/api/provider/test`;
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Unknown error" }))
    return { success: false, error: error.error || "Failed to test connection" }
  }

  return response.json()
}
