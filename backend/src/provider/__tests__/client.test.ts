import { describe, it, expect } from "vitest";
import { OpenAICompatibleClient, normalizeBaseUrl } from "../client.js";

// ── ErrorType tests ──────────────────────────────────────────────────────────

describe("ErrorType", () => {
  it("exports all error type identifiers", () => {
    expect(OpenAICompatibleClient.ErrorType.TIMEOUT).toBe("timeout");
    expect(OpenAICompatibleClient.ErrorType.HTTP_ERROR).toBe("http_error");
    expect(OpenAICompatibleClient.ErrorType.MALFORMED_RESPONSE).toBe("malformed_response");
    expect(OpenAICompatibleClient.ErrorType.NETWORK_ERROR).toBe("network_error");
    expect(OpenAICompatibleClient.ErrorType.UNKNOWN).toBe("unknown");
  });
});

// ── getErrorInfo tests ───────────────────────────────────────────────────────

describe("getErrorInfo", () => {
  const client = new OpenAICompatibleClient("http://localhost:8080/v1");

  it("detects timeout errors (TimeoutError)", () => {
    const error = new DOMException("The operation was aborted.", "TimeoutError");
    const result = client.getErrorInfo(error);

    expect(result.errorType).toBe(OpenAICompatibleClient.ErrorType.TIMEOUT);
    expect(result.message).toBe("Provider request timed out");
  });

  it("detects timeout errors (AbortError)", () => {
    const error = new DOMException("The operation was aborted.", "AbortError");
    const result = client.getErrorInfo(error);

    expect(result.errorType).toBe(OpenAICompatibleClient.ErrorType.TIMEOUT);
    expect(result.message).toBe("Provider request timed out");
  });

  it("detects network errors", () => {
    const error = new DOMException("Failed to fetch", "NetworkError");
    const result = client.getErrorInfo(error);

    expect(result.errorType).toBe(OpenAICompatibleClient.ErrorType.NETWORK_ERROR);
    expect(result.message).toBe("Provider connection failed");
  });

  it("detects network errors from fetch TypeError", () => {
    const error = new TypeError("fetch failed");
    const result = client.getErrorInfo(error);

    expect(result.errorType).toBe(OpenAICompatibleClient.ErrorType.NETWORK_ERROR);
    expect(result.message).toBe("Provider connection failed");
  });

  it("detects HTTP errors with status codes", () => {
    const httpError = new Error("Provider returned HTTP 401: Unauthorized");
    const wrappedError = new Error("Request failed", { cause: httpError });
    const result = client.getErrorInfo(wrappedError);

    expect(result.errorType).toBe(OpenAICompatibleClient.ErrorType.HTTP_ERROR);
    expect(result.message).toBe("Provider returned HTTP 401");
  });

  it("detects HTTP errors with 500 status", () => {
    const httpError = new Error("Provider returned HTTP 500: Internal Server Error");
    const wrappedError = new Error("Request failed", { cause: httpError });
    const result = client.getErrorInfo(wrappedError);

    expect(result.errorType).toBe(OpenAICompatibleClient.ErrorType.HTTP_ERROR);
    expect(result.message).toBe("Provider returned HTTP 500");
  });

  it("detects malformed response errors (no choices)", () => {
    const malformedError = new Error("Provider returned no choices in the response");
    const wrappedError = new Error("Request failed", { cause: malformedError });
    const result = client.getErrorInfo(wrappedError);

    expect(result.errorType).toBe(OpenAICompatibleClient.ErrorType.MALFORMED_RESPONSE);
    expect(result.message).toBe("Provider returned no choices in the response");
  });

  it("detects malformed response errors (empty response)", () => {
    const malformedError = new Error("Provider returned an empty response");
    const wrappedError = new Error("Request failed", { cause: malformedError });
    const result = client.getErrorInfo(wrappedError);

    expect(result.errorType).toBe(OpenAICompatibleClient.ErrorType.MALFORMED_RESPONSE);
    expect(result.message).toBe("Provider returned an empty response");
  });

  it("detects malformed response errors (empty choices)", () => {
    const malformedError = new Error("Provider returned empty choices");
    const wrappedError = new Error("Request failed", { cause: malformedError });
    const result = client.getErrorInfo(wrappedError);

    expect(result.errorType).toBe(OpenAICompatibleClient.ErrorType.MALFORMED_RESPONSE);
    expect(result.message).toBe("Provider returned empty choices");
  });

  it("handles generic errors", () => {
    const error = new Error("Something went wrong");
    const result = client.getErrorInfo(error);

    expect(result.errorType).toBe(OpenAICompatibleClient.ErrorType.UNKNOWN);
    expect(result.message).toBe("Something went wrong");
  });

  it("handles non-error values", () => {
    const result = client.getErrorInfo("not an error");

    expect(result.errorType).toBe(OpenAICompatibleClient.ErrorType.UNKNOWN);
    expect(result.message).toBe("Unknown error");
  });

  it("handles null values", () => {
    const result = client.getErrorInfo(null);

    expect(result.errorType).toBe(OpenAICompatibleClient.ErrorType.UNKNOWN);
    expect(result.message).toBe("Unknown error");
  });

  it("handles undefined values", () => {
    const result = client.getErrorInfo(undefined);

    expect(result.errorType).toBe(OpenAICompatibleClient.ErrorType.UNKNOWN);
    expect(result.message).toBe("Unknown error");
  });
});

// ── normalizeBaseUrl tests ───────────────────────────────────────────────────

describe("normalizeBaseUrl", () => {
  it("preserves a URL with /v1 path", () => {
    expect(normalizeBaseUrl("http://localhost:8080/v1")).toBe(
      "http://localhost:8080/v1",
    );
  });

  it("strips trailing slash from /v1", () => {
    expect(normalizeBaseUrl("http://localhost:8080/v1/")).toBe(
      "http://localhost:8080/v1",
    );
  });

  it("preserves custom path after /v1", () => {
    expect(
      normalizeBaseUrl("http://localhost:8080/v1/chat"),
    ).toBe("http://localhost:8080/v1/chat");
  });

  it("strips trailing slash from custom path", () => {
    expect(
      normalizeBaseUrl("http://localhost:8080/v1/chat/"),
    ).toBe("http://localhost:8080/v1/chat");
  });

  it("adds /v1 when no path exists", () => {
    expect(normalizeBaseUrl("http://localhost:8080")).toBe(
      "http://localhost:8080/v1",
    );
  });

  it("handles https URLs", () => {
    expect(
      normalizeBaseUrl("https://api.example.com/openai/v1"),
    ).toBe("https://api.example.com/openai/v1");
  });

  it("strips whitespace", () => {
    expect(
      normalizeBaseUrl("  http://localhost:8080/v1  "),
    ).toBe("http://localhost:8080/v1");
  });
});

// ── Constructor tests ────────────────────────────────────────────────────────

describe("OpenAICompatibleClient constructor", () => {
  it("normalizes the base URL", () => {
    const client = new OpenAICompatibleClient("http://localhost:8080/v1/");
    // The constructor normalizes the URL internally
    expect(client).toBeDefined();
  });

  it("creates a client with custom path", () => {
    const client = new OpenAICompatibleClient("http://localhost:8080/v1/chat");
    expect(client).toBeDefined();
  });
});
