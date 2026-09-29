import { describe, it, expect, afterEach } from "vitest"
import { mount, type VueWrapper } from "@vue/test-utils"
import App from "../App.vue"
import { STORAGE_KEY, updateProviderSettings } from "../composables/useProviderSettings"

// Presentation wiring only (the request-contract behaviour lives in App.test.ts):
// the header, the welcome state and the composer must agree through App.vue,
// because the composer draft stays private to ChatInput.
describe("App shell", () => {
  let wrapper: VueWrapper

  function draftValue(): string {
    return (wrapper.find(".chat-input-textarea").element as HTMLTextAreaElement).value
  }

  function mountApp(): VueWrapper {
    updateProviderSettings({
      name: "dev",
      baseUrl: "http://127.0.0.1:8080/v1",
      model: "qwen2.5-coder",
      contextSizeTokens: 32768,
      apiKey: "",
      timeout: 30,
    })
    // Mounted into the document so the composer textarea behaves like real UI.
    return mount(App, { attachTo: document.body })
  }

  afterEach(() => {
    wrapper?.unmount()
    localStorage.removeItem(STORAGE_KEY)
  })

  it("shows the configured endpoint in the header and the welcome state in the canvas", () => {
    wrapper = mountApp()

    const header = wrapper.find(".app-header")
    expect(header.exists()).toBe(true)
    expect(header.text()).toContain("qwen2.5-coder")
    expect(header.text()).toContain("127.0.0.1:8080")

    // The welcome state replaces an empty transcript; it is not a message.
    expect(wrapper.find(".chat-empty-state").exists()).toBe(true)
    expect(wrapper.find(".message-assistant").exists()).toBe(false)
    expect(wrapper.find(".chat-input-textarea").exists()).toBe(true)
  })

  it("keeps the welcome state until a message is sent, then clears a typed draft on New Chat", async () => {
    wrapper = mountApp()

    // No suggestion cards exist anymore; the composer starts empty.
    expect(wrapper.find(".chat-empty-suggestion").exists()).toBe(false)
    expect(wrapper.find(".chat-empty-state").exists()).toBe(true)
    expect(draftValue()).toBe("")

    await wrapper.find(".chat-input-textarea").setValue("Hello there")
    expect(draftValue()).toContain("Hello there")
    // Nothing was sent, so the welcome state is still there.
    expect(wrapper.find(".chat-empty-state").exists()).toBe(true)

    await wrapper.find('[aria-label="Start a new conversation"]').trigger("click")
    expect(draftValue()).toBe("")
    expect(wrapper.find(".chat-empty-state").exists()).toBe(true)
  })
})
