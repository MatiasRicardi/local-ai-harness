import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { testProviderConnection } from "../provider"
import { FrontendApiError } from "../../types/error"

// Mirrors the service default without hard-coding the CI-provided base URL.
const API_BASE = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:3000"

describe("testProviderConnection", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("posts to the provider test endpoint and returns the connection response", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, model: "local-model" }),
    } as unknown as Response)

    const result = await testProviderConnection({
      baseUrl: "http://localhost:8080/v1",
      model: "local-model",
    })

    expect(result).toEqual({ success: true, model: "local-model" })
    expect(fetch).toHaveBeenCalledWith(
      `${API_BASE}/api/provider/test`,
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    )
  })

  it("throws a FrontendApiError carrying the backend error code", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      json: async () => ({
        error: { code: "PROVIDER_UNREACHABLE", message: "Model not found" },
      }),
    } as unknown as Response)

    let error: FrontendApiError | undefined
    try {
      await testProviderConnection({
        baseUrl: "http://localhost:8080/v1",
        model: "missing",
      })
    } catch (thrown) {
      error = thrown as FrontendApiError
    }

    expect(error).toBeInstanceOf(FrontendApiError)
    expect(error?.code).toBe("PROVIDER_UNREACHABLE")
    expect(error?.message).toBe("Model not found")
  })

  it("wraps a network failure as a NETWORK_ERROR", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("Failed to fetch"))

    let error: FrontendApiError | undefined
    try {
      await testProviderConnection({
        baseUrl: "http://localhost:8080/v1",
        model: "local-model",
      })
    } catch (thrown) {
      error = thrown as FrontendApiError
    }

    expect(error).toBeInstanceOf(FrontendApiError)
    expect(error?.code).toBe("NETWORK_ERROR")
    expect(error?.message).toBe(
      "Unable to reach the local backend. Check that it is running and try again.",
    )
  })
})
