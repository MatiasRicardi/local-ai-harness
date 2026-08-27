import { readFile } from "node:fs/promises";
import { ExtractionResult } from "./types.js";
import {
  cleanExtractedText,
  isBinaryLike,
  validateUsableText,
  countSuspiciousControls,
  countCodePoints,
} from "./text-utils.js";
import { ExtractionError } from "./ExtractionError.js";

/**
 * Extract text from a .md file.
 * Markdown syntax is preserved as plain text — not parsed or rendered.
 */
export async function extractMarkdown(filePath: string): Promise<ExtractionResult> {
  let rawText: string;
  let hasInvalidUtf8 = false;

  try {
    rawText = await readFile(filePath, "utf8");
  } catch {
    throw new ExtractionError("Failed to read uploaded file.");
  }

  // Detect invalid UTF-8 (replacement characters)
  const replacementChars = (rawText.match(/\uFFFD/g) || []).length;
  if (replacementChars > 0) {
    hasInvalidUtf8 = true;
  }

  const originalLength = countCodePoints(rawText);
  const suspiciousControlCount = countSuspiciousControls(rawText);

  // Binary-like check before cleanup
  if (isBinaryLike(suspiciousControlCount, originalLength)) {
    throw new ExtractionError(
      "The uploaded file does not appear to contain usable text."
    );
  }

  const { text, warnings } = cleanExtractedText(rawText, hasInvalidUtf8);

  validateUsableText(text);

  return {
    text,
    characterCount: text.length,
    warnings,
  };
}
