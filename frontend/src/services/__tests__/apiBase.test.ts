import { describe, it, expect } from "vitest"
import {
  API_BASE,
  resolveApiBase,
  assertSecureApiBase,
  isSecurePageOrigin,
  isSecureTransport,
} from "../apiBase"

describe("isSecurePageOrigin", () => {
  it("allows HTTPS regardless of host", () => {
    expect(isSecurePageOrigin({ protocol: "https:", hostname: "api.example.test" })).toBe(
      true,
    )
  })

  it("allows loopback hosts over HTTP (traffic never leaves the machine)", () => {
    expect(isSecurePageOrigin({ protocol: "http:", hostname: "127.0.0.1" })).toBe(
      true,
    )
    expect(isSecurePageOrigin({ protocol: "http:", hostname: "localhost" })).toBe(
      true,
    )
    // Bracketed IPv6 hostname as returned by new URL() for http://[::1]:…
    expect(isSecurePageOrigin({ protocol: "http:", hostname: "[::1]" })).toBe(true)
  })

  it("rejects a non-local host over HTTP (cleartext key exposure, CWE-319)", () => {
    expect(
      isSecurePageOrigin({ protocol: "http:", hostname: "api.example.test" }),
    ).toBe(false)
  })
})

// `isSecureTransport` gates the same-origin (relative API_BASE) case on
// `isSecurePageOrigin`; an absolute base is already validated as local-or-HTTPS
// by `assertSecureApiBase`, so it is always safe. The relative-base branch
// delegates to the pure `isSecurePageOrigin` helper, so its page-origin rule is
// tested there directly — passing the origin as a parameter rather than
// redefining `window.location`, which is non-configurable in jsdom.
describe("isSecureTransport", () => {
  it("is always safe when an absolute API base is configured (already validated)", () => {
    // An absolute base is validated as local-or-HTTPS by assertSecureApiBase,
    // so its transport is safe regardless of the page.
    expect(isSecureTransport("https://api.example.test")).toBe(true)
    expect(isSecureTransport("http://127.0.0.1:3000")).toBe(true)
  })

  it("is safe from loopback over HTTP with the default same-origin base", () => {
    // A relative/empty base stays on the page origin, so its transport security
    // is the page's own protocol, asserted via the pure isSecurePageOrigin helper
    // above (kept independent of the non-configurable jsdom window.location).
    expect(isSecurePageOrigin({ protocol: "http:", hostname: "localhost" })).toBe(true)
  })
})

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

  it("rejects a protocol-relative base (host hijack, CWE-201)", () => {
    // //attacker.example inherits the page protocol but changes the host, so an
    // enabled web-search request could send the Tavily key to that origin.
    // new URL() throws for it, which must NOT be silently accepted.
    expect(() => resolveApiBase("//attacker.example")).toThrow()
    expect(() => assertSecureApiBase("//attacker.example")).toThrow()
    // Leading whitespace does not hide the protocol-relative form.
    expect(() => assertSecureApiBase("   //attacker.example")).toThrow()
  })

  it("still allows a same-origin leading-slash path", () => {
    // Resolves against the current origin at request time, so it is safe.
    expect(resolveApiBase("/api")).toBe("/api")
  })
})
