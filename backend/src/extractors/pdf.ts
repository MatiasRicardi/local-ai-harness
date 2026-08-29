import { readFile } from "node:fs/promises";
import { getDocumentProxy, extractText } from "unpdf";
import type { PdfExtractionResult } from "./types.js";
import { ExtractionError } from "./ExtractionError.js";

const MAX_PAGES = 100;
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB per image
const EXTRACTION_TIMEOUT_MS = 60_000; // 60 seconds

/**
 * Extract text from a PDF file using unpdf.
 *
 * Supports PDFs with selectable text.
 * PDFs with no usable text (e.g. scanned/image-only) throw ExtractionError.
 * Malformed/corrupt PDFs are normalized to a safe ExtractionError message.
 *
 * Resources are bounded: image size is capped, page count is rejected above
 * MAX_PAGES, and extraction is enforced with a timeout to prevent DoS.
 */
export async function extractPdf(filePath: string): Promise<PdfExtractionResult> {
  // readFile failures (e.g. file deleted between stream-write and extraction)
  // are unexpected/internal — let them propagate to the 500 path.
  const buffer = await readFile(filePath);
  const data: ArrayBuffer = new Uint8Array(buffer).buffer;

  let totalPages: number;
  let pageTexts: string[];

  try {
    // Load with bounded parameters to prevent resource exhaustion
    const doc = await getDocumentProxy(data, {
      maxImageSize: MAX_IMAGE_SIZE,
    });

    // Reject documents exceeding the page limit before extraction
    if (doc.numPages > MAX_PAGES) {
      throw new ExtractionError(
        `The PDF contains ${doc.numPages} pages, which exceeds the maximum allowed (${MAX_PAGES}).`,
      );
    }

    // Enforce extraction timeout to prevent hung requests
    const extractionPromise = extractText(doc, { mergePages: false });
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`PDF extraction timed out after ${EXTRACTION_TIMEOUT_MS}ms`)),
        EXTRACTION_TIMEOUT_MS,
      );
    });
    const result = await Promise.race([extractionPromise, timeoutPromise]);
    totalPages = result.totalPages;
    pageTexts = result.text;
  } catch (err) {
    // Normalize PDF parsing errors to safe messages
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorName = err instanceof Error ? err.name : "Unknown";

    // Known unpdf/PDF.js error types for invalid documents
    if (
      errorName === "InvalidPDFException" ||
      errorMessage.includes("Invalid PDF") ||
      errorMessage.includes("not a PDF") ||
      errorMessage.includes("is not a PDF") ||
      errorMessage.includes("Invalid PDF structure")
    ) {
      throw new ExtractionError("The PDF could not be processed.");
    }

    // Other parser-level errors (corrupt structure, truncated, etc.)
    if (
      errorMessage.includes("Unexpected token") ||
      errorMessage.includes("unexpected end") ||
      errorMessage.includes("Trailer") ||
      errorMessage.includes("xref") ||
      errorName === "XRef" ||
      errorName === "SyntaxError" ||
      errorName === "XRefEntryException" ||
      errorName === "FormatError"
    ) {
      throw new ExtractionError("The PDF could not be processed.");
    }

    // Timeout errors from extraction
    if (errorMessage.includes("timed out")) {
      throw new ExtractionError(
        "The PDF extraction took too long and was cancelled.",
      );
    }

    // Re-throw unexpected errors (runtime, programming) as-is for 500 path
    throw err;
  }

  // Clean each page's text conservatively
  const cleanedPages = pageTexts.map(cleanPdfPageText);

  // Join pages with double newline separator
  const finalText = cleanedPages.join("\n\n");

  // Reject PDFs with no usable extracted text
  if (!finalText.trim()) {
    throw new ExtractionError(
      "The PDF contains little or no extractable text and may be a scanned document.",
    );
  }

  return {
    text: finalText,
    characterCount: finalText.length,
    pageCount: totalPages,
    warnings: [],
  };
}

/**
 * Conservatively clean extracted PDF page text.
 *
 * Allowed:
 * - Normalize CRLF/CR to LF
 * - Remove null characters
 * - Reduce excessive blank-line runs
 * - Trim leading/trailing whitespace
 *
 * NOT allowed:
 * - Flattening to single paragraph
 * - Reconstructing columns, tables, or hyphenated words
 */
function cleanPdfPageText(text: string): string {
  let cleaned = text;

  // Normalize line endings
  cleaned = cleaned.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Remove null characters
  cleaned = cleaned.replace(/\u0000/g, "");

  // Reduce excessive blank-line runs (3+ newlines → 2)
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");

  // Trim outer whitespace
  cleaned = cleaned.trim();

  return cleaned;
}
