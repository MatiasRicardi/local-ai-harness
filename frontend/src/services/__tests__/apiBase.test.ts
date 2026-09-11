import { describe, it, expect } from "vitest"
import { API_BASE, resolveApiBase, assertSecureApiBase } from "../apiBase"

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
    // localhost development is explicitly allowed over HTTP (loopback traffic
    // never leaves the machine).
    expect(resolveApiBase("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000")
    expect(resolveApiBase("http://localhost:3000")).toBe("http://localhost:3000")
  })

  it("requires HTTPS for non-local API bases to avoid cleartext exposure", () => {
    // A remote HTTP base would send sensitive payloads (e.g. apiKey) over
    // cleartext (CWE-319): it must be rejected.
    expect(() => resolveApiBase("http://api.example.test")).toThrow()
    expect(() => assertSecureApiBase("http://example.com")).toThrow()

    // HTTPS remote bases remain valid.
    expect(resolveApiBase("https://api.example.test")).toBe("https://api.example.test")
    expect(`${resolveApiBase("https://api.example.test")}/api/files`).toBe(
      "https://api.example.test/api/files",
    )
  })

  it("derives API_BASE from VITE_API_URL rather than a hard-coded host", () => {
    expect(API_BASE).toBe(resolveApiBase(import.meta.env.VITE_API_URL))
  })
})
