import { describe, it, expect, beforeEach, vi } from "vitest"
import { useConnectionTest } from "../useConnectionTest"
import { testProviderConnection, type ProviderTestResponse } from "../../services/provider"

vi.mock("../../services/provider", () => ({
  testProviderConnection: vi.fn(),
}))

const draft = {
  baseUrl: "http://localhost:8080",
  model: "tester",
  apiKey: undefined,
  timeout: 12,
}

describe("useConnectionTest", () => {
  // Module-level state on purpose: the header and the settings footer show the
  // same outcome, and these tests rely on that shared history.
  const { status, message, testing, runTest: runConnectionTest } = useConnectionTest()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("reports success and converts the configured seconds into ms", async () => {
    vi.mocked(testProviderConnection).mockResolvedValue({
      success: true,
      model: "connected-model",
      text: "Hi!",
    } satisfies ProviderTestResponse)

    await runConnectionTest(draft)

    expect(testProviderConnection).toHaveBeenCalledWith({
      baseUrl: draft.baseUrl,
      model: draft.model,
      apiKey: undefined,
      timeout: 12000,
    })
    expect(status.value).toBe("success")
    expect(message.value).toBe("Connected to connected-model")
    expect(testing.value).toBe(false)
  })

  it("reports the backend failure message", async () => {
    vi.mocked(testProviderConnection).mockResolvedValue({
      success: false,
      error: "Could not reach the provider",
    } satisfies ProviderTestResponse)

    await runConnectionTest(draft)

    expect(status.value).toBe("error")
    expect(message.value).toBe("Could not reach the provider")
  })

  it("falls back to a generic message when the failure carries none", async () => {
    vi.mocked(testProviderConnection).mockResolvedValue({ success: true } satisfies ProviderTestResponse)
    await runConnectionTest(draft)
    vi.mocked(testProviderConnection).mockResolvedValue({ success: false } satisfies ProviderTestResponse)

    await runConnectionTest(draft)

    expect(status.value).toBe("error")
    expect(message.value).toBe("Connection failed")
  })

  it("reports a thrown failure through its error message", async () => {
    vi.mocked(testProviderConnection).mockRejectedValue(new Error("socket hang up"))

    await runConnectionTest(draft)

    expect(status.value).toBe("error")
    expect(message.value).toBe("socket hang up")
  })

  it("does nothing until the endpoint and model are both filled in", async () => {
    const callsBefore = vi.mocked(testProviderConnection).mock.calls.length

    await runConnectionTest({ ...draft, baseUrl: "" })
    await runConnectionTest({ ...draft, model: "" })

    expect(vi.mocked(testProviderConnection).mock.calls.length).toBe(callsBefore)
    // The previous result stays visible instead of being cleared or faked.
    expect(status.value).toBe("error")
    expect(message.value).toBe("socket hang up")
  })
})
