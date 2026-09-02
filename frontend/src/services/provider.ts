import { parseApiError } from "../utils/parseApiError"

const API_BASE = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:3000";

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
    // Normalize the shared backend contract into a FrontendApiError.
    // Provider Settings keeps its own local status/message UI and reads
    // `error.message` from the caught error.
    throw await parseApiError(response)
  }

  return response.json()
}
