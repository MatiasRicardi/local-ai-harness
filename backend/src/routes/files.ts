import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { mkdir, stat, unlink } from "node:fs/promises";
import { extname } from "node:path";
import { join } from "node:path";
import type { FastifyPluginAsync } from "fastify";
import { config } from "../config/env.js";

const ALLOWED_EXTENSIONS = new Set([".txt", ".md", ".pdf"]);

const MIME_MAP: Record<string, string[]> = {
  ".txt": ["text/plain"],
  ".md": ["text/markdown", "text/plain"],
  ".pdf": ["application/pdf"],
};

/**
 * Validate that the file extension is allowed.
 */
function isExtensionAllowed(filename: string): boolean {
  const ext = extname(filename).toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext);
}

/**
 * Validate that the declared MIME type matches the extension.
 */
function isMimeAllowed(filename: string, mimeType: string): boolean {
  const ext = extname(filename).toLowerCase();
  const allowedMimes = MIME_MAP[ext];
  if (!allowedMimes) return false;
  return allowedMimes.includes(mimeType);
}

const filesRoute: FastifyPluginAsync = async (server) => {
  server.post("/api/files", async (request, reply) => {
    try {
      const file = await request.file({
        limits: { files: 1 },
      });

      if (!file) {
        return reply.code(400).send({
          success: false,
          error: "No file uploaded. A single file is required.",
        });
      }

      const originalFilename = file.filename;
      const mimeType = file.mimetype;

      // Validate extension
      if (!isExtensionAllowed(originalFilename)) {
        return reply.code(400).send({
          success: false,
          error: `File extension "${extname(originalFilename)}" is not supported. Allowed: .txt, .md, .pdf`,
        });
      }

      // Validate MIME type
      const ext = extname(originalFilename).toLowerCase();
      if (!isMimeAllowed(originalFilename, mimeType)) {
        return reply.code(400).send({
          success: false,
          error: `MIME type "${mimeType}" is not allowed for ${ext} files.`,
        });
      }

      // Generate safe internal identity
      const fileId = randomUUID();
      const internalFilename = `${fileId}${ext}`;

      // Ensure temp directory exists
      await mkdir(config.UPLOAD_DIR, { recursive: true });

      const destinationPath = join(config.UPLOAD_DIR, internalFilename);

      // Stream directly to disk
      await pipeline(file.file, createWriteStream(destinationPath));

      // Check if the file was truncated by busboy (exceeded size limit)
      if (file.file.truncated) {
        // Clean up the partially written file
        try {
          await unlink(destinationPath);
        } catch {
          // Ignore cleanup errors
        }
        return reply.code(413).send({
          success: false,
          error: "File exceeds the maximum allowed size.",
        });
      }

      // Get file size from filesystem metadata
      const fileStats = await stat(destinationPath);
      const size = fileStats.size;

      return reply.code(200).send({
        success: true,
        fileId,
        originalFilename,
        size,
        type: mimeType,
      });
    } catch {
      // Handle other errors gracefully
      return reply.code(500).send({
        success: false,
        error: "Failed to process upload.",
      });
    }
  });
};

export default filesRoute;
