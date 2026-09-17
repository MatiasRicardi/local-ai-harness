import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest"
import { mount, type VueWrapper } from "@vue/test-utils"
import { nextTick } from "vue"
import App from "../App.vue"
import { getProviderSettings, updateProviderSettings } from "../composables/useProviderSettings"
import { useWebSearchSettings } from "../composables/useWebSearchSettings"
import type { WebSearchRequestConfig } from "../services/chat"
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

vi.mock("../services/chat", async (importOriginal) => {
  // Reuse the real helpers (e.g. `buildWebSearchPayload`); only the network
  // entry point is stubbed so tests can inspect the request contract.
  const actual = await importOriginal<typeof import("../services/chat")>()
  return {
    ...actual,
    streamChat: async (...args: unknown[]) => {
      hoisted.calls.push(args)
      hoisted.callbacks = args[2] as Record<string, (...args: unknown[]) => void>
    },
  }
})

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
    webSearch?: WebSearchRequestConfig
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
    // Reset the web-search singleton, which persists across tests in the file.
    useWebSearchSettings().updateWebSearchSettings({
      enabled: false,
      apiKey: "",
      searchDepth: "basic",
      maxResults: 5,
    })
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

  describe("web search settings", () => {
    it("sends the exact tavily payload when enabled with a key", async () => {
      useWebSearchSettings().updateWebSearchSettings({
        enabled: true,
        apiKey: "tly-abc",
        searchDepth: "advanced",
        maxResults: 4,
      })
      wrapper = mountApp()

      await sendMessage(wrapper, "with search")

      const [, , , options] = streamCall()
      expect(options.webSearch).toEqual({
        enabled: true,
        provider: "tavily",
        apiKey: "tly-abc",
        searchDepth: "advanced",
        maxResults: 4,
      })
    })

    it("omits web search entirely when disabled (default)", async () => {
      useWebSearchSettings().updateWebSearchSettings({ enabled: false })
      wrapper = mountApp()

      await sendMessage(wrapper, "no search")

      const [, , , options] = streamCall()
      expect(options.webSearch).toBeUndefined()
    })

    it("blocks the send when web search is enabled without a key", async () => {
      useWebSearchSettings().updateWebSearchSettings({ enabled: true })
      wrapper = mountApp()

      await sendMessage(wrapper, "blocked")

      // Nothing is sent: the user message is not even queued.
      expect(hoisted.calls).toHaveLength(0)
    })

    it("keeps web search settings across a New Conversation reset", async () => {
      useWebSearchSettings().updateWebSearchSettings({
        enabled: true,
        apiKey: "tly-abc",
        searchDepth: "basic",
        maxResults: 3,
      })
      wrapper = mountApp()

      await sendMessage(wrapper, "first")
      const firstOptions = streamCall()[3]

      hoisted.callbacks.onStart("m", {})
      hoisted.callbacks.onDone("m", {}, {})
      await nextTick()

      await wrapper
        .find("button[aria-label='Start a new conversation']")
        .trigger("click")
      await nextTick()

      await sendMessage(wrapper, "second")
      const secondOptions = streamCall()[3]

      expect(firstOptions.webSearch).toEqual(secondOptions.webSearch)
      expect(secondOptions.webSearch).toEqual({
        enabled: true,
        provider: "tavily",
        apiKey: "tly-abc",
        searchDepth: "basic",
        maxResults: 3,
      })
    })
  })

  describe("web search activity & sources", () => {
    it("shows searching activity during tool_start and returns to generating", async () => {
      useWebSearchSettings().updateWebSearchSettings({
        enabled: true,
        apiKey: "tly-abc",
        searchDepth: "basic",
        maxResults: 4,
      })
      wrapper = mountApp()

      await sendMessage(wrapper, "with search")
      hoisted.callbacks.onStart("m", undefined)
      await nextTick()

      // tool_start temporarily replaces "Generating…" with the search line.
      hoisted.callbacks.onToolStart({ name: "web_search" })
      await nextTick()
      expect(wrapper.find(".loading").text()).toContain("Searching the web…")

      // tool_end transitions back to the normal generating state.
      hoisted.callbacks.onToolEnd({ name: "web_search", resultCount: 2 })
      await nextTick()
      expect(wrapper.find(".loading").text()).toContain("Generating...")

      // First delta renders the assistant answer.
      hoisted.callbacks.onDelta("Answer")
      await nextTick()
      expect(wrapper.find(".message-assistant").text()).toContain("Answer")
    })

    it("attaches backend sources to the correct assistant turn", async () => {
      useWebSearchSettings().updateWebSearchSettings({
        enabled: true,
        apiKey: "tly-abc",
        searchDepth: "basic",
        maxResults: 4,
      })
      wrapper = mountApp()

      await sendMessage(wrapper, "with search")
      hoisted.callbacks.onStart("m", undefined)
      await nextTick()
      hoisted.callbacks.onToolStart({ name: "web_search" })
      hoisted.callbacks.onToolEnd({ name: "web_search", resultCount: 2 })
      await nextTick()

      hoisted.callbacks.onSources([
        { id: 1, title: "MDN: Array", url: "https://developer.mozilla.org/en/docs/Array" },
        { id: 2, title: "Example", url: "https://example.com/page" },
      ])
      await nextTick()

      const sourcesBlock = wrapper.find(".message-assistant .sources")
      expect(sourcesBlock.exists()).toBe(true)
      expect(sourcesBlock.text()).toContain("Sources")
      expect(sourcesBlock.text()).toContain("MDN: Array")
      expect(sourcesBlock.text()).toContain("example.com")

      const links = sourcesBlock.findAll("a")
      expect(links).toHaveLength(2)
      expect(links[0].attributes("href")).toBe(
        "https://developer.mozilla.org/en/docs/Array",
      )
      expect(links[0].attributes("target")).toBe("_blank")
      expect(links[0].attributes("rel")).toBe("noopener noreferrer")
    })

    it("renders no sources section when the turn did not search", async () => {
      wrapper = mountApp()
      await sendMessage(wrapper, "no search")

      hoisted.callbacks.onStart("m", undefined)
      hoisted.callbacks.onDelta("plain answer")
      hoisted.callbacks.onDone()
      await nextTick()

      expect(wrapper.find(".sources").exists()).toBe(false)
      expect(wrapper.find(".message-assistant").text()).toContain("plain answer")
    })

    it("escapes source titles (rendered as text, never v-html)", async () => {
      useWebSearchSettings().updateWebSearchSettings({
        enabled: true,
        apiKey: "tly-abc",
        searchDepth: "basic",
        maxResults: 4,
      })
      wrapper = mountApp()

      await sendMessage(wrapper, "with search")
      hoisted.callbacks.onStart("m", undefined)
      await nextTick()

      hoisted.callbacks.onSources([
        { id: 1, title: "<img src=x onerror=alert(1)", url: "https://example.com" },
      ])
      await nextTick()

      const sourcesBlock = wrapper.find(".message-assistant .sources")
      // The title is present as escaped text, not as an <img> element.
      expect(sourcesBlock.html()).not.toContain("<img")
      expect(sourcesBlock.text()).toContain("<img src=x onerror=alert(1)")
    })

    it("ignores unsafe source URLs", async () => {
      useWebSearchSettings().updateWebSearchSettings({
        enabled: true,
        apiKey: "tly-abc",
        searchDepth: "basic",
        maxResults: 4,
      })
      wrapper = mountApp()

      await sendMessage(wrapper, "with search")
      hoisted.callbacks.onStart("m", undefined)
      await nextTick()

      hoisted.callbacks.onSources([
        { id: 1, title: "Safe", url: "https://safe.example" },
        { id: 2, title: "Data URI", url: "data:text/html,<script>alert(1)</script>" },
        { id: 3, title: "No Protocol", url: "//evil.example" },
      ])
      await nextTick()

      const sourcesBlock = wrapper.find(".message-assistant .sources")
      const links = sourcesBlock.findAll("a")
      expect(links).toHaveLength(1)
      expect(links[0].attributes("href")).toBe("https://safe.example")
    })

    it("clears sources and activity on reset", async () => {
      useWebSearchSettings().updateWebSearchSettings({
        enabled: true,
        apiKey: "tly-abc",
        searchDepth: "basic",
        maxResults: 4,
      })
      wrapper = mountApp()

      await sendMessage(wrapper, "with search")
      hoisted.callbacks.onStart("m", undefined)
      await nextTick()
      hoisted.callbacks.onSources([
        { id: 1, title: "Source", url: "https://example.com" },
      ])
      await nextTick()
      expect(wrapper.find(".sources").exists()).toBe(true)

      await wrapper.find("button[aria-label='Start a new conversation']").trigger("click")
      await nextTick()

      expect(wrapper.find(".sources").exists()).toBe(false)
    })

    it("shows no sources block when the search is cancelled mid-run", async () => {
      useWebSearchSettings().updateWebSearchSettings({
        enabled: true,
        apiKey: "tly-abc",
        searchDepth: "basic",
        maxResults: 4,
      })
      wrapper = mountApp()

      await sendMessage(wrapper, "with search")
      hoisted.callbacks.onStart("m", undefined)
      await nextTick()
      hoisted.callbacks.onToolStart({ name: "web_search" })
      await nextTick()
      expect(wrapper.find(".loading").text()).toContain("Searching the web…")

      // User cancels: the aborted stream invokes onStopped, which runs cleanup
      // (clears the transient activity). No sources are produced for a cancelled
      // search, so no sources block must appear.
      hoisted.callbacks.onStopped()
      await nextTick()

      expect(wrapper.find(".sources").exists()).toBe(false)
      expect(wrapper.find(".loading").exists()).toBe(false)
    })
  })
})
