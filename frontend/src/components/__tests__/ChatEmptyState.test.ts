import { describe, it, expect } from "vitest"
import { mount } from "@vue/test-utils"
import ChatEmptyState from "../ChatEmptyState.vue"

type StateProps = { model: string; contextLabel: string; webSearchEnabled: boolean }

function mountState(props: Partial<StateProps> = {}) {
  return mount(ChatEmptyState, {
    props: {
      model: "qwen2.5-coder-7b-instruct",
      contextLabel: "32,768",
      webSearchEnabled: false,
      ...props,
    },
  })
}

describe("ChatEmptyState", () => {
  it("describes the real configured endpoint instead of invented capabilities", () => {
    const wrapper = mountState()

    expect(wrapper.text()).toContain("qwen2.5-coder-7b-instruct")
    expect(wrapper.text()).toContain("32,768")
    expect(wrapper.text()).toContain("Web search is off.")
    expect(wrapper.text()).not.toContain("Temperature")
    expect(wrapper.text()).not.toContain("latency")
  })

  it("mentions web search only when it is enabled", () => {
    const wrapper = mountState({ webSearchEnabled: true })

    expect(wrapper.text()).toContain("web search on")
    expect(wrapper.text()).toContain("Web search is on.")
  })

  it("asks for configuration when no model has been entered yet", () => {
    const wrapper = mountState({ model: "", contextLabel: "" })

    expect(wrapper.text()).toContain("Configure an endpoint in Model Settings")
    expect(wrapper.text()).not.toContain("token window")
  })

  it("does not render prompt suggestion cards", () => {
    const wrapper = mountState()

    expect(wrapper.find(".chat-empty-suggestion").exists()).toBe(false)
    expect(wrapper.find(".empty-state").text()).not.toContain("Explain this error")
  })
})
