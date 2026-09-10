/**
 * Reusable provider fakes shared across backend route tests.
 *
 * These factories only stand in for the upstream OpenAI-compatible provider so
 * that tests never require a real model or internet access. Scenario-specific
 * payloads stay in the individual test files; this module only holds the
 * duplicated fetch replacement logic.
 */
import { expect } from "vitest";

/** Asserts the call targets the chat endpoint, then returns the given response. */
export function mockFetchSuccess(response: unknown) {
  return ((url: string, options: RequestInit) => {
    expect(url).toContain("/chat/completions");
    expect(options.method).toBe("POST");
    const contentType = options.headers as Record<string, string> | undefined;
    expect(contentType?.["Content-Type"]).toBe("application/json");
    return response;
  }) as unknown as typeof globalThis.fetch;
}

/** Throws a DOMException TimeoutError, simulating a provider timeout. */
export function mockFetchTimeout() {
  return ((url: string, options: RequestInit) => {
    expect(url).toContain("/chat/completions");
    expect(options.method).toBe("POST");
    const contentType = options.headers as Record<string, string> | undefined;
    expect(contentType?.["Content-Type"]).toBe("application/json");
    throw new DOMException("The operation timed out", "TimeoutError");
  }) as unknown as typeof globalThis.fetch;
}

/** Throws a fetch-failed TypeError, simulating an unreachable provider. */
export function mockFetchNetworkError() {
  return (() => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof globalThis.fetch;
}
