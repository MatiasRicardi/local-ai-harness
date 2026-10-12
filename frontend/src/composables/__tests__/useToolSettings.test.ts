import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  mergeWithToolDefaults,
  loadToolSettings,
  saveToolSettings,
  TOOL_STORAGE_KEY,
  DEFAULT_TOOL_SETTINGS,
} from "../useToolSettings"

describe("mergeWithToolDefaults", () => {
  it("applies both defaults when the object is empty", () => {
    expect(mergeWithToolDefaults()).toEqual(DEFAULT_TOOL_SETTINGS)
  })

  it("preserves valid booleans", () => {
    expect(mergeWithToolDefaults({ calculatorEnabled: true, fetchUrlEnabled: true })).toEqual({
      calculatorEnabled: true,
      fetchUrlEnabled: true,
    })
  })

  it("keeps defaults for the absent fields", () => {
    expect(mergeWithToolDefaults({ calculatorEnabled: true })).toEqual({
      calculatorEnabled: true,
      fetchUrlEnabled: false,
    })
  })

  it("rejects non-boolean values with a safe default (no truthiness coercion)", () => {
    expect(
      mergeWithToolDefaults({
        calculatorEnabled: "true" as unknown as boolean,
        fetchUrlEnabled: 1 as unknown as boolean,
      }),
    ).toEqual({ calculatorEnabled: false, fetchUrlEnabled: false })
  })

  it("rejects null and undefined fields individually", () => {
    expect(
      mergeWithToolDefaults({ calculatorEnabled: null as unknown as boolean, fetchUrlEnabled: undefined }),
    ).toEqual({ calculatorEnabled: false, fetchUrlEnabled: false })
  })
})

describe("loadToolSettings / saveToolSettings", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it("round-trips through the documented storage key", () => {
    saveToolSettings({ calculatorEnabled: true, fetchUrlEnabled: false })
    expect(loadToolSettings()).toEqual({ calculatorEnabled: true, fetchUrlEnabled: false })
    expect(localStorage.getItem(TOOL_STORAGE_KEY)).toBeTruthy()
  })

  it("returns defaults when nothing has been stored", () => {
    expect(loadToolSettings()).toEqual(DEFAULT_TOOL_SETTINGS)
  })

  it("returns defaults when the stored value is malformed JSON", () => {
    localStorage.setItem(TOOL_STORAGE_KEY, "{not valid json")
    expect(loadToolSettings()).toEqual(DEFAULT_TOOL_SETTINGS)
  })

  it("returns defaults when a stored field has the wrong type", () => {
    localStorage.setItem(TOOL_STORAGE_KEY, JSON.stringify({ calculatorEnabled: "yes" }))
    expect(loadToolSettings()).toEqual(DEFAULT_TOOL_SETTINGS)
  })

  it("does not break chat when localStorage.setItem throws on save", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded")
    })
    try {
      expect(() => saveToolSettings({ calculatorEnabled: true, fetchUrlEnabled: true })).not.toThrow()
    } finally {
      spy.mockRestore()
    }
  })

  it("does not break chat when localStorage.getItem throws on load", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    try {
      expect(loadToolSettings()).toEqual(DEFAULT_TOOL_SETTINGS)
    } finally {
      spy.mockRestore()
    }
  })
})
