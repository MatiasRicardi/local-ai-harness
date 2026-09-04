import { parseApiError, toNetworkError, toUnknownError } from "../utils/parseApiError"

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
  let response: Response
  try {
    response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  } catch {
    // fetch() rejected before producing a Response (network failure).
    throw toNetworkError()
  }

  if (!response.ok) {
    // Normalize the shared backend contract into a FrontendApiError.
    // Provider Settings keeps its own local status/message UI and reads
    // `error.message` from the caught error.
    throw await parseApiError(response)
  }

  try {
    return await response.json()
  } catch {
    // 2xx response with an empty/malformed body is a decoding failure, not a
    // network failure: classify it as unknown.
    throw toUnknownError()
  }
}
