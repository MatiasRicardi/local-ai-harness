import { describe, it, expect, afterEach, afterAll, beforeAll, vi } from "vitest";
import { buildApp } from "../app.js";
import { overrideConfig, config } from "../config/env.js";
import { randomUUID } from "node:crypto";
import { mkdir, rm, readdir } from "node:fs/promises";
import * as fs from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { Writable } from "node:stream";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual("node:fs");
  return {
    ...actual,
    createWriteStream: vi.fn((_path: unknown) =>
      (actual as typeof import("node:fs")).createWriteStream(_path as string),
    ),
  };
});

const BOUNDARY = "----TestBoundary" + randomUUID();

/**
 * Construct a multipart form-data body for a single file.
 */
function buildMultipartBody(filename: string, mimeType: string, content: string | Buffer): Buffer {
  const header = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const footer = `\r\n--${BOUNDARY}--\r\n`;

  const contentBuffer = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
  const body = Buffer.concat([
    Buffer.from(header, "utf-8"),
    contentBuffer,
    Buffer.from(footer, "utf-8"),
  ]);

  return body;
}

describe("file upload endpoint", () => {
  let app: ReturnType<typeof buildApp> | undefined;
  let testUploadDir: string;
  const originalUploadDir = config.UPLOAD_DIR;

  beforeAll(async () => {
    testUploadDir = join(os.tmpdir(), `local-ai-harness-tests-${randomUUID()}`);
    await mkdir(testUploadDir, { recursive: true });
    // Override upload directory for test isolation
    overrideConfig({ UPLOAD_DIR: testUploadDir });
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    // Clean up test upload directory contents
    try {
      await rm(testUploadDir, { recursive: true, force: true });
      await mkdir(testUploadDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  afterAll(async () => {
    try {
      await rm(testUploadDir, { recursive: true, force: true });
    } finally {
      overrideConfig({ UPLOAD_DIR: originalUploadDir });
    }
  });

  it("uploads a .txt file successfully", async () => {
    app = buildApp();

    const content = "Hello, this is a test text file.";
    const body = buildMultipartBody("test.txt", "text/plain", content);

    const response = await app.inject({
      method: "POST",
      url: "/api/files",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    const json = JSON.parse(response.body);
    expect(json.success).toBe(true);
    expect(json.fileId).toBeDefined();
    expect(json.fileId).toMatch(/^[0-9a-f-]{36}$/);
    expect(json.originalFilename).toBe("test.txt");
    expect(json.size).toBeGreaterThan(0);
    expect(json.type).toBe("text/plain");

    // Verify the file was saved with the generated ID (upload dir is from config)
    // For this test we just verify the response is correct
  });

  it("uploads a .md file successfully", async () => {
    app = buildApp();

    const content = "# Test Markdown\n\nThis is a test.";
    const body = buildMultipartBody("doc.md", "text/markdown", content);

    const response = await app.inject({
      method: "POST",
      url: "/api/files",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    const json = JSON.parse(response.body);
    expect(json.success).toBe(true);
    expect(json.fileId).toBeDefined();
    expect(json.originalFilename).toBe("doc.md");
    expect(json.type).toBe("text/markdown");
  });

  it("uploads a .pdf file successfully", async () => {
    app = buildApp();

    // Minimal PDF content (just enough to be a valid upload)
    const content = "%PDF-1.4 minimal test pdf";
    const body = buildMultipartBody("report.pdf", "application/pdf", content);

    const response = await app.inject({
      method: "POST",
      url: "/api/files",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    const json = JSON.parse(response.body);
    expect(json.success).toBe(true);
    expect(json.fileId).toBeDefined();
    expect(json.originalFilename).toBe("report.pdf");
    expect(json.type).toBe("application/pdf");
  });

  it("generates a UUID that is different from the original filename", async () => {
    app = buildApp();

    const content = "test content";
    const body = buildMultipartBody("my-document.txt", "text/plain", content);

    const response = await app.inject({
      method: "POST",
      url: "/api/files",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    const json = JSON.parse(response.body);
    expect(json.fileId).not.toBe("my-document.txt");
    expect(json.fileId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("rejects unsupported file extension (.exe)", async () => {
    app = buildApp();

    const content = "malware content";
    const body = buildMultipartBody("malware.exe", "application/x-executable", content);

    const response = await app.inject({
      method: "POST",
      url: "/api/files",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    const json = JSON.parse(response.body);
    expect(json.success).toBe(false);
    expect(json.error).toContain("not supported");
  });

  it("rejects request without a file", async () => {
    app = buildApp();

    const body = Buffer.from(`--${BOUNDARY}--\r\n`);

    const response = await app.inject({
      method: "POST",
      url: "/api/files",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    const json = JSON.parse(response.body);
    expect(json.success).toBe(false);
    expect(json.error).toContain("No file uploaded");
  });

  it("rejects oversized files", async () => {
    // Create a test app with a very small file size limit
    const Fastify = (await import("fastify")).default;
    const multipart = (await import("@fastify/multipart")).default;
    const cors = (await import("@fastify/cors")).default;
    const sse = (await import("@fastify/sse")).default;

    const testApp = Fastify({
      bodyLimit: 10 * 1024 * 1024, // 10 MB - high enough not to interfere
    });

    try {
      await testApp.register(cors, {
        origin: ["http://localhost:5173"],
      });
      await testApp.register(sse);
      await testApp.register(multipart, {
        limits: {
          fileSize: 1024, // 1 KB - this is what we're testing
          files: 1,
        },
      });

      // Register the files route
      const filesRoute = (await import("./files.js")).default;
      await testApp.register(filesRoute);

      // Create a file larger than 1 KB
      const largeContent = "x".repeat(2048);
      const body = buildMultipartBody("big.txt", "text/plain", largeContent);

      const response = await testApp.inject({
        method: "POST",
        url: "/api/files",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`,
        },
        payload: body,
      });

      expect(response.statusCode).toBe(413);
      const json = JSON.parse(response.body);
      expect(json.success).toBe(false);
      expect(json.error).toContain("maximum allowed size");

      // Verify no partial files remain in the upload directory
      const filesAfter = await readdir(testUploadDir);
      expect(filesAfter).toHaveLength(0);
    } finally {
      await testApp.close();
    }
  });

  // --- Step 15.2 hardening tests ---

  it("accepts uppercase extension (REPORT.PDF)", async () => {
    app = buildApp();

    const content = "REPORT CONTENT";
    const body = buildMultipartBody("REPORT.PDF", "application/pdf", content);

    const response = await app.inject({
      method: "POST",
      url: "/api/files",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    const json = JSON.parse(response.body);
    expect(json.success).toBe(true);
    expect(json.originalFilename).toBe("REPORT.PDF");
    expect(json.type).toBe("application/pdf");
  });

  it("rejects double extension (statement.pdf.exe)", async () => {
    app = buildApp();

    const content = "malicious payload";
    const body = buildMultipartBody("statement.pdf.exe", "application/octet-stream", content);

    const response = await app.inject({
      method: "POST",
      url: "/api/files",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    const json = JSON.parse(response.body);
    expect(json.success).toBe(false);
    expect(json.error).toContain("not supported");
  });

  it("rejects unsupported extension with allowed MIME (payload.exe + application/pdf)", async () => {
    app = buildApp();

    const content = "fake pdf content pretending to be exe";
    const body = buildMultipartBody("payload.exe", "application/pdf", content);

    const response = await app.inject({
      method: "POST",
      url: "/api/files",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    const json = JSON.parse(response.body);
    expect(json.success).toBe(false);
    expect(json.error).toContain("not supported");
  });

  it("rejects allowed extension with incompatible MIME (.pdf + text/plain)", async () => {
    app = buildApp();

    const content = "this is plain text, not a pdf";
    const body = buildMultipartBody("payload.pdf", "text/plain", content);

    const response = await app.inject({
      method: "POST",
      url: "/api/files",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    const json = JSON.parse(response.body);
    expect(json.success).toBe(false);
    expect(json.error).toContain("not allowed");
  });

  it("path traversal filename cannot escape temp directory", async () => {
    app = buildApp();

    const hostileFilenames = [
      "../../etc/passwd.pdf",
      "../secret.txt",
      "..\\..\\secret.txt",
      "/tmp/evil.pdf",
      "folder/subfolder/file.pdf",
    ];

    for (const filename of hostileFilenames) {
      const content = "evil content";
      const body = buildMultipartBody(filename, "application/pdf", content);

      const response = await app.inject({
        method: "POST",
        url: "/api/files",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`,
        },
        payload: body,
      });

      // The filename may be accepted (200) or rejected (400) by the parser
      // Either way, the stored file (if any) must use a UUID, not the original filename
      const files = await readdir(testUploadDir);
      const storedFile = files.find((f) => f.endsWith(".pdf") || f.endsWith(".txt"));

      if (response.statusCode === 200) {
        expect(storedFile).toBeDefined();
        expect(storedFile).toMatch(/^[0-9a-f-]{36}\.(pdf|txt)$/);
      } else {
        expect(response.statusCode).toBe(400);
        expect(storedFile).toBeUndefined();
      }

      // Verify response does not expose any filesystem path
      const responseBody = response.body;
      expect(responseBody).not.toContain(testUploadDir);
      expect(responseBody).not.toContain("/tmp");

      // Clean up for next iteration
      await rm(testUploadDir, { recursive: true, force: true });
      await mkdir(testUploadDir, { recursive: true });
    }
  });

  it("multi-file upload: rejects with 400 when two files are sent", async () => {
    app = buildApp();

    // Build a multipart body with TWO file parts
    const header1 = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="file1.txt"\r\nContent-Type: text/plain\r\n\r\n`;
    const content1 = "first file content";
    const header2 = `\r\n--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="file2.txt"\r\nContent-Type: text/plain\r\n\r\n`;
    const content2 = "second file content";
    const footer = `\r\n--${BOUNDARY}--\r\n`;

    const body = Buffer.concat([
      Buffer.from(header1, "utf-8"),
      Buffer.from(content1, "utf-8"),
      Buffer.from(header2, "utf-8"),
      Buffer.from(content2, "utf-8"),
      Buffer.from(footer, "utf-8"),
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/api/files",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`,
        "Content-Length": String(body.length),
      },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    const json = JSON.parse(response.body);
    expect(json.success).toBe(false);
    expect(json.error).toContain("Only one file is allowed");

    // Verify no files from this rejected request remain in the upload directory
    const filesAfter = await readdir(testUploadDir);
    expect(filesAfter).toHaveLength(0);
  });

  it("duplicate original filenames do not collide", async () => {
    app = buildApp();

    const content = "same filename upload";
    const body1 = buildMultipartBody("statement.pdf", "application/pdf", content);
    const body2 = buildMultipartBody("statement.pdf", "application/pdf", content);

    const response1 = await app.inject({
      method: "POST",
      url: "/api/files",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: body1,
    });

    const response2 = await app.inject({
      method: "POST",
      url: "/api/files",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: body2,
    });

    expect(response1.statusCode).toBe(200);
    expect(response2.statusCode).toBe(200);

    const json1 = JSON.parse(response1.body);
    const json2 = JSON.parse(response2.body);

    expect(json1.fileId).not.toBe(json2.fileId);
    expect(json1.originalFilename).toBe("statement.pdf");
    expect(json2.originalFilename).toBe("statement.pdf");

    // Verify two distinct files exist in the upload directory
    const files = await readdir(testUploadDir);
    expect(files.filter((f) => f.endsWith(".pdf"))).toHaveLength(2);
  });

  it("response never exposes filesystem path", async () => {
    app = buildApp();

    const content = "test content for path exposure check";
    const body = buildMultipartBody("safe.txt", "text/plain", content);

    const response = await app.inject({
      method: "POST",
      url: "/api/files",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    const responseBody = response.body;
    expect(responseBody).not.toContain(testUploadDir);
    expect(responseBody).not.toContain("/tmp/");
    expect(responseBody).not.toContain("uploads");
  });

  it("write failure removes partial file", async () => {
    const Fastify = (await import("fastify")).default;
    const multipart = (await import("@fastify/multipart")).default;
    const cors = (await import("@fastify/cors")).default;
    const sse = (await import("@fastify/sse")).default;

    // Use the valid test upload directory so mkdir succeeds and destinationPath gets assigned.
    // This ensures the cleanup branch (which checks destinationPath) is actually exercised.
    overrideConfig({ UPLOAD_DIR: testUploadDir });

    // Override createWriteStream to simulate a write failure after destinationPath is assigned.
    // The implementation creates a partial file on disk, then returns a stream that errors,
    // so we can verify the cleanup branch actually removes the partial file.
    const errorStream = new Writable({
      write(
        _chunk: Buffer,
        _encoding: string,
        callback: (err: Error | null) => void,
      ) {
        callback(new Error("simulated write failure"));
      },
    });
    const createWriteStreamMock = fs.createWriteStream as unknown as {
      mockImplementation: (fn: (path: unknown) => Writable) => void;
      mockRestore: () => void;
    };
    createWriteStreamMock.mockImplementation((_path: unknown) => {
      // Create a partial file on disk to simulate what happens before the write fails.
      // This allows us to verify the cleanup branch actually removes it.
      fs.writeFileSync(_path as string, "partial content");
      return errorStream;
    });

    const testApp = Fastify({
      bodyLimit: 10 * 1024 * 1024,
    });

    try {
      await testApp.register(cors, {
        origin: ["http://localhost:5173"],
      });
      await testApp.register(sse);
      await testApp.register(multipart, {
        limits: {
          fileSize: 10 * 1024 * 1024,
          files: 1,
        },
      });

      const filesRoute = (await import("./files.js")).default;
      await testApp.register(filesRoute);

      const content = "this should fail to write";
      const body = buildMultipartBody("fail.txt", "text/plain", content);

      const response = await testApp.inject({
        method: "POST",
        url: "/api/files",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`,
        },
        payload: body,
      });

      // Should fail with 500 due to write stream error
      expect(response.statusCode).toBe(500);
      const json = JSON.parse(response.body);
      expect(json.success).toBe(false);

      // Verify the cleanup branch removed the partial file from the upload directory
      const filesAfter = await readdir(testUploadDir);
      expect(filesAfter).toHaveLength(0);
    } finally {
      createWriteStreamMock.mockRestore();
      await testApp.close();
    }
  });

  it("markdown with text/plain MIME succeeds", async () => {
    app = buildApp();

    const content = "# Test\n\nSome markdown content.";
    const body = buildMultipartBody("notes.md", "text/plain", content);

    const response = await app.inject({
      method: "POST",
      url: "/api/files",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    const json = JSON.parse(response.body);
    expect(json.success).toBe(true);
    expect(json.type).toBe("text/plain");
  });
});
