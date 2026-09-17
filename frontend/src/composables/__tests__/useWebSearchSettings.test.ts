import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  mergeWithWebSearchDefaults,
  clampMaxResults,
  loadWebSearchSettings,
  saveWebSearchSettings,
  WEB_SEARCH_STORAGE_KEY,
  type WebSearchSettings,
} from "../useWebSearchSettings"

describe("mergeWithWebSearchDefaults", () => {
  it("applies every default when the object is empty", () => {
    expect(mergeWithWebSearchDefaults({})).toEqual({
      enabled: false,
      provider: "tavily",
      apiKey: "",
      searchDepth: "basic",
      maxResults: 5,
    })
  })

  it("preserves valid values", () => {
    expect(
      mergeWithWebSearchDefaults({
        enabled: true,
        provider: "tavily",
        apiKey: "tly-abc",
        searchDepth: "advanced",
        maxResults: 7,
      }),
    ).toEqual({
      enabled: true,
      provider: "tavily",
      apiKey: "tly-abc",
      searchDepth: "advanced",
      maxResults: 7,
    })
  })

  it("clamps maxResults into the 1..10 range", () => {
    expect(clampMaxResults(0)).toBe(1)
    expect(clampMaxResults(-5)).toBe(1)
    expect(clampMaxResults(11)).toBe(10)
    expect(clampMaxResults(100)).toBe(10)
    expect(clampMaxResults(5)).toBe(5)
  })

  it("clamps an out-of-range maxResults while keeping the rest", () => {
    expect(
      mergeWithWebSearchDefaults({ maxResults: 999, enabled: true }),
    ).toMatchObject({ maxResults: 10, enabled: true })
    expect(
      mergeWithWebSearchDefaults({ maxResults: 0 }),
    ).toMatchObject({ maxResults: 1 })
  })

  // Persisted localStorage is attacker-controllable and can carry wrong-shaped
  // values (e.g. `{"enabled":true,"apiKey":42}`). `??` only guards null/
  // undefined, so the merge must reject wrong types instead of passing them
  // through to callers that assume the declared type (e.g. `.trim()` on apiKey).
  describe("validates persisted field types", () => {
    it("rejects a non-boolean enabled and falls back", () => {
      expect(
        mergeWithWebSearchDefaults({ enabled: 42 as unknown as boolean }),
      ).toMatchObject({ enabled: false })
      expect(
        mergeWithWebSearchDefaults({ enabled: "yes" as unknown as boolean }),
      ).toMatchObject({ enabled: false })
    })

    it("rejects a non-string apiKey and falls back", () => {
      expect(
        mergeWithWebSearchDefaults({ apiKey: 42 as unknown as string }),
      ).toMatchObject({ apiKey: "" })
      expect(
        mergeWithWebSearchDefaults({ apiKey: null as unknown as string }),
      ).toMatchObject({ apiKey: "" })
    })

    it("rejects an unsupported searchDepth enum and falls back", () => {
      expect(
        mergeWithWebSearchDefaults({ searchDepth: "hyper" as "basic" }),
      ).toMatchObject({ searchDepth: "basic" })
      expect(
        mergeWithWebSearchDefaults({ searchDepth: 1 as unknown as "basic" }),
      ).toMatchObject({ searchDepth: "basic" })
    })

    it("keeps provider fixed on tavily regardless of stored value", () => {
      expect(
        mergeWithWebSearchDefaults({ provider: "exa" as "tavily" }),
      ).toMatchObject({ provider: "tavily" })
    })

    it("normalises a fully wrong-shaped payload to safe defaults", () => {
      expect(
        mergeWithWebSearchDefaults({
          enabled: "yes" as unknown as boolean,
          apiKey: 42,
          searchDepth: 7,
          provider: "exa",
        } as unknown as Partial<WebSearchSettings>),
      ).toEqual({
        enabled: false,
        provider: "tavily",
        apiKey: "",
        searchDepth: "basic",
        maxResults: 5,
      })
    })
  })
})

describe("loadWebSearchSettings / saveWebSearchSettings", () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it("round-trips through the documented storage key", () => {
    const settings: WebSearchSettings = {
      enabled: true,
      provider: "tavily",
      apiKey: "tly-xyz",
      searchDepth: "advanced",
      maxResults: 3,
    }
    saveWebSearchSettings(settings)
    expect(localStorage.getItem(WEB_SEARCH_STORAGE_KEY)).toBeTruthy()
    expect(loadWebSearchSettings()).toEqual(settings)
  })

  it("returns defaults when nothing has been stored", () => {
    expect(loadWebSearchSettings()).toEqual({
      enabled: false,
      provider: "tavily",
      apiKey: "",
      searchDepth: "basic",
      maxResults: 5,
    })
  })

  it("returns defaults when the stored value is malformed", () => {
    localStorage.setItem(WEB_SEARCH_STORAGE_KEY, "{not valid json")
    expect(loadWebSearchSettings()).toEqual({
      enabled: false,
      provider: "tavily",
      apiKey: "",
      searchDepth: "basic",
      maxResults: 5,
    })
  })
})
