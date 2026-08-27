import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import { extractMarkdown } from "./markdown.js";
import { ExtractionError } from "./ExtractionError.js";

describe("markdown extractor", () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = join(os.tmpdir(), `extractor-test-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("extracts normal Markdown content preserving syntax", async () => {
    const filePath = join(testDir, "normal.md");
    const content = "# Project Notes\n\n## Setup\n\nRun:\n\n```bash\npnpm install\n```\n\n- Item one\n- Item two";
    await writeFile(filePath, content);

    const result = await extractMarkdown(filePath);

    expect(result.text).toBe(content);
    expect(result.warnings).toHaveLength(0);
  });

  it("preserves Markdown headings", async () => {
    const filePath = join(testDir, "headings.md");
    const content = "# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6";
    await writeFile(filePath, content);

    const result = await extractMarkdown(filePath);

    expect(result.text).toBe(content);
    expect(result.text).toContain("# H1");
    expect(result.text).toContain("###### H6");
  });

  it("preserves Markdown code blocks", async () => {
    const filePath = join(testDir, "code-blocks.md");
    const content = "```python\nprint('hello')\n```";
    await writeFile(filePath, content);

    const result = await extractMarkdown(filePath);

    expect(result.text).toBe(content);
    expect(result.text).toContain("```python");
    expect(result.text).toContain("```");
  });

  it("preserves Markdown links", async () => {
    const filePath = join(testDir, "links.md");
    const content = "[Example](https://example.com)";
    await writeFile(filePath, content);

    const result = await extractMarkdown(filePath);

    expect(result.text).toBe(content);
    expect(result.text).toContain("[Example]");
    expect(result.text).toContain("(https://example.com)");
  });

  it("preserves Markdown bold and italic", async () => {
    const filePath = join(testDir, "formatting.md");
    const content = "**bold** and *italic* and ~~strikethrough~~";
    await writeFile(filePath, content);

    const result = await extractMarkdown(filePath);

    expect(result.text).toBe(content);
  });

  it("does not convert Markdown to HTML", async () => {
    const filePath = join(testDir, "no-html.md");
    const content = "# Title\n\nSome text.";
    await writeFile(filePath, content);

    const result = await extractMarkdown(filePath);

    expect(result.text).not.toContain("<h1>");
    expect(result.text).not.toContain("<p>");
    expect(result.text).not.toContain("<html>");
  });

  it("rejects empty Markdown file", async () => {
    const filePath = join(testDir, "empty.md");
    await writeFile(filePath, "");

    await expect(extractMarkdown(filePath)).rejects.toThrow(ExtractionError);
  });

  it("rejects whitespace-only Markdown file", async () => {
    const filePath = join(testDir, "whitespace-only.md");
    await writeFile(filePath, "   \n\n  \t  \n");

    await expect(extractMarkdown(filePath)).rejects.toThrow(ExtractionError);
  });

  it("handles Markdown with null bytes", async () => {
    const filePath = join(testDir, "null-bytes.md");
    const content = "# Notes\n\nHello\u0000World";
    await writeFile(filePath, content);

    const result = await extractMarkdown(filePath);

    expect(result.text).toBe("# Notes\n\nHelloWorld");
    expect(result.warnings).toContain("Null bytes were removed from the extracted text.");
  });

  it("handles invalid UTF-8 safely", async () => {
    const filePath = join(testDir, "invalid-utf8.md");
    const content = Buffer.from([0x23, 0x20, 0x54, 0x69, 0x74, 0x6C, 0x65, 0x80, 0x0A, 0x54, 0x65, 0x78, 0x74]);
    await writeFile(filePath, content);

    const result = await extractMarkdown(filePath);

    expect(result.text).toContain("Title");
    expect(result.text).toContain("Text");
    expect(result.warnings).toContain(
      "The file contained invalid UTF-8 sequences that were replaced."
    );
  });

  it("preserves Markdown list markers", async () => {
    const filePath = join(testDir, "lists.md");
    const content = "- Item 1\n- Item 2\n- Item 3\n\n1. One\n2. Two\n3. Three";
    await writeFile(filePath, content);

    const result = await extractMarkdown(filePath);

    expect(result.text).toBe(content);
    expect(result.text).toContain("- Item 1");
    expect(result.text).toContain("1. One");
  });
});
