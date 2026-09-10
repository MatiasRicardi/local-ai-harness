import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mount, type VueWrapper } from "@vue/test-utils"
import ProviderSettings from "../ProviderSettings.vue"
import { testProviderConnection } from "../../services/provider"
import { FrontendApiError } from "../../types/error"

vi.mock("../../services/provider")

describe("ProviderSettings", () => {
  let wrapper: VueWrapper

  beforeEach(() => {
    localStorage.clear()
    vi.mocked(testProviderConnection).mockReset()
  })

  afterEach(() => {
    wrapper?.unmount()
  })

  it("has the test button enabled when the default fields are populated", () => {
    wrapper = mount(ProviderSettings)
    // Defaults populate baseUrl and model, so the button is not disabled.
    expect(wrapper.find("button.btn-primary").attributes("disabled")).toBeUndefined()
  })

  it("disables the test button when the base URL is empty", async () => {
    wrapper = mount(ProviderSettings)
    await wrapper.find("#base-url").setValue("")
    expect(
      wrapper.find("button.btn-primary").attributes("disabled"),
    ).toBe("")
  })

  it("shows a success status with the connected model", async () => {
    vi.mocked(testProviderConnection).mockResolvedValue({
      success: true,
      model: "connected-model",
    })
    wrapper = mount(ProviderSettings)

    await wrapper.find("form").trigger("submit")

    expect(testProviderConnection).toHaveBeenCalledTimes(1)
    expect(wrapper.find(".status.success").exists()).toBe(true)
    expect(wrapper.find(".status.success").text()).toContain(
      "Connected to connected-model",
    )
  })

  it("shows an error status with the provider message when the connection fails", async () => {
    vi.mocked(testProviderConnection).mockRejectedValue(
      new FrontendApiError({
        code: "PROVIDER_UNREACHABLE",
        message: "Unable to reach the local backend.",
      }),
    )
    wrapper = mount(ProviderSettings)

    await wrapper.find("form").trigger("submit")

    expect(wrapper.find(".status.error").exists()).toBe(true)
    expect(wrapper.find(".status.error").text()).toContain(
      "Unable to reach the local backend.",
    )
  })
})
