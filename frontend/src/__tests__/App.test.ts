import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest"
import { mount, type VueWrapper } from "@vue/test-utils"
import { nextTick } from "vue"
import App from "../App.vue"
import { getProviderSettings, updateProviderSettings } from "../composables/useProviderSettings"
import { uploadDocument } from "../services/files"
import { FrontendApiError } from "../types/error"
import { selectFile, stubFileInputValueSetter, flushPromises } from "./test-utils"

function textarea(wrapper: VueWrapper): HTMLTextAreaElement {
  return wrapper.find(".chat-input-textarea").element as HTMLTextAreaElement
}

// Captured by the mocked streamChat so tests can inspect the request contract
// and drive the stream deterministically (no network, no timers).
const hoisted = vi.hoisted(() => ({
  callbacks: null as unknown as Record<string, (...args: unknown[]) => void>,
  calls: [] as unknown[][],
}))

vi.mock("../services/chat", () => ({
  streamChat: async (...args: unknown[]) => {
    hoisted.calls.push(args)
    hoisted.callbacks = args[2] as Record<string, (...args: unknown[]) => void>
  },
}))

// Only the network call is stubbed; the real extension rules are reused so the
// mocks cannot drift from `isSupportedExtension`.
vi.mock("../services/files", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/files")>()
  return { ...actual, uploadDocument: vi.fn() }
})

/** Shape of the streamChat() arguments asserted by these tests. */
type StreamCall = [
  messages: Array<{ role: string; content: string }>,
  provider: { baseUrl: string; model: string; apiKey?: string; timeoutMs: number },
  callbacks: unknown,
  options: {
    signal: AbortSignal
    document?: { fileId: string; filename: string; text: string }
    context?: { maxTokens: number }
  },
]

function streamCall(index = 0): StreamCall {
  const call = hoisted.calls[index]
  if (!call) {
    throw new Error(`streamChat() was not called ${index + 1} time(s)`)
  }
  return call as unknown as StreamCall
}

/** Wire-relevant fields only (stored messages also carry internal ids). */
function roleAndContent(messages: Array<{ role: string; content: string }>) {
  return messages.map(({ role, content }) => ({ role, content }))
}

const originalConfirm = Object.getOwnPropertyDescriptor(window, "confirm")

const PROVIDER = {
  name: "llama.cpp",
  baseUrl: "http://localhost:8080/v1",
  model: "local-model",
  contextSizeTokens: 32768,
  apiKey: "",
  timeout: 120,
}

function mountApp(): VueWrapper {
  return mount(App)
}

async function sendMessage(wrapper: VueWrapper, text: string): Promise<void> {
  await wrapper.find(".chat-input-textarea").setValue(text)
  await wrapper.find("button.chat-input-send").trigger("click")
  await nextTick()
}

describe("App integration", () => {
  let wrapper: VueWrapper

  let confirmMock: Mock

  beforeEach(() => {
    localStorage.clear()
    confirmMock = vi.fn(() => true)
    Object.defineProperty(window, "confirm", {
      value: confirmMock,
      configurable: true,
      writable: true,
    })
    updateProviderSettings({ ...PROVIDER })
    hoisted.callbacks = {} as Record<string, (...args: unknown[]) => void>
    hoisted.calls = []
    stubFileInputValueSetter()
  })

  afterEach(() => {
    wrapper?.unmount()
    vi.restoreAllMocks()
    // Hand back the original jsdom implementation instead of `undefined`.
    if (originalConfirm) {
      Object.defineProperty(window, "confirm", originalConfirm)
    } else {
      Reflect.deleteProperty(window, "confirm")
    }
  })

  it("streams a response into the message list", async () => {
    wrapper = mountApp()

    await sendMessage(wrapper, "Hello")

    expect(wrapper.find(".message-user").text()).toContain("Hello")
    expect(wrapper.find(".loading").exists()).toBe(true)

    hoisted.callbacks.onStart("custom-model", undefined)
    await nextTick()
    expect(wrapper.find(".message-assistant").exists()).toBe(true)

    hoisted.callbacks.onDelta("Hi ")
    await nextTick()
    hoisted.callbacks.onDelta("there")
    await nextTick()
    expect(
      wrapper.find(".message-assistant .message-content").text(),
    ).toContain("Hi there")

    hoisted.callbacks.onDone()
    await nextTick()
    expect(wrapper.find(".loading").exists()).toBe(false)
    expect(wrapper.find(".error").exists()).toBe(false)
  })

  it("sends the current messages, provider settings, document and context to streamChat", async () => {
    updateProviderSettings({
      baseUrl: "http://example.com/v1",
      model: "custom-model",
      apiKey: "",
      timeout: 90,
      contextSizeTokens: 8192,
    })
    vi.mocked(uploadDocument).mockResolvedValue({
      fileId: "file-1",
      originalFilename: "notes.txt",
      size: 11,
      type: "text/plain",
      text: "hello world",
      characterCount: 11,
      warnings: [],
      pageCount: undefined,
    })
    wrapper = mountApp()

    selectFile(wrapper, new File(["hello world"], "notes.txt", { type: "text/plain" }))
    await flushPromises()

    await sendMessage(wrapper, "  summarize this  ")

    const [messages, provider, , options] = streamCall()

    // Trimmed user message only: the attached document travels as structured
    // context, never as a visible prompt line.
    expect(roleAndContent(messages)).toEqual([
      { role: "user", content: "summarize this" },
    ])

    expect(provider.baseUrl).toBe("http://example.com/v1")
    expect(provider.model).toBe("custom-model")
    // Settings store seconds, the service contract is milliseconds.
    expect(provider.timeoutMs).toBe(90_000)
    // An unset API key is normalized away instead of sent as "".
    expect(provider.apiKey).toBeUndefined()

    expect(options.signal).toBeInstanceOf(AbortSignal)
    expect(options.document).toEqual({
      fileId: "file-1",
      filename: "notes.txt",
      text: "hello world",
    })
    expect(options.context).toEqual({ maxTokens: 8192 })

    // A second request carries the accumulated conversation.
    hoisted.callbacks.onStart("custom-model", undefined)
    hoisted.callbacks.onDelta("An answer.")
    hoisted.callbacks.onDone()
    await nextTick()

    await sendMessage(wrapper, "and this?")

    expect(roleAndContent(streamCall(1)[0])).toEqual([
      { role: "user", content: "summarize this" },
      { role: "assistant", content: "An answer." },
      { role: "user", content: "and this?" },
    ])
  })

  it("cancels a generation and reports it as stopped", async () => {
    wrapper = mountApp()
    await sendMessage(wrapper, "Hello")

    hoisted.callbacks.onStart("m", undefined)
    await nextTick()
    hoisted.callbacks.onDelta("partial")
    await nextTick()

    await wrapper.find("button.chat-input-stop").trigger("click")
    await nextTick()
    // Stop aborts the in-flight request itself, not just the UI state.
    expect(streamCall()[3].signal.aborted).toBe(true)
    // The stop action marks the generation stopped while it is still in flight.
    expect(wrapper.find(".stopped").text()).toContain("Generation stopped")

    hoisted.callbacks.onStopped()
    await nextTick()
    expect(wrapper.find(".loading").exists()).toBe(false)
    expect(wrapper.find(".error").exists()).toBe(false)
    // The aborted assistant message keeps its stopped indicator.
    expect(wrapper.find(".message-stopped .message-stopped-indicator").text()).toBe(
      "Stopped",
    )
  })

  it("ignores callbacks from a generation after a reset", async () => {
    wrapper = mountApp()
    await sendMessage(wrapper, "Hello")

    hoisted.callbacks.onStart("m", undefined)
    await nextTick()
    hoisted.callbacks.onDelta("late")
    await nextTick()

    // Reset the conversation.
    await wrapper.find("button[aria-label='Start a new conversation']").trigger("click")
    await nextTick()

    // A late delta from the previous generation must be ignored.
    hoisted.callbacks.onDelta("should not appear")
    await nextTick()
    expect(wrapper.find(".message-assistant").exists()).toBe(false)
  })

  it("clears transient state on reset while preserving provider settings", async () => {
    updateProviderSettings({ baseUrl: "http://example.com/v1", model: "custom-model" })
    wrapper = mountApp()

    // Start a meaningful conversation.
    await sendMessage(wrapper, "Hi")
    hoisted.callbacks.onStart("m", undefined)
    hoisted.callbacks.onDone()
    await nextTick()

    // Attach a document (mocked upload).
    vi.mocked(uploadDocument).mockResolvedValue({
      fileId: "file-1",
      originalFilename: "notes.txt",
      size: 11,
      type: "text/plain",
      text: "hello world",
      characterCount: 11,
      warnings: [],
      pageCount: undefined,
    })
    selectFile(wrapper, new File(["hello world"], "notes.txt", { type: "text/plain" }))
    await flushPromises()
    await nextTick()
    expect(wrapper.find(".document-attachment-meta").exists()).toBe(true)

    // Set a chat error.
    hoisted.callbacks.onError(
      new FrontendApiError({ code: "CONTEXT_TOO_LARGE", message: "Prompt tokens exceed the limit." }),
    )
    await nextTick()
    expect(wrapper.find(".error").exists()).toBe(true)

    // Reset.
    await wrapper.find("button[aria-label='Start a new conversation']").trigger("click")
    await nextTick()

    expect(wrapper.find(".message-user").exists()).toBe(false)
    expect(wrapper.find(".message-assistant").exists()).toBe(false)
    expect(wrapper.find(".error").exists()).toBe(false)
    expect(wrapper.find(".attachment-error").exists()).toBe(false)
    expect(wrapper.find(".document-attachment-meta").exists()).toBe(false)
    expect(textarea(wrapper).value).toBe("")

    // Provider settings survive the reset.
    expect(getProviderSettings().value.baseUrl).toBe("http://example.com/v1")
    expect(getProviderSettings().value.model).toBe("custom-model")
  })

  it("places a chat error in the chat area only", async () => {
    wrapper = mountApp()
    await sendMessage(wrapper, "Hello")

    hoisted.callbacks.onError(
      new FrontendApiError({ code: "PROVIDER_TIMEOUT", message: "Slow down, please." }),
    )
    await nextTick()

    expect(wrapper.find(".error").text()).toContain("Slow down, please.")
    expect(wrapper.find(".attachment-error").exists()).toBe(false)
  })

  it("places an upload error in the attachment area only", async () => {
    wrapper = mountApp()
    vi.mocked(uploadDocument).mockRejectedValue(
      new FrontendApiError({ code: "FILE_UPLOAD_ERROR", message: "The file could not be uploaded." }),
    )

    selectFile(wrapper, new File(["x"], "notes.txt", { type: "text/plain" }))
    await flushPromises()
    await nextTick()

    expect(wrapper.find(".attachment-error").text()).toContain("The file could not be uploaded.")
    expect(wrapper.find(".error").exists()).toBe(false)
  })

  it("shows the document truncation warning without raising a chat error", async () => {
    wrapper = mountApp()
    await sendMessage(wrapper, "Hello")

    hoisted.callbacks.onStart("m", {
      documentTruncated: true,
      originalDocumentCharacters: 5000,
      includedDocumentCharacters: 1200,
      estimatedOriginalDocumentTokens: 2500,
      estimatedIncludedDocumentTokens: 600,
    })
    await nextTick()

    expect(wrapper.find(".document-context-warning").exists()).toBe(true)
    expect(wrapper.find(".document-context-warning").text()).toContain("truncated")
    expect(wrapper.find(".error").exists()).toBe(false)
  })
})
