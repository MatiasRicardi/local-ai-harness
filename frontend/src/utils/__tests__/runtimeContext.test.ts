import { describe, it, expect, vi, afterEach } from "vitest"
import { buildRuntimeContext } from "../runtimeContext"

/**
 * `resolvedOptions` lives on the `Intl.DateTimeFormat` prototype. Spy on it
 * instead of depending on the test runner machine timezone.
 */
function mockResolvedOptions(options: { timeZone?: string; locale?: string }) {
  return vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue(options as Intl.ResolvedDateTimeFormatOptions)
}

describe("buildRuntimeContext", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("returns the resolved timeZone and locale when both are present", () => {
    mockResolvedOptions({ timeZone: "America/Montevideo", locale: "es-UY" })

    expect(buildRuntimeContext()).toEqual({ timeZone: "America/Montevideo", locale: "es-UY" })
  })

  it("works for any timezone/locale without hard-coded assumptions", () => {
    mockResolvedOptions({ timeZone: "Asia/Tokyo", locale: "ja-JP" })

    expect(buildRuntimeContext()).toEqual({ timeZone: "Asia/Tokyo", locale: "ja-JP" })
  })

  it("trims whitespace around the resolved values", () => {
    mockResolvedOptions({ timeZone: "  Europe/Paris  ", locale: "  fr-FR  " })

    expect(buildRuntimeContext()).toEqual({ timeZone: "Europe/Paris", locale: "fr-FR" })
  })

  it("returns undefined when the timezone is blank", () => {
    mockResolvedOptions({ timeZone: "   ", locale: "es-UY" })

    expect(buildRuntimeContext()).toBeUndefined()
  })

  it("returns undefined when the locale is blank", () => {
    mockResolvedOptions({ timeZone: "America/Montevideo", locale: "" })

    expect(buildRuntimeContext()).toBeUndefined()
  })

  it("returns undefined when Intl throws", () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(() => {
      throw new Error("Intl unavailable")
    })

    expect(() => buildRuntimeContext()).not.toThrow()
    expect(buildRuntimeContext()).toBeUndefined()
  })
})
