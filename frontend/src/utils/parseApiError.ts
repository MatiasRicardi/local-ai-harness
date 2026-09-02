/**
 * Shared frontend API error parser/normalizer.
 *
 * Every service helper routes HTTP/SSE/network failures through here so the
 * frontend has one normalized error shape. It:
 *  - preserves known stable backend codes (Step 21.1);
 *  - tolerates malformed / non-JSON bodies;
 *  - never exposes raw HTML gateway pages, [object Object], stack traces or
 *    arbitrary server text;
 *  - maps client-side network failures to NETWORK_ERROR.
 */
import {
  FrontendApiError,
  type AppErrorCode,
  type FrontendErrorData,
} from "../types/error"

const NETWORK_ERROR_MESSAGE =
  "Unable to reach the local backend. Check that it is running and try again."
const UNKNOWN_ERROR_MESSAGE = "Something went wrong. Please try again."

// The full stable backend code set. A code outside this set is treated as
// unknown and never echoed, so a new/unknown backend code cannot leak raw
// server text into the UI.
const KNOWN_CODES: Set<AppErrorCode> = new Set<AppErrorCode>([
  "VALIDATION_ERROR",
  "PROVIDER_UNREACHABLE",
  "PROVIDER_TIMEOUT",
  "PROVIDER_UNAUTHORIZED",
  "INVALID_PROVIDER_RESPONSE",
  "UNSUPPORTED_FILE",
  "FILE_TOO_LARGE",
  "FILE_UPLOAD_ERROR",
  "FILE_CLEANUP_FAILED",
  "EXTRACTION_FAILED",
  "CONTEXT_TOO_LARGE",
  "DOCUMENT_CONTEXT_TOO_LARGE",
  "INTERNAL_ERROR",
])

function normalizePayload(payload: {
  code?: unknown
  message?: unknown
  detail?: unknown
}): FrontendErrorData {
  const code =
    typeof payload.code === "string" && KNOWN_CODES.has(payload.code as AppErrorCode)
      ? (payload.code as AppErrorCode)
      : undefined

  if (code) {
    const message =
      typeof payload.message === "string" && payload.message.length > 0
        ? payload.message
        : UNKNOWN_ERROR_MESSAGE
    const detail = typeof payload.detail === "string" ? payload.detail : undefined
    return { code, message, detail }
  }

  // Unrecognized / missing code: use the safe generic fallback and never echo
  // arbitrary server text.
  return { code: "UNKNOWN_ERROR", message: UNKNOWN_ERROR_MESSAGE }
}

async function readApiErrorBody(response: Response): Promise<FrontendErrorData> {
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    // Malformed / non-JSON body (e.g. an HTML gateway page): fall back safely.
    parsed = undefined
  }

  const errorPart =
    parsed && typeof parsed === "object" && "error" in parsed
      ? (parsed as { error?: unknown }).error
      : undefined

  const payload =
    errorPart && typeof errorPart === "object"
      ? (errorPart as { code?: unknown; message?: unknown; detail?: unknown })
      : {}

  return normalizePayload(payload)
}

/**
 * Parse a non-2xx `Response` into a normalized `FrontendApiError`.
 */
export async function parseApiError(response: Response): Promise<FrontendApiError> {
  return new FrontendApiError(await readApiErrorBody(response))
}

/**
 * Normalize an SSE `error` event payload into a normalized `FrontendApiError`.
 * The payload carries the stable backend `code` (Step 21.2); an unrecognized
 * code falls back to UNKNOWN_ERROR.
 */
export function parseStreamErrorData(data: unknown): FrontendApiError {
  const payload =
    data && typeof data === "object"
      ? (data as { code?: unknown; message?: unknown; detail?: unknown })
      : {}
  return new FrontendApiError(normalizePayload(payload))
}

/**
 * Client-side network failure: `fetch()` threw before any HTTP response.
 */
export function toNetworkError(): FrontendApiError {
  return new FrontendApiError({ code: "NETWORK_ERROR", message: NETWORK_ERROR_MESSAGE })
}

/**
 * A response was received but could not be used (e.g. empty body). Never a
 * provider-specific code.
 */
export function toUnknownError(): FrontendApiError {
  return new FrontendApiError({ code: "UNKNOWN_ERROR", message: UNKNOWN_ERROR_MESSAGE })
}
