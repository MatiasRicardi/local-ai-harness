import { describe, it, expect } from "vitest";
import {
  calculateToolResultBudget,
  truncateContentPreservingStructure,
} from "../toolResultBudget.js";

// ── calculateToolResultBudget ────────────────────────────────────────────────

/**
 * A 1024-token window: usable = floor(1024 * 0.9) = 921; response reserve =
 * min(max(512, 230), 460) = 460; input budget = 921 - 460 = 461 tokens.
 */
const MAX_TOKENS = 1024;

describe("calculateToolResultBudget — content fits", () => {
  it("keeps the full tool body when there is room after the fixed content", () => {
    const toolResultCharacters = 100;
    // Fixed content well below the 461-token input budget.
    const messageTokens = 10;

    const budget = calculateToolResultBudget({
      maxTokens: MAX_TOKENS,
      messageTokens,
      toolResultCharacters,
    });

    expect(budget.includedToolCharacters).toBe(100);
    expect(budget.originalToolCharacters).toBe(100);
    expect(budget.truncated).toBe(false);
  });

  it("is deterministic for identical inputs", () => {
    const params = { maxTokens: MAX_TOKENS, messageTokens: 40, toolResultCharacters: 500 };
    expect(calculateToolResultBudget(params)).toStrictEqual(calculateToolResultBudget(params));
  });
});

describe("calculateToolResultBudget — truncation", () => {
  it("shrinks the body to the remaining room and flags truncation", () => {
    // input budget = 461 tokens = 1844 chars. Fixed content uses 100 tokens,
    // leaving 361 tokens ≈ 1444 chars for the tool body.
    const budget = calculateToolResultBudget({
      maxTokens: MAX_TOKENS,
      messageTokens: 100,
      toolResultCharacters: 40_000,
    });

    expect(budget.originalToolCharacters).toBe(40_000);
    expect(budget.truncated).toBe(true);
    expect(budget.includedToolCharacters).toBeGreaterThan(0);
    expect(budget.includedToolCharacters).toBeLessThan(40_000);
    // Never larger than the raw body.
    expect(budget.includedToolCharacters).toBeLessThanOrEqual(40_000);
  });

  it("reserves the response reserve: fixed content is never displaced", () => {
    // Spend almost the entire input budget on fixed content; the body gets a
    // sliver, never enough to push the conversation/user/response reserve out.
    const budget = calculateToolResultBudget({
      maxTokens: MAX_TOKENS,
      messageTokens: 460, // 1 token left of the 461 input budget
      toolResultCharacters: 40_000,
    });

    expect(budget.truncated).toBe(true);
    expect(budget.includedToolCharacters).toBeLessThan(4 * 2); // ~1 token worth
    expect(budget.includedToolCharacters).toBeGreaterThanOrEqual(0);
  });
});

describe("calculateToolResultBudget — no room", () => {
  it("returns zero included characters (not negative) when fixed content exhausts the budget", () => {
    const budget = calculateToolResultBudget({
      maxTokens: MAX_TOKENS,
      messageTokens: 10_000, // far above the 461-token input budget
      toolResultCharacters: 40_000,
    });

    expect(budget.includedToolCharacters).toBe(0);
    expect(budget.originalToolCharacters).toBe(40_000);
    expect(budget.truncated).toBe(true);
  });

  it("never returns a negative value for any input", () => {
    for (const messageTokens of [0, 1, 461, 1000, 1_000_000]) {
      const budget = calculateToolResultBudget({
        maxTokens: MAX_TOKENS,
        messageTokens,
        toolResultCharacters: 40_000,
      });
      expect(budget.includedToolCharacters).toBeGreaterThanOrEqual(0);
      expect(budget.originalToolCharacters).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("calculateToolResultBudget — extreme inputs", () => {
  it("handles zero-sized tool body", () => {
    const budget = calculateToolResultBudget({
      maxTokens: MAX_TOKENS,
      messageTokens: 10,
      toolResultCharacters: 0,
    });
    expect(budget.includedToolCharacters).toBe(0);
    expect(budget.originalToolCharacters).toBe(0);
    // 0 < 0 is false → not truncated; an empty body is not "truncated".
    expect(budget.truncated).toBe(false);
  });

  it("handles a huge tool body and a huge budget", () => {
    const budget = calculateToolResultBudget({
      maxTokens: 2_000_000,
      messageTokens: 1000,
      toolResultCharacters: 100_000_000,
    });
    expect(budget.truncated).toBe(true);
    expect(budget.includedToolCharacters).toBeGreaterThan(0);
    expect(budget.includedToolCharacters).toBeLessThan(100_000_000);
  });
});

// ── truncateContentPreservingStructure ───────────────────────────────────────

describe("truncateContentPreservingStructure", () => {
  const text = "HEADER BLOCK\n\nsection one\n\nsection two\n\nsection three";

  it("returns the text untouched when it fits", () => {
    expect(truncateContentPreservingStructure(text, text.length + 10)).toBe(text);
    expect(truncateContentPreservingStructure(text, text.length)).toBe(text);
  });

  it("returns an empty string for a non-positive cap", () => {
    expect(truncateContentPreservingStructure(text, 0)).toBe("");
    expect(truncateContentPreservingStructure(text, -5)).toBe("");
  });

  it("keeps the leading header block even when it alone exceeds the cap", () => {
    const out = truncateContentPreservingStructure(text, 4);
    expect(out).toBe("HEAD");
    expect(out.length).toBeLessThanOrEqual(4);
  });

  it("drops whole sections at a boundary, never cutting mid-section", () => {
    // Cap that fits the header + "section one" only.
    const cap = "HEADER BLOCK".length + 2 + "section one".length;
    const out = truncateContentPreservingStructure(text, cap);
    expect(out).toBe("HEADER BLOCK\n\nsection one");
    expect(out).not.toContain("section two");
  });

  it("never produces output longer than the cap", () => {
    for (const cap of [10, 25, 40, 60, 100]) {
      const out = truncateContentPreservingStructure(text, cap);
      expect(out.length).toBeLessThanOrEqual(cap);
    }
  });

  it("is deterministic for identical inputs", () => {
    expect(truncateContentPreservingStructure(text, 50)).toBe(truncateContentPreservingStructure(text, 50));
  });
});
