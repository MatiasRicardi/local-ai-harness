import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { extname } from "node:path";
import { join } from "node:path";
import { removeTemporaryFile } from "../files/cleanup.js";
import type { FastifyPluginAsync } from "fastify";
import type { FastifyMultipartBaseOptions } from "@fastify/multipart";
import { consola } from "consola";
import { config } from "../config/env.js";
import { extractTxt } from "../extractors/txt.js";
import { extractMarkdown } from "../extractors/markdown.js";
import { extractPdf } from "../extractors/pdf.js";
import type { ExtractionResult } from "../extractors/types.js";
import { AppError, normalizeError } from "../utils/errorHandler.js";

const ALLOWED_EXTENSIONS = new Set([".txt", ".md", ".pdf"]);

/**
 * Remove a temporary file, reporting failure through the global error boundary
 * with a stable operation/code. Never logs the file path, file contents, or raw
 * error details (CWE-539: omission of information about errors).
 */
async function removeTempFileSafely(path: string): Promise<void> {
  try {
    // Centralized, containment-checked deletion (Step 22).
    await removeTemporaryFile(path, config.UPLOAD_DIR);
  } catch (cleanupError) {
    throw new AppError({
      code: "FILE_CLEANUP_FAILED",
      statusCode: 500,
      message: "The uploaded file could not be removed.",
      cause: cleanupError,
    });
  }
}

/**
 * Report a cleanup failure at the logging boundary with a stable operation/code.
 * Never logs file paths, file contents, or raw error details.
 */
function reportCleanupFailure(): void {
  consola.error("[upload] cleanup_failed");
}

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

/**
 * Defensive runtime check in case stream typings change across multipart versions.
 */
function hasTruncatedFlag(stream: unknown): stream is { truncated: boolean } {
  if (typeof stream !== "object" || stream === null) {
    return false;
  }

  const maybeStream = stream as { truncated?: unknown };
  return typeof maybeStream.truncated === "boolean";
}

/**
 * Fully consume a multipart file stream so parsing can terminate cleanly.
 */
async function drainFileStream(fileStream: AsyncIterable<unknown>): Promise<void> {
  for await (const chunk of fileStream) {
    void chunk;
  }
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
      let destinationPath: string | undefined;
      let successResponseSent = false;
      let processedFileCount = 0;
      let multiFileDetected = false;
      let responsePayload:
        | {
          fileId: string;
          originalFilename: string;
          size: number;
          type: string;
        }
        | undefined;

      const partsOptions: FastifyMultipartBaseOptions = {
        limits: {
          files: Infinity,
        },
      };

      try {
        for await (const part of request.parts(partsOptions)) {
          if (part.type !== "file") {
            continue;
          }

          processedFileCount++;

          if (processedFileCount > 1) {
            // Drain the rejected second file stream.
            await drainFileStream(part.file);

            // Remove previously stored file so rejected multi-file requests leave no residue.
            if (destinationPath) {
              try {
                await removeTempFileSafely(destinationPath);
                // Clear only after a successful removal so a failed cleanup
                // keeps the path for the outer catch to retry removal.
                destinationPath = undefined;
              } catch {
                // Report cleanup failure without masking the rejection being
                // returned below. Never logs the path or file contents.
                reportCleanupFailure();
              }
              responsePayload = undefined;
            }

            multiFileDetected = true;
            continue;
          }

          const originalFilename = part.filename;
          const mimeType = part.mimetype;

          // Validate extension
          if (!isExtensionAllowed(originalFilename)) {
            await drainFileStream(part.file);
            throw new AppError({
              code: "UNSUPPORTED_FILE",
              statusCode: 400,
              message: `This file type is not supported. Allowed: .txt, .md, .pdf`,
            });
          }

          // Validate MIME type
          const ext = extname(originalFilename).toLowerCase();
          if (!isMimeAllowed(originalFilename, mimeType)) {
            await drainFileStream(part.file);
            throw new AppError({
              code: "UNSUPPORTED_FILE",
              statusCode: 400,
              message: "This file type is not supported.",
              detail: `MIME type is not allowed for ${ext} files.`,
            });
          }

          // Generate safe internal identity
          const fileId = randomUUID();
          const internalFilename = `${fileId}${ext}`;

          // Ensure temp directory exists
          await mkdir(config.UPLOAD_DIR, { recursive: true });

          destinationPath = join(config.UPLOAD_DIR, internalFilename);

          // Stream directly to disk
          await pipeline(part.file, createWriteStream(destinationPath));

          // Check if the file was truncated by busboy (exceeded size limit)
          if (hasTruncatedFlag(part.file) && part.file.truncated) {
            try {
              await removeTempFileSafely(destinationPath);
            } catch {
              // Report cleanup failure without masking the rejection returned
              // below. Never logs the path or file contents.
              reportCleanupFailure();
            }
            throw new AppError({
              code: "FILE_TOO_LARGE",
              statusCode: 413,
              message: "The uploaded file is too large.",
            });
          }

          // Get file size from filesystem metadata
          const fileStats = await stat(destinationPath);
          const size = fileStats.size;

          // Extract text for TXT, Markdown, and PDF files
          let extraction: ExtractionResult | undefined;
          const fileExt = ext.toLowerCase();
          if (fileExt === ".txt") {
            extraction = await extractTxt(destinationPath);
          } else if (fileExt === ".md") {
            extraction = await extractMarkdown(destinationPath);
          } else if (fileExt === ".pdf") {
            extraction = await extractPdf(destinationPath);
          }

          responsePayload = {
            fileId,
            originalFilename,
            size,
            type: mimeType,
            ...(extraction ? { extraction } : {}),
          };
        }

        if (multiFileDetected) {
          throw new AppError({
            code: "FILE_UPLOAD_ERROR",
            statusCode: 400,
            message: "The file could not be uploaded.",
            detail: "Only one file is allowed.",
          });
        }

        // No file was received
        if (processedFileCount === 0) {
          throw new AppError({
            code: "FILE_UPLOAD_ERROR",
            statusCode: 400,
            message: "The file could not be uploaded.",
            detail: "A single file is required.",
          });
        }

        if (!responsePayload) {
          throw new AppError({
            code: "FILE_UPLOAD_ERROR",
            statusCode: 400,
            message: "The file could not be uploaded.",
            detail: "A single file is required.",
          });
        }

        if (responsePayload) {
          // Extraction result is already in memory: remove the temporary file so
          // no residue outlives the request (Step 22). A best-effort cleanup
          // failure is logged but never fails an otherwise successful request.
          if (destinationPath) {
            try {
              await removeTempFileSafely(destinationPath);
            } catch {
              reportCleanupFailure();
            }
          }
          successResponseSent = true;
          return reply.code(200).send({
            success: true,
            ...responsePayload,
          });
        }

      } catch (err) {
        // Cleanup partial file if it exists and the upload didn't complete.
        // A cleanup failure is reported at the boundary but must not mask the
        // original error being returned to the caller.
        if (destinationPath && !successResponseSent) {
          try {
            await removeTempFileSafely(destinationPath);
          } catch {
            // Report cleanup failure without masking the original error.
            // Never logs the path or file contents.
            reportCleanupFailure();
          }
        }

        // Normalize through the global error handler for unified response
        throw normalizeError(err);
      }
    }
  );
};

export default filesRoute;
