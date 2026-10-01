import { describe, it, expect } from "vitest";
import {
  chatRequestSchema,
  chatDocumentContextSchema,
  webSearchSchema,
  runtimeContextSchema,
  MAX_TIMEZONE_LENGTH,
  MAX_LOCALE_LENGTH,
} from "../schemas.js";

describe("chatDocumentContextSchema", () => {
  it("accepts valid document context", () => {
    const result = chatDocumentContextSchema.safeParse({
      fileId: "uuid-123",
      filename: "report.pdf",
      text: "Extracted text content",
    });

    expect(result.success).toBe(true);
  });

  it("rejects missing fileId", () => {
    const result = chatDocumentContextSchema.safeParse({
      filename: "report.pdf",
      text: "Extracted text content",
    });

    expect(result.success).toBe(false);
  });

  it("rejects missing filename", () => {
    const result = chatDocumentContextSchema.safeParse({
      fileId: "uuid-123",
      text: "Extracted text content",
    });

    expect(result.success).toBe(false);
  });

  it("rejects missing text", () => {
    const result = chatDocumentContextSchema.safeParse({
      fileId: "uuid-123",
      filename: "report.pdf",
    });

    expect(result.success).toBe(false);
  });

  it("rejects non-string fileId", () => {
    const result = chatDocumentContextSchema.safeParse({
      fileId: 123,
      filename: "report.pdf",
      text: "Extracted text content",
    });

    expect(result.success).toBe(false);
  });

  it("rejects non-string filename", () => {
    const result = chatDocumentContextSchema.safeParse({
      fileId: "uuid-123",
      filename: 123,
      text: "Extracted text content",
    });

    expect(result.success).toBe(false);
  });

  it("rejects non-string text", () => {
    const result = chatDocumentContextSchema.safeParse({
      fileId: "uuid-123",
      filename: "report.pdf",
      text: [],
    });

    expect(result.success).toBe(false);
  });
});

describe("chatRequestSchema", () => {
  it("accepts request without document", () => {
    const result = chatRequestSchema.safeParse({
      provider: {
        baseUrl: "http://localhost:3000/v1",
        model: "test-model",
        timeoutMs: 120000,
      },
      messages: [
        { role: "user", content: "Hello" },
      ],
    });

    expect(result.success).toBe(true);
  });

  it("accepts request with valid document", () => {
    const result = chatRequestSchema.safeParse({
      provider: {
        baseUrl: "http://localhost:3000/v1",
        model: "test-model",
        timeoutMs: 120000,
      },
      messages: [
        { role: "user", content: "Hello" },
      ],
      document: {
        fileId: "uuid-123",
        filename: "report.pdf",
        text: "Extracted text content",
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects request with invalid document (string instead of object)", () => {
    const result = chatRequestSchema.safeParse({
      provider: {
        baseUrl: "http://localhost:3000/v1",
        model: "test-model",
        timeoutMs: 120000,
      },
      messages: [
        { role: "user", content: "Hello" },
      ],
      document: "hello",
    });

    expect(result.success).toBe(false);
  });

  it("rejects request with invalid document (wrong field types)", () => {
    const result = chatRequestSchema.safeParse({
      provider: {
        baseUrl: "http://localhost:3000/v1",
        model: "test-model",
        timeoutMs: 120000,
      },
      messages: [
        { role: "user", content: "Hello" },
      ],
      document: {
        fileId: 123,
        filename: [],
        text: 456,
      },
    });

    expect(result.success).toBe(false);
  });

  it("accepts a request without web search (opt-in, backward compatible)", () => {
    const result = chatRequestSchema.safeParse({
      provider: {
        baseUrl: "http://localhost:3000/v1",
        model: "test-model",
        timeoutMs: 120000,
      },
      messages: [{ role: "user", content: "Hello" }],
    });

    expect(result.success).toBe(true);
    expect(result.data?.webSearch).toBeUndefined();
  });

  it("accepts a disabled web search config", () => {
    const result = webSearchSchema.safeParse({
      enabled: false,
      provider: "tavily",
    });

    expect(result.success).toBe(true);
  });

  it("accepts an enabled web search config with an API key", () => {
    const result = webSearchSchema.safeParse({
      enabled: true,
      provider: "tavily",
      apiKey: "tavily-key",
    });

    expect(result.success).toBe(true);
  });

  it("rejects an enabled web search config without an API key", () => {
    const result = webSearchSchema.safeParse({
      enabled: true,
      provider: "tavily",
    });

    expect(result.success).toBe(false);
  });

  it("rejects an unknown web search provider (VALIDATION_ERROR, no dedicated code)", () => {
    const result = webSearchSchema.safeParse({
      enabled: true,
      provider: "exa",
    });

    expect(result.success).toBe(false);
  });

  it("rejects maxResults above the hard max of 10", () => {
    const result = webSearchSchema.safeParse({
      enabled: true,
      provider: "tavily",
      apiKey: "tavily-key",
      maxResults: 11,
    });

    expect(result.success).toBe(false);
  });

  it("accepts maxResults at the hard max of 10", () => {
    const result = webSearchSchema.safeParse({
      enabled: true,
      provider: "tavily",
      apiKey: "tavily-key",
      maxResults: 10,
    });

    expect(result.success).toBe(true);
  });

  it("rejects maxResults below the min of 1", () => {
    const result = webSearchSchema.safeParse({
      enabled: true,
      provider: "tavily",
      apiKey: "tavily-key",
      maxResults: 0,
    });

    expect(result.success).toBe(false);
  });

  it("rejects an invalid searchDepth", () => {
    const result = webSearchSchema.safeParse({
      enabled: true,
      provider: "tavily",
      apiKey: "tavily-key",
      searchDepth: "extreme" as "basic" | "advanced",
    });

    expect(result.success).toBe(false);
  });

  it("accepts a full chat request with a valid web search config", () => {
    const result = chatRequestSchema.safeParse({
      provider: {
        baseUrl: "http://localhost:3000/v1",
        model: "test-model",
        timeoutMs: 120000,
      },
      messages: [{ role: "user", content: "Hello" }],
      webSearch: {
        enabled: true,
        provider: "tavily",
        apiKey: "tavily-key",
        maxResults: 5,
        searchDepth: "advanced",
      },
    });

    expect(result.success).toBe(true);
  });
});

describe("webSearchSchema is not reachable from the request as a base URL override", () => {
  it("has no baseUrl field, so the request cannot override the backend-owned endpoint", () => {
    // The schema deliberately omits baseUrl: the only way the Tavily endpoint is
    // chosen is backend configuration. Asserting the shape has no baseUrl key
    // documents that contract.
    const result = webSearchSchema.safeParse({
      enabled: true,
      provider: "tavily",
      apiKey: "tavily-key",
      baseUrl: "https://evil.example",
    });

    // Extra unknown keys are stripped by Zod (not rejected), so parsing succeeds,
    // but the parsed value must never carry a baseUrl the backend would honor.
    expect(result.success).toBe(true);
    if (result.success) {
      expect("baseUrl" in result.data).toBe(false);
    }
  });
});

describe("runtimeContextSchema", () => {
  it("accepts a valid timezone and locale", () => {
    const result = runtimeContextSchema.safeParse({
      timeZone: "America/Montevideo",
      locale: "es-UY",
    });

    expect(result.success).toBe(true);
  });

  it("accepts an omitted runtimeContext (whole object is optional)", () => {
    expect(runtimeContextSchema.safeParse(undefined).success).toBe(true);
    expect(chatRequestSchema.safeParse({ provider: { baseUrl: "http://x/v1", model: "m" }, messages: [{ role: "user", content: "hi" }] }).success).toBe(true);
  });

  it("trims whitespace before validating", () => {
    const result = runtimeContextSchema.safeParse({
      timeZone: "  America/Montevideo  ",
      locale: "  es-UY  ",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ timeZone: "America/Montevideo", locale: "es-UY" });
    }
  });

  it("rejects empty or whitespace-only fields", () => {
    expect(runtimeContextSchema.safeParse({ timeZone: "", locale: "es-UY" }).success).toBe(false);
    expect(runtimeContextSchema.safeParse({ timeZone: "America/Montevideo", locale: "" }).success).toBe(false);
    expect(runtimeContextSchema.safeParse({ timeZone: "   ", locale: "es-UY" }).success).toBe(false);
  });

  it("rejects an invalid IANA timezone", () => {
    expect(runtimeContextSchema.safeParse({ timeZone: "Mars/Phobos", locale: "es-UY" }).success).toBe(false);
  });

  it("rejects a malformed locale", () => {
    // A syntactically valid but non-existent tag is accepted by canonicalization;
    // a truly malformed tag throws RangeError and is rejected.
    expect(runtimeContextSchema.safeParse({ timeZone: "America/Montevideo", locale: "%" }).success).toBe(false);
  });

  it("rejects values longer than the configured length bounds", () => {
    // Valid IANA timezones are short, so the bound is observed via the rejection
    // path: a value one char over the max is rejected regardless of validity.
    const overTimeZone = "America/" + "x".repeat(MAX_TIMEZONE_LENGTH);
    const overLocale = "en-" + "x".repeat(MAX_LOCALE_LENGTH);

    expect(runtimeContextSchema.safeParse({ timeZone: overTimeZone, locale: "es-UY" }).success).toBe(false);
    expect(runtimeContextSchema.safeParse({ timeZone: "America/Montevideo", locale: overLocale }).success).toBe(false);
  });
});
