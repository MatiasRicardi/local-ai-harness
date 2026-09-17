import { describe, it, expect, afterEach } from "vitest"
import { mount, type VueWrapper } from "@vue/test-utils"
import ChatMessages from "../ChatMessages.vue"
import { FrontendApiError } from "../../types/error"
import type { Message } from "../../types"

function user(content: string): Message {
  return { id: "u1", role: "user", content }
}

function assistant(content: string, stopped = false, sources?: Message["sources"]): Message {
  return { id: "a1", role: "assistant", content, stopped, sources }
}

describe("ChatMessages", () => {
  let wrapper: VueWrapper

  afterEach(() => {
    wrapper.unmount()
  })

  it("renders user and assistant messages", () => {
    wrapper = mount(ChatMessages, {
      props: { messages: [user("hi"), assistant("hello there")], loading: false, activity: "idle", error: null, stopped: false },
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
        activity: "idle",
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
        activity: "idle",
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
      props: { messages: [user("hi")], loading: false, activity: "idle", error: null, stopped: false },
    })
    expect(wrapper.find(".error").exists()).toBe(false)
  })

  it("shows the stopped indicator for a cancelled generation", () => {
    wrapper = mount(ChatMessages, {
      props: { messages: [assistant("partial answer", true)], loading: false, activity: "idle", error: null, stopped: true },
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
      props: { messages: [], loading: true, activity: "generating", error: null, stopped: false },
    })
    expect(wrapper.find(".loading").exists()).toBe(true)
  })

  it("shows the searching activity label without touching the assistant bubble", () => {
    wrapper = mount(ChatMessages, {
      props: {
        messages: [assistant("partial")],
        loading: true,
        activity: "searching",
        error: null,
        stopped: false,
      },
    })
    expect(wrapper.find(".loading").text()).toContain("Searching the web…")
  })

  it("renders backend sources under the correct assistant turn", () => {
    wrapper = mount(ChatMessages, {
      props: {
        messages: [
          user("q"),
          assistant("answer", false, [
            { id: 1, title: "MDN", url: "https://developer.mozilla.org/en/docs/Array" },
            { id: 2, title: "Example", url: "https://example.com/page" },
          ]),
        ],
        loading: false,
        activity: "idle",
        error: null,
        stopped: false,
      },
    })

    const block = wrapper.find(".message-assistant .sources")
    expect(block.exists()).toBe(true)
    expect(block.text()).toContain("Sources")
    expect(block.text()).toContain("MDN")
    expect(block.text()).toContain("example.com")

    const links = block.findAll("a")
    expect(links).toHaveLength(2)
    expect(links[0].attributes("target")).toBe("_blank")
    expect(links[0].attributes("rel")).toBe("noopener noreferrer")
  })

  it("does not render a sources section when there are no sources", () => {
    wrapper = mount(ChatMessages, {
      props: {
        messages: [assistant("plain answer")],
        loading: false,
        activity: "idle",
        error: null,
        stopped: false,
      },
    })
    expect(wrapper.find(".sources").exists()).toBe(false)
  })

  it("renders source titles as escaped text, never as HTML", () => {
    wrapper = mount(ChatMessages, {
      props: {
        messages: [
          assistant("answer", false, [
            { id: 1, title: "<img src=x onerror=alert(1)", url: "https://example.com" },
          ]),
        ],
        loading: false,
        activity: "idle",
        error: null,
        stopped: false,
      },
    })

    const block = wrapper.find(".message-assistant .sources")
    expect(block.html()).not.toContain("<img")
    expect(block.text()).toContain("<img src=x onerror=alert(1)")
  })

  it("ignores unsafe source URLs", () => {
    wrapper = mount(ChatMessages, {
      props: {
        messages: [
          assistant("answer", false, [
            { id: 1, title: "Safe", url: "https://safe.example" },
            { id: 2, title: "Data URI", url: "data:text/html,<script>alert(1)</script>" },
            { id: 3, title: "No Protocol", url: "//evil.example" },
          ]),
        ],
        loading: false,
        activity: "idle",
        error: null,
        stopped: false,
      },
    })

    const links = wrapper.find(".message-assistant .sources").findAll("a")
    expect(links).toHaveLength(1)
    expect(links[0].attributes("href")).toBe("https://safe.example")
  })

  it("leaves the assistant markdown unaffected by sources", () => {
    wrapper = mount(ChatMessages, {
      props: {
        messages: [
          assistant(
            "answer **bold**",
            false,
            [{ id: 1, title: "Source", url: "https://example.com" }],
          ),
        ],
        loading: false,
        activity: "idle",
        error: null,
        stopped: false,
      },
    })

    expect(
      wrapper.find(".message-assistant .message-text").html(),
    ).toContain("<strong>bold</strong>")
    expect(wrapper.find(".message-assistant .sources").exists()).toBe(true)
  })
})
