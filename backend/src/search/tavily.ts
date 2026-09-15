import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
} from "./types.js";
import {
  combineSignals,
  normalizeSearchBaseUrl,
  webSearchRequestSchema,
} from "./types.js";

/**
 * Default timeout (ms) applied to a single Tavily search call when the caller
 * does not supply one. Kept small and self-contained rather than reusing the
 * chat provider timeout, which targets a different round trip.
 */
export const TAVILY_DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Options required to construct a {@link TavilySearchProvider}.
 *
 * - `baseUrl` comes from backend config (`AI_TAVILY_BASE_URL`);
 * - `apiKey` is supplied request-scoped by the caller and never persisted.
 */
export interface TavilySearchProviderOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

/**
 * Minimal shape of a Tavily Search API response that this provider reads.
 * Only the fields needed for normalization are declared; extra provider-only
 * fields are ignored.
 */
interface TavilySearchResponse {
  results?: Array<{
    title?: unknown;
    url?: unknown;
    content?: unknown;
    score?: unknown;
  }>;
}

/**
 * Error thrown by the Tavily provider.
 *
 * Carries a stable `errorType` and, for HTTP failures, the `statusCode` so the
 * backend error handler can map it into the existing structured error model.
 * The API key is never included in the message.
 */
export class TavilySearchError extends Error {
  readonly errorType: string;
  readonly statusCode?: number;

  static readonly ErrorType = {
    TIMEOUT: "timeout",
    USER_ABORT: "user_abort",
    NETWORK_ERROR: "network_error",
    MALFORMED_RESPONSE: "malformed_response",
    HTTP_ERROR: "http_error",
    UNKNOWN: "unknown",
  } as const;

  constructor(errorType: string, message: string, statusCode?: number) {
    super(message);
    this.name = "TavilySearchError";
    this.errorType = errorType;
    this.statusCode = statusCode;
  }
}

/**
 * Tavily-backed {@link WebSearchProvider}.
 *
 * Calls the Tavily HTTPS Search API directly. The base URL is injected from
 * backend config (never hardcoded) and the API key is injected request-scoped
 * (never persisted or logged).
 */
export class TavilySearchProvider implements WebSearchProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(options: TavilySearchProviderOptions) {
    if (!options || typeof options.apiKey !== "string" || options.apiKey.length === 0) {
      throw new Error("TavilySearchProvider requires an API key");
    }

    this.baseUrl = normalizeSearchBaseUrl(options.baseUrl);
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? TAVILY_DEFAULT_TIMEOUT_MS;
  }

  async search(
    request: WebSearchRequest,
    options?: { signal?: AbortSignal },
  ): Promise<WebSearchResult[]> {
    const normalized = webSearchRequestSchema.parse(request);

    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = combineSignals(options?.signal, timeoutSignal);

    let response: Response;
    try {
      response = await this.fetchSearch(normalized, signal);
    } catch (error) {
      throw this.toSearchError(error, timeoutSignal);
    }

    if (!response.ok) {
      throw new TavilySearchError(
        TavilySearchError.ErrorType.HTTP_ERROR,
        `Tavily search returned HTTP ${response.status}`,
        response.status,
      );
    }

    let data: TavilySearchResponse;
    try {
      data = (await response.json()) as TavilySearchResponse;
    } catch {
      throw new TavilySearchError(
        TavilySearchError.ErrorType.MALFORMED_RESPONSE,
        "Tavily returned an invalid or non-JSON response",
      );
    }

    if (!data || !Array.isArray(data.results)) {
      throw new TavilySearchError(
        TavilySearchError.ErrorType.MALFORMED_RESPONSE,
        "Tavily returned a malformed response",
      );
    }

    return data.results.map((entry) => this.normalizeResult(entry));
  }

  private async fetchSearch(
    request: { query: string; maxResults: number; searchDepth: "basic" | "advanced" },
    signal: AbortSignal,
  ): Promise<Response> {
    return fetch(`${this.baseUrl}/search`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        query: request.query,
        search_depth: request.searchDepth,
        max_results: request.maxResults,
        include_answer: false,
        include_raw_content: false,
        include_images: false,
      }),
      signal,
    });
  }

  private normalizeResult(entry: {
    title?: unknown;
    url?: unknown;
    content?: unknown;
    score?: unknown;
  }): WebSearchResult {
    const title = typeof entry.title === "string" ? entry.title : "";
    const url = typeof entry.url === "string" ? entry.url : "";
    const content = typeof entry.content === "string" ? entry.content : "";
    const score = typeof entry.score === "number" ? entry.score : undefined;

    // Reject malformed entries rather than propagating arbitrary values.
    if (!url) {
      throw new TavilySearchError(
        TavilySearchError.ErrorType.MALFORMED_RESPONSE,
        "Tavily returned a result without a URL",
      );
    }

    return { title, url, content, score };
  }

  private toSearchError(error: unknown, timeoutSignal: AbortSignal | undefined): TavilySearchError {
    // Timeout takes precedence: a timeout signal aborts with a TimeoutError
    // reason even though fetch surfaces it as an AbortError.
    const reason: unknown = timeoutSignal?.reason;
    if (reason instanceof DOMException && reason.name === "TimeoutError") {
      return new TavilySearchError(TavilySearchError.ErrorType.TIMEOUT, "Tavily search timed out");
    }

    // User-initiated abort (request cancellation).
    if (error instanceof DOMException && error.name === "AbortError") {
      return new TavilySearchError(TavilySearchError.ErrorType.USER_ABORT, "Search was cancelled");
    }

    // Timeout (AbortSignal.timeout() throws DOMException with name "TimeoutError").
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return new TavilySearchError(TavilySearchError.ErrorType.TIMEOUT, "Tavily search timed out");
    }

    // Network failure.
    if (
      error instanceof TypeError &&
      /fetch failed|failed to fetch|network/i.test(error.message)
    ) {
      return new TavilySearchError(
        TavilySearchError.ErrorType.NETWORK_ERROR,
        "Tavily search connection failed",
      );
    }

    // Unexpected error.
    const message = error instanceof Error ? error.message : String(error);
    return new TavilySearchError(TavilySearchError.ErrorType.UNKNOWN, message);
  }
}
