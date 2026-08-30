import { describe, it, expect } from "vitest";
import { chatRequestSchema, chatDocumentContextSchema } from "../schemas.js";

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
});
