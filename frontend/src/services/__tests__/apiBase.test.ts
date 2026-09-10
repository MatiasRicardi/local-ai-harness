import { describe, it, expect } from "vitest"
import { API_BASE, resolveApiBase } from "../apiBase"

// The resolution rule is tested as a pure function so these expectations hold
// identically with a local `frontend/.env`, without one, and in CI.
describe("resolveApiBase", () => {
  it("uses a same-origin relative base when VITE_API_URL is not configured", () => {
    expect(resolveApiBase(undefined)).toBe("")

    // The empty base is what makes the browser stay on its own origin, where
    // the Vite development proxy or the frontend nginx proxy forwards /api.
    expect(`${resolveApiBase(undefined)}/api/health`).toBe("/api/health")
  })

  it("lets an explicit VITE_API_URL win over the relative default", () => {
    expect(resolveApiBase("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000")
    expect(`${resolveApiBase("http://api.example.test")}/api/files`).toBe(
      "http://api.example.test/api/files",
    )
  })

  it("derives API_BASE from VITE_API_URL rather than a hard-coded host", () => {
    expect(API_BASE).toBe(resolveApiBase(import.meta.env.VITE_API_URL))
  })
})
