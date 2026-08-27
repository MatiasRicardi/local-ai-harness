import { ExtractionError } from "./ExtractionError.js";

/**
 * Suspicious control character ranges (code points).
 * Excludes normal text whitespace: \t (U+0009), \n (U+000A), \r (U+000D).
 */
const SUSPICIOUS_CONTROL_RANGES: [number, number][] = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
];

/**
 * Count suspicious control characters in a decoded string.
 * Suspicious = code points in ranges like U+0000-U+0008, U+000B, U+000C, U+000E-U+001F.
 * Normal text whitespace (tab, newline, carriage return) is excluded.
 */
/**
 * Count Unicode code points in a string.
 * Surrogate pairs (astral characters) count as one code point.
 */
export function countCodePoints(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i);
    if (cp === undefined) continue;
    if (cp > 0xffff) i++; // skip surrogate pair second half
    count++;
  }
  return count;
}

export function countSuspiciousControls(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i);
    if (cp === undefined) continue;
    if (cp > 0xffff) i++; // skip surrogate pair second half

    let suspicious = false;
    for (const [lo, hi] of SUSPICIOUS_CONTROL_RANGES) {
      if (cp >= lo && cp <= hi) {
        suspicious = true;
        break;
      }
    }
    if (suspicious) count++;
  }
  return count;
}

/**
 * Normalize excessive consecutive blank lines to at most one.
 * A blank line is a line containing only whitespace (or empty).
 * Handles LF, CRLF, and blank lines containing spaces or tabs.
 * Preserves indentation on non-blank lines (e.g., Markdown code blocks).
 */
function normalizeBlankLines(text: string): string {
  // First, normalize all line endings to LF
  const lfText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Collapse runs of 2+ blank lines (whitespace-only) to exactly one blank line.
  // [^\S\r\n] matches spaces/tabs but NOT newlines, so indentation on non-blank lines is preserved.
  return lfText.replace(/\n(?:[^\S\r\n]*\n)+/g, "\n\n");
}

/**
 * Clean extracted text: remove null bytes, normalize blank lines, trim outer whitespace.
 * Returns the cleaned text and a list of warnings.
 */
export function cleanExtractedText(
  rawText: string,
  hasInvalidUtf8: boolean,
): { text: string; warnings: string[] } {
  const warnings: string[] = [];

  if (hasInvalidUtf8) {
    warnings.push(
      "The file contained invalid UTF-8 sequences that were replaced."
    );
  }

  // Remove null bytes
  const nullCount = (rawText.match(/\u0000/g) || []).length;
  let text = rawText.replace(/\u0000/g, "");
  if (nullCount > 0) {
    warnings.push("Null bytes were removed from the extracted text.");
  }

  // Normalize excessive blank lines
  text = normalizeBlankLines(text);

  // Trim outer whitespace only
  text = text.trim();

  return { text, warnings };
}

/**
 * Validate that cleaned text contains usable content.
 * Throws ExtractionError if the text is empty, whitespace-only, or null-only.
 */
export function validateUsableText(text: string): void {
  if (text.length === 0) {
    throw new ExtractionError(
      "The uploaded file does not contain usable text."
    );
  }
}

/**
 * Check if content appears to be binary-like based on suspicious control characters.
 * Returns true if the content should be rejected as binary.
 *
 * Policy: reject when there are at least 3 suspicious control characters
 * AND they represent about 10% or more of the decoded text.
 */
export function isBinaryLike(
  suspiciousControlCount: number,
  originalLength: number,
): boolean {
  if (suspiciousControlCount < 3) return false;
  if (originalLength === 0) return false;
  const ratio = suspiciousControlCount / originalLength;
  return ratio >= 0.1;
}
