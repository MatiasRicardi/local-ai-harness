import { describe, it, expect } from "vitest";
import {
  calculateContextBudget,
  calculateUsableContextTokens,
  calculateResponseReserveTokens,
  calculateInputBudgetTokens,
  estimateDocumentTemplateOverhead,
  estimateNonDocumentTokens,
  truncateDocumentToBudget,
  type ContextBudgetConfig,
} from "../context-budget.js";

// ── Helper to build a minimal config ────────────────────────────────────────

function buildConfig(overrides: Partial<ContextBudgetConfig> = {}): ContextBudgetConfig {
  return {
    contextSizeTokens: 32768,
    systemInstructions: "",
    conversationHistory: [],
    currentUserMessage: "Hello",
    documentText: null,
    documentFilename: null,
    hasDocument: false,
    ...overrides,
  };
}

// ── calculateUsableContextTokens ────────────────────────────────────────────

describe("calculateUsableContextTokens", () => {
  it("applies 10% safety margin", () => {
    expect(calculateUsableContextTokens(10000)).toBe(9000);
    expect(calculateUsableContextTokens(32768)).toBe(29491);
  });

  it("handles zero", () => {
    expect(calculateUsableContextTokens(0)).toBe(0);
  });
});

// ── calculateResponseReserveTokens ──────────────────────────────────────────

describe("calculateResponseReserveTokens", () => {
  it("uses 25% of usable context when above 512", () => {
    // 10000 * 0.25 = 2500, which is > 512
    expect(calculateResponseReserveTokens(10000)).toBe(2500);
  });

  it("uses minimum 512 when 25% is below 512 but 50% is above 512", () => {
    // 1536 * 0.25 = 384, below 512
    // 1536 * 0.5 = 768, above 512
    // Result: max(512, 384) = 512, min(512, 768) = 512
    expect(calculateResponseReserveTokens(1536)).toBe(512);
  });

  it("uses 50% when 50% is below 512", () => {
    // 1000 * 0.25 = 250, below 512
    // 1000 * 0.5 = 500, below 512
    // Result: max(512, 250) = 512, min(512, 500) = 500
    expect(calculateResponseReserveTokens(1000)).toBe(500);
  });

  it("caps at 50% of usable context", () => {
    // For large context, 25% is well above 512 and well below 50%
    expect(calculateResponseReserveTokens(10000)).toBe(2500);
  });
});

// ── calculateInputBudgetTokens ──────────────────────────────────────────────

describe("calculateInputBudgetTokens", () => {
  it("subtracts response reserve from usable context", () => {
    expect(calculateInputBudgetTokens(9000, 2500)).toBe(6500);
  });
});

// ── estimateDocumentTemplateOverhead ────────────────────────────────────────

describe("estimateDocumentTemplateOverhead", () => {
  it("estimates tokens for the document template", () => {
    const overhead = estimateDocumentTemplateOverhead("report.pdf");
    expect(overhead).toBeGreaterThan(0);
  });

  it("increases with longer filenames", () => {
    const short = estimateDocumentTemplateOverhead("a.txt");
    const long = estimateDocumentTemplateOverhead("a-very-long-filename-that-is-more-than-four-characters.txt");
    expect(long).toBeGreaterThan(short);
  });
});

// ── estimateNonDocumentTokens ───────────────────────────────────────────────

describe("estimateNonDocumentTokens", () => {
  it("estimates 0 for empty config without document", () => {
    const config = buildConfig({
      systemInstructions: "",
      conversationHistory: [],
      currentUserMessage: "",
      hasDocument: false,
    });
    expect(estimateNonDocumentTokens(config)).toBe(0);
  });

  it("includes conversation history tokens", () => {
    const config = buildConfig({
      conversationHistory: [{ role: "user", content: "a".repeat(8) }],
      currentUserMessage: "",
      hasDocument: false,
    });
    // 8 chars / 4 = 2 tokens
    expect(estimateNonDocumentTokens(config)).toBe(2);
  });

  it("includes current user message tokens", () => {
    const config = buildConfig({
      currentUserMessage: "a".repeat(8),
      hasDocument: false,
    });
    expect(estimateNonDocumentTokens(config)).toBe(2);
  });

  it("includes system instructions tokens", () => {
    const config = buildConfig({
      systemInstructions: "a".repeat(8),
      currentUserMessage: "",
      hasDocument: false,
    });
    expect(estimateNonDocumentTokens(config)).toBe(2);
  });

  it("includes document template overhead when document is attached", () => {
    const config = buildConfig({
      hasDocument: true,
      documentFilename: "test.txt",
      currentUserMessage: "",
      conversationHistory: [],
      systemInstructions: "",
    });
    const result = estimateNonDocumentTokens(config);
    expect(result).toBeGreaterThan(0);
  });
});

// ── truncateDocumentToBudget ────────────────────────────────────────────────

describe("truncateDocumentToBudget", () => {
  it("returns original text when it fits", () => {
    const text = "Hello world, this is a short document.";
    expect(truncateDocumentToBudget(text, 100)).toBe(text);
  });

  it("appends truncation marker when text exceeds budget", () => {
    const text = "a".repeat(1000);
    const result = truncateDocumentToBudget(text, 200);
    expect(result).toContain("[Document truncated due to context limit.]");
    expect(result.length).toBeLessThanOrEqual(200);
  });

  it("prefers paragraph breaks", () => {
    const text = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n\nFourth paragraph.";
    // Budget large enough to include first paragraph + marker
    const result = truncateDocumentToBudget(text, 65);
    // Should break at the first paragraph break
    expect(result).toContain("First paragraph.");
    expect(result).not.toContain("Second paragraph.");
  });

  it("prefers newlines when no paragraph breaks", () => {
    const text = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8";
    const result = truncateDocumentToBudget(text, 50);
    expect(result).toContain("Line 1");
    expect(result).not.toContain("Line 4");
  });

  it("prefers spaces when no newlines", () => {
    const text = "Word one word two word three word four word five word six";
    const result = truncateDocumentToBudget(text, 60);
    expect(result).toContain("Word one");
    // Should break at a space, not in the middle of a word
    expect(result.split(" ").length).toBeGreaterThan(1);
  });

  it("falls back to raw prefix when no boundaries found", () => {
    const text = "a".repeat(100);
    const result = truncateDocumentToBudget(text, 50);
    expect(result.length).toBeLessThanOrEqual(50);
    expect(result).toContain("[Document truncated due to context limit.]");
  });

  it("handles empty text", () => {
    expect(truncateDocumentToBudget("", 100)).toBe("");
  });

  it("returns only marker when budget is too small for any content", () => {
    const text = "a".repeat(1000);
    const marker = "[Document truncated due to context limit.]";
    const result = truncateDocumentToBudget(text, marker.length);
    expect(result).toBe(marker);
  });

  it("does not leave isolated surrogates", () => {
    // Prefix budget = 48 - 42 (marker) = 6 code units, so the prefix ends on
    // the high surrogate at index 5 and must be trimmed back.
    const highSurrogate = String.fromCharCode(0xd800);
    const text = "Hello" + highSurrogate + "x".repeat(60);
    const result = truncateDocumentToBudget(text, 48);
    expect(result.length).toBeLessThan(text.length);
    // The last character should not be a surrogate (high or low)
    const lastChar = result.charCodeAt(result.length - 1);
    const isSurrogate = lastChar >= 0xd800 && lastChar <= 0xdfff;
    expect(isSurrogate).toBe(false);
    // Assert on the text before the marker to test the guard directly
    const marker = "[Document truncated due to context limit.]";
    const textBeforeMarker = result.slice(0, result.length - marker.length);
    if (textBeforeMarker.length > 0) {
      const lastTextChar = textBeforeMarker.charCodeAt(textBeforeMarker.length - 1);
      const isTextSurrogate = lastTextChar >= 0xd800 && lastTextChar <= 0xdfff;
      expect(isTextSurrogate).toBe(false);
    }
  });

  it("does not drop all content when breakIndex is 0", () => {
    // Document starts with \n, so lastIndexOf("\n") returns 0.
    // The guard must require breakIndex > 0 to preserve content.
    const text = "\nHello world, this is content that should be preserved.";
    // Large enough budget to avoid truncation entirely
    const result = truncateDocumentToBudget(text, 200);
    expect(result).toBe(text);

    // With a tight budget the \n at index 0 would be a break candidate,
    // but the > 0 guard must still preserve some content (not just the marker).
    const tightResult = truncateDocumentToBudget(text, 50);
    expect(tightResult).not.toBe("[Document truncated due to context limit.]");
    expect(tightResult).toContain("Hello");
  });
});

// ── calculateContextBudget (main entry point) ───────────────────────────────

describe("calculateContextBudget", () => {
  it("accepts small document when it fits", () => {
    const config = buildConfig({
      contextSizeTokens: 32768,
      hasDocument: true,
      documentFilename: "small.txt",
      documentText: "Short document.",
      currentUserMessage: "Hello",
    });

    const result = calculateContextBudget(config);
    expect(result.valid).toBe(true);
    expect(result.includedDocumentText).toBe("Short document.");
    expect(result.truncationMetadata.documentTruncated).toBe(false);
  });

  it("rejects when conversation exceeds input budget (no document)", () => {
    const config = buildConfig({
      contextSizeTokens: 1024,
      systemInstructions: "",
      conversationHistory: [{ role: "user", content: "x".repeat(5000) }],
      currentUserMessage: "Hello",
      hasDocument: false,
    });

    const result = calculateContextBudget(config);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain("too large for the configured context size");
    expect(result.includedDocumentText).toBe("");
  });

  it("rejects when no room for document", () => {
    const config = buildConfig({
      contextSizeTokens: 1024,
      hasDocument: true,
      documentFilename: "test.txt",
      documentText: "Some document content.",
      conversationHistory: [{ role: "user", content: "x".repeat(5000) }],
      currentUserMessage: "Hello",
    });

    const result = calculateContextBudget(config);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain("too large to include the attached document");
    expect(result.includedDocumentText).toBe("");
  });

  it("truncates oversized document", () => {
    const config = buildConfig({
      contextSizeTokens: 2048,
      hasDocument: true,
      documentFilename: "large.txt",
      documentText: "a".repeat(10000),
      currentUserMessage: "Hello",
    });

    const result = calculateContextBudget(config);
    expect(result.valid).toBe(true);
    expect(result.truncationMetadata.documentTruncated).toBe(true);
    expect(result.includedDocumentText).toContain("[Document truncated due to context limit.]");
    expect(result.includedDocumentText.length).toBeLessThan(10000);
  });

  it("preserves original document text in metadata", () => {
    const longText = "b".repeat(5000);
    const config = buildConfig({
      contextSizeTokens: 1024,
      hasDocument: true,
      documentFilename: "test.txt",
      documentText: longText,
      currentUserMessage: "Hello",
    });

    const result = calculateContextBudget(config);
    expect(result.truncationMetadata.originalDocumentCharacters).toBe(5000);
    expect(result.truncationMetadata.includedDocumentCharacters).toBeLessThan(5000);
  });

  it("handles no-document case normally", () => {
    const config = buildConfig({
      contextSizeTokens: 32768,
      hasDocument: false,
      currentUserMessage: "Hello",
    });

    const result = calculateContextBudget(config);
    expect(result.valid).toBe(true);
    expect(result.truncationMetadata.documentTruncated).toBe(false);
    expect(result.includedDocumentText).toBe("");
  });

  it("does not mutate the original document text", () => {
    const originalText = "c".repeat(10000);
    const config = buildConfig({
      contextSizeTokens: 4096,
      hasDocument: true,
      documentFilename: "test.txt",
      documentText: originalText,
      currentUserMessage: "Hello",
    });

    calculateContextBudget(config);
    // The config object's documentText should remain unchanged
    expect(config.documentText).toBe(originalText);
  });
});
