import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { mkdir, stat, unlink } from "node:fs/promises";
import { extname } from "node:path";
import { join } from "node:path";
import type { FastifyPluginAsync } from "fastify";
import { consola } from "consola";
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
  server.post(
    "/api/files",
    {
      config: {
        requestTimeout: config.REQUEST_TIMEOUT_MS,
      },
    },
    async (request, reply) => {
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
          // Drain the stream to allow busboy to complete parsing
          file.file.resume();
          return reply.code(400).send({
            success: false,
            error: `File extension "${extname(originalFilename)}" is not supported. Allowed: .txt, .md, .pdf`,
          });
        }

        // Validate MIME type
        const ext = extname(originalFilename).toLowerCase();
        if (!isMimeAllowed(originalFilename, mimeType)) {
          // Drain the stream to allow busboy to complete parsing
          file.file.resume();
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
        try {
          await pipeline(file.file, createWriteStream(destinationPath));
        } catch (err) {
          // Clean up partial file on failure
          try {
            await unlink(destinationPath);
          } catch {
            // Ignore cleanup errors
          }
          throw err;
        }

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
      } catch (err) {
        // Handle multipart-specific errors by matching error codes
        const multipartError = err as { code?: string; statusCode?: number };
        const errorCode = multipartError.code;
        
        // Size/count-limit errors (413)
        if (
          errorCode === "FST_REQ_FILE_TOO_LARGE" ||
          errorCode === "FST_FILES_LIMIT" ||
          errorCode === "FST_PARTS_LIMIT" ||
          errorCode === "FST_FIELDS_LIMIT"
        ) {
          return reply.code(413).send({
            success: false,
            error: "Upload exceeds size or count limits.",
          });
        }
        
        // Premature close or invalid content type errors (400)
        if (
          errorCode === "FST_MP_PREMATURE_CLOSE" ||
          errorCode === "FST_PROTO_VIOLATION"
        ) {
          return reply.code(400).send({
            success: false,
            error: "Invalid upload request.",
          });
        }
        
        // For unexpected errors, log only stable operation name and safe error code
        // Never expose raw errors, request data, or file contents
        consola.error("[upload] unexpected error: upload_failed");
        
        return reply.code(500).send({
          success: false,
          error: "Failed to process upload.",
        });
      }
    }
  );
};

export default filesRoute;
