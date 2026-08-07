import { describe, it, expect } from "vitest";
import { providerConfigSchema, chatMessageSchema, chatMessagesSchema, chatRequestSchema } from "../schemas.js";
import { normalizeBaseUrl } from "../client.js";

// ── Provider config schema tests ─────────────────────────────────────────────

describe("providerConfigSchema", () => {
  it("accepts a valid configuration", () => {
    const config = {
      baseUrl: "http://127.0.0.1:8080/v1",
      model: "local-model",
    };
    const result = providerConfigSchema.parse(config);
    expect(result.baseUrl).toBe("http://127.0.0.1:8080/v1");
    expect(result.model).toBe("local-model");
    expect(result.apiKey).toBeUndefined();
    expect(result.timeoutMs).toBe(120_000); // default
  });

  it("accepts a configuration with API key", () => {
    const config = {
      baseUrl: "http://127.0.0.1:8080/v1",
      model: "local-model",
      apiKey: "sk-test123",
      timeoutMs: 60_000,
    };
    const result = providerConfigSchema.parse(config);
    expect(result.apiKey).toBe("sk-test123");
    expect(result.timeoutMs).toBe(60_000);
  });

  it("rejects an empty base URL", () => {
    expect(() =>
      providerConfigSchema.parse({ baseUrl: "", model: "model" }),
    ).toThrow(/Base URL is required/);
  });

  it("rejects an invalid base URL", () => {
    expect(() =>
      providerConfigSchema.parse({ baseUrl: "not-a-url", model: "model" }),
    ).toThrow(/must be a valid URL/);
  });

  it("rejects non-http(s) protocols", () => {
    expect(() =>
      providerConfigSchema.parse({ baseUrl: "ftp://example.com", model: "model" }),
    ).toThrow(/http or https/);
  });

  it("rejects an empty model name", () => {
    expect(() =>
      providerConfigSchema.parse({ baseUrl: "http://example.com", model: "" }),
    ).toThrow(/Model name is required/);
  });

  it("rejects a model name that is too long", () => {
    expect(() =>
      providerConfigSchema.parse({
        baseUrl: "http://example.com",
        model: "a".repeat(201),
      }),
    ).toThrow(/200 characters/);
  });

  it("rejects a negative timeout", () => {
    expect(() =>
      providerConfigSchema.parse({
        baseUrl: "http://example.com",
        model: "model",
        timeoutMs: -1,
      }),
    ).toThrow();
  });

  it("rejects a timeout that exceeds 300 seconds", () => {
    expect(() =>
      providerConfigSchema.parse({
        baseUrl: "http://example.com",
        model: "model",
        timeoutMs: 300_001,
      }),
    ).toThrow(/300 seconds/);
  });

  it("accepts a timeout of exactly 300 seconds", () => {
    const config = {
      baseUrl: "http://example.com",
      model: "model",
      timeoutMs: 300_000,
    };
    const result = providerConfigSchema.parse(config);
    expect(result.timeoutMs).toBe(300_000);
  });
});

// ── Chat message schema tests ────────────────────────────────────────────────

describe("chatMessageSchema", () => {
  it("accepts a valid user message", () => {
    const message = { role: "user", content: "Hello" };
    const result = chatMessageSchema.parse(message);
    expect(result.role).toBe("user");
    expect(result.content).toBe("Hello");
  });

  it("accepts a valid assistant message", () => {
    const message = { role: "assistant", content: "Hi there!" };
    const result = chatMessageSchema.parse(message);
    expect(result.role).toBe("assistant");
  });

  it("accepts a valid system message", () => {
    const message = { role: "system", content: "You are helpful" };
    const result = chatMessageSchema.parse(message);
    expect(result.role).toBe("system");
  });

  it("rejects an empty role", () => {
    expect(() => chatMessageSchema.parse({ role: "", content: "Hello" })).toThrow();
  });

  it("rejects an invalid role", () => {
    expect(() => chatMessageSchema.parse({ role: "tool", content: "Hello" })).toThrow();
  });

  it("rejects an empty content", () => {
    expect(() => chatMessageSchema.parse({ role: "user", content: "" })).toThrow(/not be empty/);
  });

  it("rejects a message with only whitespace", () => {
    expect(() => chatMessageSchema.parse({ role: "user", content: "   " })).toThrow();
  });
});

// ── Chat messages schema tests ───────────────────────────────────────────────

describe("chatMessagesSchema", () => {
  it("accepts a single message", () => {
    const messages = [{ role: "user", content: "Hello" }];
    const result = chatMessagesSchema.parse(messages);
    expect(result).toHaveLength(1);
  });

  it("accepts multiple messages", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi!" },
      { role: "user", content: "How are you?" },
    ];
    const result = chatMessagesSchema.parse(messages);
    expect(result).toHaveLength(3);
  });

  it("rejects an empty array", () => {
    const result = chatMessagesSchema.safeParse([]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("At least one message");
    }
  });
});

// ── Chat request schema tests ────────────────────────────────────────────────

describe("chatRequestSchema", () => {
  it("accepts a valid chat request without document", () => {
    const request = {
      provider: { baseUrl: "http://127.0.0.1:8080/v1", model: "model" },
      messages: [{ role: "user", content: "Hello" }],
    };
    const result = chatRequestSchema.parse(request);
    expect(result.provider.baseUrl).toBe("http://127.0.0.1:8080/v1");
    // Document context is not supported in step09
    expect(Object.keys(result)).toEqual(["provider", "messages"]);
  });

  it("rejects a chat request with document (not supported in step09)", () => {
    const request = {
      provider: { baseUrl: "http://127.0.0.1:8080/v1", model: "model" },
      messages: [{ role: "user", content: "Hello" }],
      document: {
        filename: "doc.txt",
        content: "Document text here",
      },
    };
    // Document context is not supported in step09; the schema should not include it
    const result = chatRequestSchema.safeParse(request);
    expect(result.success).toBe(false);
  });
});

// ── URL normalization tests ──────────────────────────────────────────────────

describe("normalizeBaseUrl", () => {
  it("preserves a URL with /v1 path", () => {
    expect(normalizeBaseUrl("http://localhost:8080/v1")).toBe("http://localhost:8080/v1");
  });

  it("strips trailing slash from /v1", () => {
    expect(normalizeBaseUrl("http://localhost:8080/v1/")).toBe("http://localhost:8080/v1");
  });

  it("preserves custom path after /v1", () => {
    expect(normalizeBaseUrl("http://localhost:8080/v1/chat")).toBe("http://localhost:8080/v1/chat");
  });

  it("strips trailing slash from custom path", () => {
    expect(normalizeBaseUrl("http://localhost:8080/v1/chat/")).toBe("http://localhost:8080/v1/chat");
  });

  it("adds /v1 when no path exists", () => {
    expect(normalizeBaseUrl("http://localhost:8080")).toBe("http://localhost:8080/v1");
  });

  it("handles https URLs", () => {
    expect(normalizeBaseUrl("https://api.example.com/openai/v1")).toBe("https://api.example.com/openai/v1");
  });

  it("strips whitespace", () => {
    expect(normalizeBaseUrl("  http://localhost:8080/v1  ")).toBe("http://localhost:8080/v1");
  });
});
