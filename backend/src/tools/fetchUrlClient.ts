import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateFetchUrlTarget } from "./fetchUrlPolicy.js";

// ── Fetch URL network client (bounded, validated, textual-only transport) ─────
//
// Downloads a single public URL through native Node `fetch` for the future
// `fetch_url` tool. It performs NO HTML/readability work and registers NO tool
// (that belongs to a later step): it returns the downloaded text plus light
// metadata.
//
// Safety is layered on top of the Step 47 destination policy:
//
//   FetchUrlPolicyError  → URL/destination blocked by the public-network policy
//   FetchUrlClientError  → transport / HTTP / MIME / size / redirect failure
//
// Neither error is mapped to `AppError` here. Step 50 owns that mapping, so this
// module stays decoupled from the public API / tool layer, exactly like Step 47.
//
// DNS-rebinding limitation (kept explicit, see Step 47): each hop validates the
// destination with the policy and then calls `fetch()`, but native `fetch()` may
// re-resolve the hostname when it opens the socket. A TOCTOU window therefore
// still exists between the validated DNS answer and the connection answer, and
// this step does NOT try to pin the connection (that would require changing the
// transport). What this step *does* guarantee is that a public URL that
// redirects to a private/local destination is rejected before the second
// request, because every redirect is revalidated.

/**
 * Total ceiling for the whole operation (initial request, every redirect and
 * the body read combined), not 15 seconds per redirect. A single timeout is
 * created once, before the redirect loop, so five redirects cannot turn into a
 * five-minute request.
 */
export const FETCH_URL_TIMEOUT_MS = 15_000;

/** Maximum number of redirects we are willing to follow. A sixth is rejected. */
export const MAX_REDIRECTS = 5;

/** Maximum downloaded body size, in bytes (1 MiB). Byte count, not character count. */
export const MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * Redirect statuses we are willing to follow. Every other non-2xx status is a
 * final response and is surfaced as an HTTP error.
 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Fixed, harness-controlled request headers. We never forward cookies,
 * authorization, referer or any browser/model-controlled header, and we never
 * send provider or Tavily keys.
 */
const REQUEST_HEADERS: Record<string, string> = {
  Accept:
    "text/html, text/plain, application/json, application/xml, application/xhtml+xml",
  "User-Agent": `Local-AI-Harness/${readClientVersion()}`,
};

/**
 * Options accepted by {@link fetchUrl}.
 *
 * `signal` is the caller's cancellation signal (e.g. a request/stop abort). It
 * is combined with the internal timeout; aborting either one cancels the
 * operation.
 */
export interface FetchUrlClientOptions {
  signal?: AbortSignal;
}

/**
 * Internal result of a successful fetch.
 *
 * `url` is the final URL after redirects. Resolved IPs, redirect history and
 * response headers stay internal security/transport metadata and are never
 * part of this contract — in particular the resolved IPs must not leak into a
 * future model-facing payload.
 */
export interface FetchUrlResponse {
  url: string;
  status: number;
  contentType: string;
  content: string;
}

/**
 * Error thrown by the fetch-URL transport for every transport/HTTP/MIME/
 * size/redirect failure. Mirrors the `TavilySearchError` shape (stable
 * `errorType` + optional `statusCode`) so a later step can map it to the public
 * tool error without inventing a new error model here.
 */
export class FetchUrlClientError extends Error {
  readonly errorType: string;
  readonly statusCode?: number;

  static readonly ErrorType = {
    TIMEOUT: "timeout",
    USER_ABORT: "user_abort",
    NETWORK_ERROR: "network_error",
    HTTP_ERROR: "http_error",
    TOO_MANY_REDIRECTS: "too_many_redirects",
    INVALID_REDIRECT: "invalid_redirect",
    UNSUPPORTED_CONTENT_TYPE: "unsupported_content_type",
    RESPONSE_TOO_LARGE: "response_too_large",
  } as const;

  constructor(
    errorType: string,
    message: string,
    statusCode?: number,
  ) {
    super(message);
    this.name = "FetchUrlClientError";
    this.errorType = errorType;
    this.statusCode = statusCode;
  }
}

/**
 * Download a single public URL.
 *
 * Validates the destination with the Step 47 policy, follows at most
 * {@link MAX_REDIRECTS} redirects (revalidating every hop), enforces a global
 * {@link FETCH_URL_TIMEOUT_MS} ceiling, a {@link MAX_RESPONSE_BYTES} byte limit
 * and a textual-only MIME allowlist, then decodes the body as UTF-8.
 *
 * Throws {@link FetchUrlPolicyError} for blocked destinations and
 * {@link FetchUrlClientError} for every transport failure.
 */
export async function fetchUrl(
  rawUrl: string,
  options?: FetchUrlClientOptions,
): Promise<FetchUrlResponse> {
  // One timeout for the whole operation, including policy validation, created
  // before any validation so a slow DNS lookup is bounded and caller
  // cancellation is honoured during resolution too.
  const timeoutSignal = AbortSignal.timeout(FETCH_URL_TIMEOUT_MS);
  const signal = options?.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  // Validate the initial destination before any network work. This throws
  // FetchUrlPolicyError (never converted to AppError here), or a client error
  // if the operation is aborted/timed out while resolving.
  const validated = await validateTargetWithSignal(rawUrl, signal, timeoutSignal);

  let currentUrl = validated.url;
  let redirectCount = 0;

  // Loop: validate → fetch → follow-or-finish. Every hop is revalidated before
  // its request, so a public URL that redirects to a private destination is
  // rejected before the second network call.
  for (;;) {
    let response: Response;
    try {
      response = await fetch(currentUrl, {
        method: "GET",
        // Never let fetch follow redirects automatically: we must revalidate
        // every hop against the policy first.
        redirect: "manual",
        headers: REQUEST_HEADERS,
        // Do not store or send cookies for these requests.
        credentials: "omit",
        signal,
      });
    } catch (error) {
      throw toClientError(error, timeoutSignal);
    }

    const isRedirect = REDIRECT_STATUSES.has(response.status);
    if (!isRedirect) {
      return await readFinalResponse(response, currentUrl, timeoutSignal);
    }

    // A redirect body is never read (we follow via the Location header). Cancel
    // it so the connection is not held open while we resolve/validate the hop.
    await response.body?.cancel().catch(() => undefined);

    const location = response.headers.get("location");
    if (!location) {
      throw new FetchUrlClientError(
        FetchUrlClientError.ErrorType.INVALID_REDIRECT,
        `Fetch URL returned a ${response.status} redirect without a Location header`,
        response.status,
      );
    }

    let nextUrl: string;
    try {
      // Resolve relative Locations against the current URL.
      nextUrl = new URL(location, currentUrl).toString();
    } catch {
      throw new FetchUrlClientError(
        FetchUrlClientError.ErrorType.INVALID_REDIRECT,
        "Fetch URL returned an invalid redirect Location",
        response.status,
      );
    }

    // At most MAX_REDIRECTS redirects. When we have already followed five, a
    // further redirect would require a sixth connection, so reject instead.
    if (redirectCount >= MAX_REDIRECTS) {
      throw new FetchUrlClientError(
        FetchUrlClientError.ErrorType.TOO_MANY_REDIRECTS,
        `Fetch URL exceeded the maximum number of redirects (${MAX_REDIRECTS})`,
        response.status,
      );
    }

    // Revalidate the redirect target BEFORE fetching it. This blocks a public
    // URL that redirects to a private/local destination. Throws
    // FetchUrlPolicyError on a blocked target, or a client error if aborted.
    // The policy returns the normalized URL, which we use as the connection
    // target.
    const validatedRedirect = await validateTargetWithSignal(
      nextUrl,
      signal,
      timeoutSignal,
    );

    currentUrl = validatedRedirect.url;
    redirectCount += 1;
  }
}

/**
 * Validate a fetch-URL destination while racing the shared abort signal.
 *
 * The DNS/policy lookup can be slow, so it must not run unbounded: if the
 * operation is cancelled or times out while resolving, the validation is
 * abandoned and the cause is classified as `TIMEOUT` (the global timeout fired)
 * or `USER_ABORT` (the caller cancelled). A blocked destination still surfaces
 * as a {@link FetchUrlPolicyError}.
 */
function validateTargetWithSignal(
  rawUrl: string,
  signal: AbortSignal,
  timeoutSignal: AbortSignal,
): ReturnType<typeof validateFetchUrlTarget> {
  // Classify the abort: the timeout signal aborts only on the global ceiling,
  // so its abort means TIMEOUT; any other abort is a caller cancellation.
  const abortError = () =>
    timeoutSignal.aborted
      ? toClientError(timeoutSignal.reason, timeoutSignal)
      : new FetchUrlClientError(
          FetchUrlClientError.ErrorType.USER_ABORT,
          "Fetch URL was cancelled",
        );

  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(abortError());
  signal.addEventListener("abort", onAbort, { once: true });

  const validation = signal.aborted
    ? Promise.reject(abortError())
    : validateFetchUrlTarget(rawUrl);

  return Promise.race([validation, aborted]).finally(() => {
    signal.removeEventListener("abort", onAbort);
  });
}

/**
 * Validate the final (non-redirect) response: MIME allowlist, byte limit and
 * UTF-8 decode. Returns the internal {@link FetchUrlResponse}.
 */
async function readFinalResponse(
  response: Response,
  finalUrl: string,
  timeoutSignal: AbortSignal,
): Promise<FetchUrlResponse> {
  // Only successful 2xx final responses produce content. Non-2xx (that was not
  // a handled redirect) is a safe HTTP error carrying the status code; the
  // remote error body is never included in the message.
  if (!response.ok) {
    // The body is never read on this error path; cancel it so the connection
    // is released instead of left idle.
    await response.body?.cancel().catch(() => undefined);
    throw new FetchUrlClientError(
      FetchUrlClientError.ErrorType.HTTP_ERROR,
      `Fetch URL returned HTTP ${response.status}`,
      response.status,
    );
  }

  const contentType = normalizeContentType(response.headers.get("content-type"));
  if (contentType === null || !isAllowedContentType(contentType)) {
    // The body is never read on this error path; cancel it so the connection
    // is released instead of left idle.
    await response.body?.cancel().catch(() => undefined);
    throw new FetchUrlClientError(
      FetchUrlClientError.ErrorType.UNSUPPORTED_CONTENT_TYPE,
      contentType
        ? `Fetch URL returned an unsupported content type: ${contentType}`
        : "Fetch URL returned a response without a Content-Type header",
      response.status,
    );
  }

  // Early reject when a trustworthy Content-Length already exceeds the limit.
  // This header is NOT authoritative (servers can lie or use chunked encoding),
  // so the streaming counter below is the real guard.
  const contentLengthHeader = response.headers.get("content-length");
  const declaredLength = contentLengthHeader
    ? Number.parseInt(contentLengthHeader, 10)
    : Number.NaN;
  if (!Number.isNaN(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    // The body is never read on this error path; cancel it so the connection
    // is released instead of left idle.
    await response.body?.cancel().catch(() => undefined);
    throw new FetchUrlClientError(
      FetchUrlClientError.ErrorType.RESPONSE_TOO_LARGE,
      "Fetch URL response is larger than the maximum allowed size",
      response.status,
    );
  }

  if (!response.body) {
    return { url: finalUrl, status: response.status, contentType, content: "" };
  }

  // Stream the body and count received bytes. We never call response.text() on
  // an unbounded body: reading happens through the reader so we can abort as
  // soon as the real byte count exceeds the limit.
  const chunks: Array<Uint8Array> = [];
  let totalBytes = 0;

  // `response.body` is typed as `ReadableStream<unknown>`; the client only
  // accepts byte bodies, so read it as a Uint8Array stream.
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  try {
    for (;;) {
      let read: Awaited<ReturnType<typeof reader.read>>;
      try {
        read = await reader.read();
      } catch (error) {
        // Abort/timeout while consuming the body surfaces as an AbortError /
        // TimeoutError DOMException. Classify it like a fetch-level failure.
        throw toClientError(error, timeoutSignal);
      }

      if (read.done) {
        break;
      }

      const value = read.value ?? new Uint8Array(0);
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        // Stop consuming and cancel the underlying stream.
        await reader.cancel().catch(() => undefined);
        throw new FetchUrlClientError(
          FetchUrlClientError.ErrorType.RESPONSE_TOO_LARGE,
          "Fetch URL response exceeded the maximum allowed size while downloading",
          response.status,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  // Decode the bounded bytes as UTF-8. The default TextDecoder is
  // fatal:false, so invalid byte sequences become the replacement character;
  // no charset transcoding is performed, so any charset the server declares is
  // ignored for v1.2.0.
  const decoded = new TextDecoder("utf-8").decode(
    concatUint8Arrays(chunks),
  );

  return { url: finalUrl, status: response.status, contentType, content: decoded };
}

/**
 * Classify a fetch/stream failure into a {@link FetchUrlClientError}.
 *
 * Timeout takes precedence over a caller abort (a timeout signal aborts with a
 * `TimeoutError` reason even though fetch surfaces it as an `AbortError`).
 */
function toClientError(error: unknown, timeoutSignal: AbortSignal): FetchUrlClientError {
  // `AbortSignal.reason` is typed as `any`; pin it to `unknown` so the
  // instanceof checks below narrow it safely.
  const timeoutReason: unknown = timeoutSignal.reason;
  if (timeoutReason instanceof DOMException && timeoutReason.name === "TimeoutError") {
    return new FetchUrlClientError(
      FetchUrlClientError.ErrorType.TIMEOUT,
      "Fetch URL operation timed out",
    );
  }

  if (error instanceof DOMException && error.name === "AbortError") {
    return new FetchUrlClientError(
      FetchUrlClientError.ErrorType.USER_ABORT,
      "Fetch URL was cancelled",
    );
  }

  if (error instanceof DOMException && error.name === "TimeoutError") {
    return new FetchUrlClientError(
      FetchUrlClientError.ErrorType.TIMEOUT,
      "Fetch URL operation timed out",
    );
  }

  return new FetchUrlClientError(
    FetchUrlClientError.ErrorType.NETWORK_ERROR,
    "Fetch URL connection failed",
  );
}

/** Normalize a Content-Type header to its media type, ignoring parameters. */
function normalizeContentType(headerValue: string | null): string | null {
  if (!headerValue) return null;
  // Strip parameters such as `; charset=utf-8`.
  const mediaType = headerValue.split(";", 1)[0].trim().toLowerCase();
  return mediaType.length > 0 ? mediaType : null;
}

/**
 * Textual-only allowlist. Accepts `text/*`, `application/json`, clearly
 * textual XML/JSON `+xml` / `+json` variants (including `application/xhtml+xml`).
 * Everything else — binary types (`application/octet-stream`, `application/pdf`,
 * `image/*`, `audio/*`, `video/*`) and a missing/empty Content-Type — is
 * rejected (fail closed).
 */
function isAllowedContentType(contentType: string | null): boolean {
  if (contentType === null) return false;
  if (contentType.startsWith("text/")) return true;
  if (contentType === "application/json") return true;
  if (contentType.endsWith("+json")) return true;
  if (contentType === "application/xml" || contentType === "application/xhtml+xml") {
    return true;
  }
  if (contentType.endsWith("+xml")) return true;
  return false;
}

/** Concatenate possibly non-contiguous Uint8Arrays into a single buffer. */
function concatUint8Arrays(arrays: Array<Uint8Array>): Uint8Array {
  const total = arrays.reduce((sum, array) => sum + array.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const array of arrays) {
    result.set(array, offset);
    offset += array.byteLength;
  }
  return result;
}

/**
 * Read the backend package version at runtime so the User-Agent never advertises
 * a release version that the package has not published yet. Read through `fs`
 * (not a JSON import) to avoid pulling `package.json` outside the TypeScript
 * `rootDir`. Falls back to `0.0.0` if it cannot be read.
 */
function readClientVersion(): string {
  try {
    const packagePath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: string };
    return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Reader result alias, kept local to avoid an extra node: import. */

