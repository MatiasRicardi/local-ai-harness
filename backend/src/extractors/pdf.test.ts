import { describe, it, beforeAll, afterAll } from "vitest";
import { extractPdf } from "./pdf.js";
import { ExtractionError } from "./ExtractionError.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";


const FIXTURES_DIR = new URL("../../test/fixtures/pdf/", import.meta.url).pathname;

describe("extractPdf", () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pdf-test-"));
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("extracts text from a valid PDF", async () => {
    const filePath = join(FIXTURES_DIR, "text.pdf");
    const result = await extractPdf(filePath);

    if (!result) throw new Error("Expected extraction result");

    if (result.text !== "Hello World Fixture") {
      throw new Error(`Expected "Hello World Fixture", got "${result.text}"`);
    }

    if (result.characterCount !== result.text.length) {
      throw new Error("characterCount mismatch");
    }

    if (result.pageCount !== 1) {
      throw new Error(`Expected 1 page, got ${result.pageCount}`);
    }
  });

  it("extracts text from a multi-page PDF", async () => {
    const filePath = join(FIXTURES_DIR, "multipage.pdf");
    const result = await extractPdf(filePath);

    if (!result) throw new Error("Expected extraction result");

    if (result.pageCount !== 2) {
      throw new Error(`Expected 2 pages, got ${result.pageCount}`);
    }

    if (!result.text.includes("FIRST PAGE MARKER")) {
      throw new Error("Missing FIRST PAGE MARKER");
    }

    if (!result.text.includes("SECOND PAGE MARKER")) {
      throw new Error("Missing SECOND PAGE MARKER");
    }

    // Pages should be separated by double newline
    if (!result.text.includes("\n\n")) {
      throw new Error("Expected page separator (double newline)");
    }
  });

  it("throws ExtractionError for PDF with no text", async () => {
    const filePath = join(FIXTURES_DIR, "no-text.pdf");

    try {
      await extractPdf(filePath);
      throw new Error("Expected ExtractionError");
    } catch (err) {
      if (!(err instanceof ExtractionError)) {
        throw new Error(`Expected ExtractionError, got ${err}`);
      }
      if (!err.message.includes("no extractable text")) {
        throw new Error(`Expected "no extractable text" message, got: ${err.message}`);
      }
    }
  });

  it("throws ExtractionError for malformed PDF", async () => {
    const filePath = join(FIXTURES_DIR, "malformed.pdf");

    try {
      await extractPdf(filePath);
      throw new Error("Expected ExtractionError");
    } catch (err) {
      if (!(err instanceof ExtractionError)) {
        throw new Error(`Expected ExtractionError, got ${err}`);
      }
      if (!err.message.includes("could not be processed")) {
        throw new Error(`Expected "could not be processed" message, got: ${err.message}`);
      }
    }
  });

  it("re-throws readFile failure as unexpected error (500 path)", async () => {
    const filePath = join(tempDir, "nonexistent.pdf");

    try {
      await extractPdf(filePath);
      throw new Error("Expected error to be thrown");
    } catch (err) {
      // readFile failure is unexpected/internal — should NOT be ExtractionError
      if (err instanceof ExtractionError) {
        throw new Error(
          `readFile failure should not produce ExtractionError, got: ${err.message}`,
        );
      }
      // Should be a generic Node error (ENOENT)
      if (!(err instanceof Error)) {
        throw new Error(`Expected Error instance, got ${err}`);
      }
    }
  });

  it("throws ExtractionError for non-PDF file", async () => {
    const filePath = join(tempDir, "not-a-pdf.txt");
    await writeFile(filePath, "This is not a PDF file");

    try {
      await extractPdf(filePath);
      throw new Error("Expected ExtractionError");
    } catch (err) {
      if (!(err instanceof ExtractionError)) {
        throw new Error(`Expected ExtractionError, got ${err}`);
      }
      if (!err.message.includes("could not be processed")) {
        throw new Error(`Expected "could not be processed" message, got: ${err.message}`);
      }
    }
  });
});

// Helper to write a file for testing
async function writeFile(path: string, content: string | Uint8Array): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  if (typeof content === "string") {
    await writeFile(path, content);
  } else {
    await writeFile(path, content);
  }
}
