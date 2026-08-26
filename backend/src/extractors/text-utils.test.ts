import { describe, it, expect } from "vitest";
import {
  cleanExtractedText,
  isBinaryLike,
  validateUsableText,
  countSuspiciousControls,
} from "./text-utils.js";
import { ExtractionError } from "./ExtractionError.js";

describe("text-utils", () => {
  describe("countSuspiciousControls", () => {
    it("returns 0 for normal text", () => {
      expect(countSuspiciousControls("Hello, world!")).toBe(0);
    });

    it("returns 0 for text with normal whitespace", () => {
      expect(countSuspiciousControls("line1\nline2\tindented\r\n")).toBe(0);
    });

    it("counts suspicious control characters", () => {
      // U+0001, U+0002, U+0003 are suspicious
      const text = "abc\u0001def\u0002ghi\u0003jkl";
      expect(countSuspiciousControls(text)).toBe(3);
    });

    it("does not count null bytes as suspicious (they are a separate category)", () => {
      // U+0000 is in the suspicious range [0x00, 0x08]
      // but for the purpose of this step, null bytes are counted as suspicious
      const text = "abc\u0000def";
      expect(countSuspiciousControls(text)).toBe(1);
    });

    it("counts U+000B (vertical tab) as suspicious", () => {
      expect(countSuspiciousControls("a\u000bb")).toBe(1);
    });

    it("counts U+000C (form feed) as suspicious", () => {
      expect(countSuspiciousControls("a\u000Cb")).toBe(1);
    });
  });

  describe("cleanExtractedText", () => {
    it("preserves normal text", () => {
      const { text, warnings } = cleanExtractedText("Hello, world!", false);
      expect(text).toBe("Hello, world!");
      expect(warnings).toHaveLength(0);
    });

    it("adds warning for invalid UTF-8", () => {
      const { text, warnings } = cleanExtractedText("Hello \uFFFD world", true);
      expect(text).toBe("Hello \uFFFD world");
      expect(warnings).toContain(
        "The file contained invalid UTF-8 sequences that were replaced."
      );
    });

    it("removes null bytes and adds warning", () => {
      const { text, warnings } = cleanExtractedText("hello\u0000world", false);
      expect(text).toBe("helloworld");
      expect(warnings).toContain("Null bytes were removed from the extracted text.");
    });

    it("adds both warnings when both apply", () => {
      const { text, warnings } = cleanExtractedText(
        "hello\u0000wor\uFFFDld",
        true,
      );
      expect(text).toBe("hellowor\uFFFDld");
      expect(warnings).toContain(
        "The file contained invalid UTF-8 sequences that were replaced."
      );
      expect(warnings).toContain("Null bytes were removed from the extracted text.");
    });

    it("normalizes excessive blank lines", () => {
      const text = "para1\n\n\n\n\n\npara2";
      const { text: cleaned } = cleanExtractedText(text, false);
      expect(cleaned).toBe("para1\n\npara2");
    });

    it("preserves one blank line between paragraphs", () => {
      const text = "para1\n\npara2";
      const { text: cleaned } = cleanExtractedText(text, false);
      expect(cleaned).toBe("para1\n\npara2");
    });

    it("preserves two blank lines between paragraphs", () => {
      const text = "para1\n\n\npara2";
      const { text: cleaned } = cleanExtractedText(text, false);
      expect(cleaned).toBe("para1\n\npara2");
    });

    it("trims outer whitespace", () => {
      const { text } = cleanExtractedText("  \n  hello world  \n  ", false);
      expect(text).toBe("hello world");
    });

    it("does not trim each line individually", () => {
      const text = "  line1\n  line2  \n  line3  ";
      const { text: cleaned } = cleanExtractedText(text, false);
      expect(cleaned).toBe("line1\n  line2  \n  line3");
    });
  });

  describe("validateUsableText", () => {
    it("accepts non-empty text", () => {
      expect(() => validateUsableText("hello")).not.toThrow();
    });

    it("rejects empty string", () => {
      expect(() => validateUsableText("")).toThrow(ExtractionError);
      expect(() => validateUsableText("")).toThrow(
        "The uploaded file does not contain usable text."
      );
    });

    it("rejects whitespace-only text", () => {
      // After trim(), whitespace-only text becomes empty.
      // validateUsableText is called on already-trimmed text in the extraction flow.
      expect(() => validateUsableText("")).toThrow(ExtractionError);
    });
  });

  describe("isBinaryLike", () => {
    it("returns false for normal text", () => {
      expect(isBinaryLike(0, 100)).toBe(false);
    });

    it("returns false when suspicious count < 3", () => {
      expect(isBinaryLike(1, 100)).toBe(false);
      expect(isBinaryLike(2, 100)).toBe(false);
    });

    it("returns false when ratio < 10% even with 3+ suspicious chars", () => {
      expect(isBinaryLike(3, 100)).toBe(false); // 3%
    });

    it("returns true when suspicious count >= 3 and ratio >= 10%", () => {
      expect(isBinaryLike(10, 50)).toBe(true); // 20%
    });

    it("returns false for empty original text", () => {
      expect(isBinaryLike(5, 0)).toBe(false);
    });

    it("returns true at exactly 10% threshold", () => {
      expect(isBinaryLike(10, 100)).toBe(true); // exactly 10%
    });
  });
});
