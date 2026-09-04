/**
 * Shared frontend error model.
 *
 * Mirrors the stable backend error contract implemented in Step 21.1 so the
 * frontend can preserve stable error codes, normalize network/unknown
 * failures into one shape, and never echo raw server payloads.
 */

/**
 * Stable backend error codes (Step 21.1). `FILE_CLEANUP_FAILED` is included so
 * no public backend code is silently omitted from the frontend type system.
 */
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

/**
 * Frontend-only codes for failures that never reach the backend as a stable
 * code: a fetch that fails before any HTTP response, or an unparseable body.
 */
export type FrontendErrorCode = AppErrorCode | "NETWORK_ERROR" | "UNKNOWN_ERROR";

/**
 * The shared API error response body returned by the backend (Step 21.1).
 */
export interface ApiErrorResponse {
  error: {
    code: AppErrorCode;
    message: string;
    detail?: string;
  };
}

/**
 * Plain data shape of a normalized frontend error.
 */
export interface FrontendErrorData {
  code: FrontendErrorCode;
  message: string;
  detail?: string;
}

/**
 * Normalized frontend error that also behaves like a native `Error`, so it can
 * be thrown from service methods and caught with `instanceof Error` while
 * retaining the stable `code` and optional safe `detail`.
 */
export class FrontendApiError extends Error {
  readonly code: FrontendErrorCode;
  readonly detail?: string;

  constructor(data: FrontendErrorData) {
    super(data.message);
    this.name = "FrontendApiError";
    this.code = data.code;
    this.detail = data.detail;
  }
}

/**
 * UI area an error belongs to. Errors are rendered once, near the operation
 * that produced them (chat/composer vs attachment/composer).
 */
export type AppErrorArea = "chat" | "attachment";

/**
 * Contextual App-level error state.
 */
export interface AppUiError {
  area: AppErrorArea;
  value: FrontendApiError;
}
