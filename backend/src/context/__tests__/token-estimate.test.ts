import { describe, it, expect } from "vitest";
import { estimateTokens } from "../token-estimate.js";

describe("estimateTokens", () => {
  it("estimates 2 tokens for 8 characters", () => {
    expect(estimateTokens("12345678")).toBe(2);
  });

  it("estimates 1 token for 1-4 characters", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
  });

  it("estimates 3 tokens for 9-12 characters", () => {
    expect(estimateTokens("a".repeat(5))).toBe(2);
    expect(estimateTokens("a".repeat(9))).toBe(3);
    expect(estimateTokens("a".repeat(12))).toBe(3);
  });

  it("estimates 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("handles unicode characters", () => {
    // "café" is 4 characters → ceil(4/4) = 1
    expect(estimateTokens("café")).toBe(1);
    // "café!" is 5 characters → ceil(5/4) = 2
    expect(estimateTokens("café!")).toBe(2);
  });

  it("rounds up for non-even divisions", () => {
    expect(estimateTokens("abcde")).toBe(2); // 5 / 4 = 1.25 → 2
    expect(estimateTokens("abcdefghijklmnop")).toBe(4); // 16 / 4 = 4
  });
});
