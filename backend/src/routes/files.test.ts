import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { buildApp } from "../app.js";
import { overrideConfig } from "../config/env.js";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";

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
  const originalUploadDir = process.env.AI_UPLOAD_DIR;

  beforeAll(async () => {
    testUploadDir = join(os.tmpdir(), `local-ai-harness-tests-${randomUUID()}`);
    await mkdir(testUploadDir, { recursive: true });
    // Override upload directory for test isolation
    overrideConfig({ UPLOAD_DIR: testUploadDir } as any);
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    // Restore original upload dir
    if (originalUploadDir) {
      process.env.AI_UPLOAD_DIR = originalUploadDir;
    } else {
      delete process.env.AI_UPLOAD_DIR;
    }
    // Clean up test upload directory
    try {
      await rm(testUploadDir, { recursive: true, force: true });
    } catch {
      // ignore
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

    await testApp.close();
  });
});
