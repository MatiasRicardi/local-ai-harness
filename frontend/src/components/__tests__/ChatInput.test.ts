import { describe, it, expect, vi, afterEach } from "vitest"
import { mount, type VueWrapper } from "@vue/test-utils"
import ChatInput from "../ChatInput.vue"

function textarea(wrapper: VueWrapper): HTMLTextAreaElement {
  return wrapper.find(".chat-input-textarea").element as HTMLTextAreaElement
}

describe("ChatInput", () => {
  let wrapper: VueWrapper

  afterEach(() => {
    wrapper.unmount()
  })

  it("emits send with the trimmed message and clears the draft", async () => {
    const onSend = vi.fn()
    wrapper = mount(ChatInput, {
      props: { onSend },
    })

    await wrapper.find(".chat-input-textarea").setValue("  Hello world  ")
    await wrapper.find("button.chat-input-send").trigger("click")

    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend).toHaveBeenCalledWith("Hello world")
    expect(textarea(wrapper).value).toBe("")
  })

  it("sends on Enter", async () => {
    const onSend = vi.fn()
    wrapper = mount(ChatInput, { props: { onSend } })

    await wrapper.find(".chat-input-textarea").setValue("go")
    await wrapper.find(".chat-input-textarea").trigger("keydown", { key: "Enter" })

    expect(onSend).toHaveBeenCalledWith("go")
  })

  it("disables the input and swaps the send button for stop while sending", () => {
    wrapper = mount(ChatInput, { props: { onSend: vi.fn(), sending: true } })
    expect(textarea(wrapper).disabled).toBe(true)
    expect(wrapper.find("button.chat-input-send").exists()).toBe(false)
  })

  it("shows the stop action while sending and emits stop", async () => {
    wrapper = mount(ChatInput, { props: { onSend: vi.fn(), sending: true } })

    expect(wrapper.find("button.chat-input-send").exists()).toBe(false)
    expect(wrapper.find("button.chat-input-stop").exists()).toBe(true)

    await wrapper.find("button.chat-input-stop").trigger("click")
    expect(wrapper.emitted("stop")).toHaveLength(1)
  })

  it("clears the draft when the parent increments the reset key", async () => {
    const onSend = vi.fn()
    wrapper = mount(ChatInput, { props: { onSend, resetKey: 1 } })
    await wrapper.find(".chat-input-textarea").setValue("unsent")
    expect(textarea(wrapper).value).toBe("unsent")

    await wrapper.setProps({ resetKey: 2 })
    expect(textarea(wrapper).value).toBe("")
  })
})
