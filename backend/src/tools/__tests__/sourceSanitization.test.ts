import { describe, it, expect } from "vitest";
import { sanitizeSources, sanitizeSourceUrl } from "../sourceSanitization.js";
import type { WebSearchSource } from "../webSearchFormat.js";

describe("sanitizeSourceUrl", () => {
  it("accepts http and https URLs", () => {
    expect(sanitizeSourceUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(sanitizeSourceUrl("http://example.com/b")).toBe("http://example.com/b");
  });

  it("rejects non-http schemes and malformed URLs", () => {
    expect(sanitizeSourceUrl("javascript:alert(1)")).toBeUndefined();
    expect(sanitizeSourceUrl("data:text/html,<script>")).toBeUndefined();
    expect(sanitizeSourceUrl("ftp://example.com")).toBeUndefined();
    expect(sanitizeSourceUrl("")).toBeUndefined();
    expect(sanitizeSourceUrl("not a url")).toBeUndefined();
  });

  it("rejects URLs carrying userinfo credentials", () => {
    expect(sanitizeSourceUrl("https://user:token@example.com/path")).toBeUndefined();
    expect(sanitizeSourceUrl("https://user@example.com/path")).toBeUndefined();
    expect(sanitizeSourceUrl("http://user:token@example.com")).toBeUndefined();
  });
});

describe("sanitizeSources", () => {
  const sources: Array<Partial<WebSearchSource>> = [
    { id: 1, title: "Cats", url: "https://example.com/cats", content: "safe" },
    { id: 2, title: "Bad scheme", url: "javascript:alert(1)" },
    { id: 3, title: "No url", url: "" },
    { id: 4, title: "Bad url", url: "ht!tp://broken" },
    { id: 5, title: "Credentials", url: "https://user:token@example.com/leak" },
  ];

  it("keeps only backend-grounded http(s) entries with an id", () => {
    const sanitized = sanitizeSources(sources);
    expect(sanitized).toEqual([{ id: 1, title: "Cats", url: "https://example.com/cats" }]);
  });

  it("drops content: the emitted payload is id + title + url only", () => {
    const sanitized = sanitizeSources(sources);
    for (const source of sanitized) {
      expect(source).not.toHaveProperty("content");
      expect(source).not.toHaveProperty("score");
    }
  });

  it("returns an empty array when nothing is backend-grounded", () => {
    expect(sanitizeSources(sources)).toHaveLength(1);
    expect(sanitizeSources([])).toEqual([]);
  });

  it("sets resultCount equal to the number of sanitized sources", () => {
    expect(sanitizeSources(sources).length).toBe(1);
  });
});
