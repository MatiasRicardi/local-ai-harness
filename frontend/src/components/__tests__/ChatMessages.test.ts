import { describe, it, expect, afterEach } from "vitest"
import { mount, type VueWrapper } from "@vue/test-utils"
import ChatMessages from "../ChatMessages.vue"
import { FrontendApiError } from "../../types/error"
import type { Message } from "../../types"

function user(content: string): Message {
  return { id: "u1", role: "user", content }
}

function assistant(content: string, stopped = false): Message {
  return { id: "a1", role: "assistant", content, stopped }
}

describe("ChatMessages", () => {
  let wrapper: VueWrapper

  afterEach(() => {
    wrapper.unmount()
  })

  it("renders user and assistant messages", () => {
    wrapper = mount(ChatMessages, {
      props: { messages: [user("hi"), assistant("hello there")], loading: false, error: null, stopped: false },
    })

    expect(wrapper.find(".message-user .message-text").text()).toBe("hi")
    expect(wrapper.find(".message-assistant .message-text").text()).toBe(
      "hello there",
    )
  })

  it("renders assistant markdown as HTML", () => {
    wrapper = mount(ChatMessages, {
      props: {
        messages: [assistant("Hello **world**")],
        loading: false,
        error: null,
        stopped: false,
      },
    })

    expect(
      wrapper.find(".message-assistant .message-text").html(),
    ).toContain("<strong>world</strong>")
  })

  it("shows the chat error with the backend message", () => {
    wrapper = mount(ChatMessages, {
      props: {
        messages: [],
        loading: false,
        error: new FrontendApiError({
          code: "CONTEXT_TOO_LARGE",
          message: "Prompt tokens exceed the limit.",
        }),
        stopped: false,
      },
    })

    expect(wrapper.find(".error").exists()).toBe(true)
    expect(wrapper.find(".error").text()).toContain(
      "Prompt tokens exceed the limit.",
    )
  })

  it("does not show the error area when there is no error", () => {
    wrapper = mount(ChatMessages, {
      props: { messages: [user("hi")], loading: false, error: null, stopped: false },
    })
    expect(wrapper.find(".error").exists()).toBe(false)
  })

  it("shows the stopped indicator for a cancelled generation", () => {
    wrapper = mount(ChatMessages, {
      props: { messages: [assistant("partial answer", true)], loading: false, error: null, stopped: true },
    })

    // Top-level stopped banner.
    expect(wrapper.find(".stopped").text()).toContain("Generation stopped")
    // Per-message stopped indicator.
    expect(wrapper.find(".message-stopped").exists()).toBe(true)
    expect(wrapper.find(".message-stopped .message-stopped-indicator").text()).toBe(
      "Stopped",
    )
  })

  it("shows the loading indicator while generating", () => {
    wrapper = mount(ChatMessages, {
      props: { messages: [], loading: true, error: null, stopped: false },
    })
    expect(wrapper.find(".loading").exists()).toBe(true)
  })
})
