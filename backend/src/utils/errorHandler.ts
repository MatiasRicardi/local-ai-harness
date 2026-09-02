import { consola } from "consola";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { OpenAICompatibleClient, ProviderClientError } from "../provider/client.js";

// ── Error codes ──────────────────────────────────────────────────────────────

export type AppErrorCode =
  | "VALIDATION_ERROR"
  | "PROVIDER_UNREACHABLE"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_UNAUTHORIZED"
  | "INVALID_PROVIDER_RESPONSE"
  | "UNSUPPORTED_FILE"
  | "FILE_TOO_LARGE"
  | "FILE_UPLOAD_ERROR"
  | "FILE_CLEANUP_FAILED"
  | "EXTRACTION_FAILED"
  | "CONTEXT_TOO_LARGE"
  | "DOCUMENT_CONTEXT_TOO_LARGE"
  | "INTERNAL_ERROR";

// ── AppError ─────────────────────────────────────────────────────────────────

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly statusCode: number;
  readonly userMessage: string;
  readonly detail?: string;
  readonly cause?: unknown;

  constructor(options: {
    code: AppErrorCode;
    statusCode: number;
    message: string;
    detail?: string;
    cause?: unknown;
  }) {
    super(options.message);
    this.name = "AppError";
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.userMessage = options.message;
    this.detail = options.detail;
    this.cause = options.cause;
  }
}

// ── API response shape ───────────────────────────────────────────────────────

export interface ApiErrorResponse {
  error: {
    code: AppErrorCode;
    message: string;
    detail?: string;
  };
}

// ── Default messages ─────────────────────────────────────────────────────────

const DEFAULT_MESSAGES: Record<AppErrorCode, string> = {
  VALIDATION_ERROR: "The request contains invalid fields.",
  PROVIDER_UNREACHABLE: "Unable to connect to the configured provider.",
  PROVIDER_TIMEOUT: "The configured provider did not respond in time.",
  PROVIDER_UNAUTHORIZED: "The provider rejected the configured credentials.",
  INVALID_PROVIDER_RESPONSE: "The provider returned an invalid response.",
  UNSUPPORTED_FILE: "This file type is not supported.",
  FILE_TOO_LARGE: "The uploaded file is too large.",
  FILE_UPLOAD_ERROR: "The file could not be uploaded.",
  FILE_CLEANUP_FAILED: "The uploaded file could not be removed.",
  EXTRACTION_FAILED: "Document extraction failed.",
  CONTEXT_TOO_LARGE:
    "The current conversation is too large for the configured context size. Start a new conversation or increase the configured context size.",
  DOCUMENT_CONTEXT_TOO_LARGE:
    "The current conversation is too large to include the attached document. Start a new conversation or increase the configured context size.",
  INTERNAL_ERROR: "An unexpected error occurred.",
};

// ── Provider error message patterns ──────────────────────────────────────────

function matchProviderError(error: unknown): AppErrorCode | null {
  if (error instanceof ProviderClientError) {
    if (error.errorType === OpenAICompatibleClient.ErrorType.TIMEOUT) {
      return "PROVIDER_TIMEOUT";
    }
    if (error.errorType === OpenAICompatibleClient.ErrorType.NETWORK_ERROR) {
      return "PROVIDER_UNREACHABLE";
    }
    if (error.errorType === OpenAICompatibleClient.ErrorType.MALFORMED_RESPONSE) {
      return "INVALID_PROVIDER_RESPONSE";
    }
  }

  if (!(error instanceof Error)) return null;

  // Timeout: AbortSignal.timeout() throws DOMException with name "TimeoutError"
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return "PROVIDER_TIMEOUT";
  }

  // Network unreachable: TypeError with fetch-failed pattern, or DOMException NetworkError
  if (
    error instanceof DOMException &&
    error.name === "NetworkError"
  ) {
    return "PROVIDER_UNREACHABLE";
  }

  if (
    error instanceof TypeError &&
    /fetch failed|failed to fetch|network/i.test(error.message)
  ) {
    return "PROVIDER_UNREACHABLE";
  }

  // Inspect the cause chain for HTTP status errors from the provider client
  let cause: unknown = (error as Error).cause;
  while (cause) {
    if (cause instanceof Error) {
      // HTTP error from provider client wrapper (e.g. "Provider returned HTTP 401: Unauthorized")
      const httpMatch = cause.message.match(/Provider returned HTTP (\d+)/);
      if (httpMatch) {
        const status = parseInt(httpMatch[1], 10);
        if (status === 401 || status === 403) {
          return "PROVIDER_UNAUTHORIZED";
        }
        return "INVALID_PROVIDER_RESPONSE";
      }

      // Malformed response markers
      if (
        cause.message.includes("no choices") ||
        cause.message.includes("empty response") ||
        cause.message.includes("empty choices")
      ) {
        return "INVALID_PROVIDER_RESPONSE";
      }

      // Timeout in cause chain (DOMException with name "TimeoutError")
      if (
        cause instanceof DOMException &&
        cause.name === "TimeoutError"
      ) {
        return "PROVIDER_TIMEOUT";
      }

      // Network error in cause chain
      if (
        cause instanceof TypeError &&
        /fetch failed|failed to fetch|network/i.test(cause.message)
      ) {
        return "PROVIDER_UNREACHABLE";
      }

      if (
        cause instanceof DOMException &&
        cause.name === "NetworkError"
      ) {
        return "PROVIDER_UNREACHABLE";
      }
    }

    cause = (cause as { cause?: unknown })?.cause;
  }

  return null;
}

// ── Zod error normalization ──────────────────────────────────────────────────

function normalizeZodError(zodError: z.ZodError): {
  code: AppErrorCode;
  statusCode: number;
  message: string;
  detail?: string;
} {
  const firstIssue = zodError.issues[0];
  let detail: string | undefined;

  if (firstIssue) {
    // Build a safe, concise detail from the first validation issue
    const path = firstIssue.path.length > 0 ? `${firstIssue.path.join(".")}: ` : "";
    detail = `${path}${firstIssue.message}`;
  }

  return {
    code: "VALIDATION_ERROR",
    statusCode: 400,
    message: "The request contains invalid fields.",
    detail,
  };
}

// ── normalizeError ───────────────────────────────────────────────────────────

/**
 * Normalize any thrown error into a stable AppError suitable for the global
 * Fastify error handler.
 *
 * Flow:
 *   AppError (already normalized)          → pass through
 *   ZodError                               → VALIDATION_ERROR
 *   @fastify/multipart file-size error     → FILE_TOO_LARGE (413)
 *   Provider error (timeout/network/HTTP)  → PROVIDER_* code
 *   ExtractionError                        → EXTRACTION_FAILED
 *   Context-budget rejection               → CONTEXT_TOO_LARGE / DOCUMENT_CONTEXT_TOO_LARGE
 *   Anything else                          → INTERNAL_ERROR (500)
 */
export function normalizeError(error: unknown): AppError {
  // Already normalized
  if (error instanceof AppError) {
    return error;
  }

  // Zod validation errors
  if (error instanceof z.ZodError) {
    const normalized = normalizeZodError(error);
    return new AppError(normalized);
  }

  // @fastify/multipart file-size limit error
  if (error instanceof Error && (error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
    return new AppError({
      code: "FILE_TOO_LARGE",
      statusCode: 413,
      message: "The uploaded file is too large.",
    });
  }

  // @fastify/multipart parser errors: the request itself was invalid.
  // These are client errors (HTTP 400) when request.parts() fails.
  const multipartError = error as { code?: string } | null;
  const isMultipartParserError =
    error instanceof Error &&
    (multipartError?.code === "FST_MP_PREMATURE_CLOSE" ||
      multipartError?.code === "FST_PROTO_VIOLATION");
  if (isMultipartParserError) {
    return new AppError({
      code: "FILE_UPLOAD_ERROR",
      statusCode: 400,
      message: "The file could not be uploaded.",
      detail: "The upload request was interrupted or is invalid.",
    });
  }

  // Provider errors (timeout, network, HTTP status, malformed)
  const providerCode = matchProviderError(error);
  if (providerCode) {
    return new AppError({
      code: providerCode,
      statusCode:
        providerCode === "PROVIDER_TIMEOUT"
          ? 504
          : providerCode === "PROVIDER_UNAUTHORIZED"
            ? 401
            : 502,
      message: DEFAULT_MESSAGES[providerCode],
    });
  }

  // ExtractionError → keep its safe domain message as the main message
  if (error instanceof Error && error.name === "ExtractionError") {
    return new AppError({
      code: "EXTRACTION_FAILED",
      statusCode: 400,
      message: error.message,
    });
  }

  // Context-budget rejections surfaced as Error with known messages
  if (error instanceof Error) {
    if (
      error.message.includes("conversation is too large for the configured context size") &&
      !error.message.includes("attached document")
    ) {
      return new AppError({
        code: "CONTEXT_TOO_LARGE",
        statusCode: 400,
        message: error.message,
      });
    }
    if (error.message.includes("conversation is too large to include the attached document")) {
      return new AppError({
        code: "DOCUMENT_CONTEXT_TOO_LARGE",
        statusCode: 400,
        message: error.message,
      });
    }
  }

  // Unknown → safe 500
  return new AppError({
    code: "INTERNAL_ERROR",
    statusCode: 500,
    message: DEFAULT_MESSAGES.INTERNAL_ERROR,
  });
}

// ── serializeResponse ────────────────────────────────────────────────────────

/**
 * Build the stable ApiErrorResponse body from an AppError.
 * Never exposes cause, stack traces, internal paths, credentials, or raw payloads.
 */
/**
 * Single-boundary logging for a normalized AppError.
 *
 * HTTP errors are logged by the global Fastify handler; mid-stream SSE errors
 * are logged by the streaming error boundary (which cannot reach the global
 * handler once headers have been sent). Both call this helper so that every
 * error is logged exactly once with the same safe policy.
 */
export function logNormalizedError(appError: AppError): void {
  if (appError.code === "INTERNAL_ERROR") {
    consola.error("[error]", appError.message);
  } else {
    consola.info(`[error] ${appError.code} -> ${appError.statusCode}`);
  }
}

export function serializeResponse(appError: AppError): ApiErrorResponse {
  const body: ApiErrorResponse = {
    error: {
      code: appError.code,
      message: appError.userMessage,
    },
  };

  if (appError.detail) {
    body.error.detail = appError.detail;
  }

  return body;
}

// ── Global Fastify error handler ─────────────────────────────────────────────

export function registerGlobalErrorHandler(app: import("fastify").FastifyInstance): void {
  app.setErrorHandler(
    async (error: unknown, _request: FastifyRequest, reply: FastifyReply) => {
      const appError = normalizeError(error);
      const body = serializeResponse(appError);

      // Single logging boundary — do not log at lower layers
      logNormalizedError(appError);

      reply.status(appError.statusCode).type("application/json").send(body);
    },
  );
}
