import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import { extractTxt } from "./txt.js";
import { ExtractionError } from "./ExtractionError.js";

describe("txt extractor", () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = join(os.tmpdir(), `extractor-test-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("extracts normal TXT content", async () => {
    const filePath = join(testDir, "normal.txt");
    await writeFile(filePath, "Hello, this is a test text file.");

    const result = await extractTxt(filePath);

    expect(result.text).toBe("Hello, this is a test text file.");
    expect(result.characterCount).toBe(32);
    expect(result.warnings).toHaveLength(0);
  });

  it("extracts TXT with multiple paragraphs", async () => {
    const filePath = join(testDir, "paragraphs.txt");
    await writeFile(filePath, "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.");

    const result = await extractTxt(filePath);

    expect(result.text).toBe("First paragraph.\n\nSecond paragraph.\n\nThird paragraph.");
    expect(result.warnings).toHaveLength(0);
  });

  it("extracts TXT with leading/trailing whitespace", async () => {
    const filePath = join(testDir, "whitespace.txt");
    await writeFile(filePath, "  \n  Hello world  \n  ");

    const result = await extractTxt(filePath);

    expect(result.text).toBe("Hello world");
    expect(result.warnings).toHaveLength(0);
  });

  it("rejects empty file", async () => {
    const filePath = join(testDir, "empty.txt");
    await writeFile(filePath, "");

    await expect(extractTxt(filePath)).rejects.toThrow(ExtractionError);
    await expect(extractTxt(filePath)).rejects.toThrow(
      "The uploaded file does not contain usable text."
    );
  });

  it("rejects whitespace-only file", async () => {
    const filePath = join(testDir, "whitespace-only.txt");
    await writeFile(filePath, "   \n\t  \n   ");

    await expect(extractTxt(filePath)).rejects.toThrow(ExtractionError);
  });

  it("removes null bytes and warns", async () => {
    const filePath = join(testDir, "null-bytes.txt");
    await writeFile(filePath, "hello\u0000world", "utf8");

    const result = await extractTxt(filePath);

    expect(result.text).toBe("helloworld");
    expect(result.warnings).toContain(
      "Null bytes were removed from the extracted text."
    );
  });

  it("handles invalid UTF-8 safely with warning", async () => {
    // Create a file with actual invalid UTF-8 bytes
    const filePath = join(testDir, "invalid-utf8.txt");
    // 0x80 is an invalid UTF-8 start byte
    const content = Buffer.from([0x48, 0x65, 0x6C, 0x6C, 0x6F, 0x80, 0x2C, 0x20, 0x57, 0x6F, 0x72, 0x6C, 0x64]);
    await writeFile(filePath, content);

    const result = await extractTxt(filePath);

    // Node replaces invalid UTF-8 with U+FFFD
    expect(result.text).toContain("Hello");
    expect(result.text).toContain("World");
    expect(result.warnings).toContain(
      "The file contained invalid UTF-8 sequences that were replaced."
    );
  });

  it("rejects null-only file", async () => {
    const filePath = join(testDir, "null-only.txt");
    await writeFile(filePath, "\u0000\u0000\u0000", "utf8");

    await expect(extractTxt(filePath)).rejects.toThrow(ExtractionError);
  });

  it("normalizes excessive blank lines conservatively", async () => {
    const filePath = join(testDir, "blank-lines.txt");
    await writeFile(filePath, "line1\n\n\n\n\n\n\nline2");

    const result = await extractTxt(filePath);

    expect(result.text).toBe("line1\n\nline2");
    expect(result.warnings).toHaveLength(0);
  });

  it("accepts Unicode text", async () => {
    const filePath = join(testDir, "unicode.txt");
    const content = "Olá mundo\n你好世界\nПривет мир\nこんにちは";
    await writeFile(filePath, content);

    const result = await extractTxt(filePath);

    expect(result.text).toBe(content);
    expect(result.warnings).toHaveLength(0);
  });

  it("rejects binary-like content", async () => {
    const filePath = join(testDir, "binary-like.txt");
    // Create content dominated by suspicious control characters (U+0001-U+0008)
    const binaryContent = "\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u0008"
      + "\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u0008"
      + "\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u0008"
      + "\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u0008";
    await writeFile(filePath, binaryContent);

    await expect(extractTxt(filePath)).rejects.toThrow(ExtractionError);
    await expect(extractTxt(filePath)).rejects.toThrow(
      "The uploaded file does not appear to contain usable text."
    );
  });

  it("accepts text with small amount of unusual content", async () => {
    const filePath = join(testDir, "mostly-text.txt");
    // A single suspicious char in a large text body should not trigger rejection
    const text = "a".repeat(100) + "\u0001" + "b".repeat(100);
    await writeFile(filePath, text);

    const result = await extractTxt(filePath);

    expect(result.text.length).toBeGreaterThan(0);
    // The suspicious char should be preserved (not removed)
    expect(result.text).toContain("\u0001");
  });

  it("returns correct character count", async () => {
    const filePath = join(testDir, "count.txt");
    const content = "Hello, world!";
    await writeFile(filePath, content);

    const result = await extractTxt(filePath);

    expect(result.characterCount).toBe(13);
    expect(result.characterCount).toBe(result.text.length);
  });
});
