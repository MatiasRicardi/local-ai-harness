import { z } from "zod";

// ── Generic web-search contracts ─────────────────────────────────────────────
//
// Provider-agnostic building blocks for the web-search feature. These types are
// intentionally decoupled from any concrete provider (e.g. the Tavily
// web-search provider implemented in tavily.ts) so that generic orchestration
// never imports provider-specific behavior.

/**
 * A single normalized web-search result.
 *
 * `score` is optional because not every provider ranks results with a numeric
 * confidence value.
 */
export interface WebSearchResult {
  title: string;
  url: string;
  content: string;
  score?: number;
}

/**
 * Provider-agnostic search request.
 */
export interface WebSearchRequest {
  query: string;
  maxResults: number;
  searchDepth: "basic" | "advanced";
}

/**
 * Abstract web-search provider interface.
 *
 * Implementations perform the external search call and return normalized
 * results. Cancellation is supported through an optional `AbortSignal`.
 */
export interface WebSearchProvider {
  search(
    request: WebSearchRequest,
    options?: { signal?: AbortSignal },
  ): Promise<WebSearchResult[]>;
}

// ── Request validation ────────────────────────────────────────────────────────

/**
 * Conservative backend limits enforced before any external call.
 *
 * - query: non-empty, trimmed, max 500 characters
 * - maxResults: integer, min 1, max 10
 * - searchDepth: "basic" | "advanced"
 */
export const WEB_SEARCH_MAX_QUERY = 500;
export const WEB_SEARCH_MAX_RESULTS = 10;
export const WEB_SEARCH_MIN_RESULTS = 1;

export const webSearchRequestSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1, "Query must not be empty")
    .max(WEB_SEARCH_MAX_QUERY, `Query must not exceed ${WEB_SEARCH_MAX_QUERY} characters`),
  maxResults: z
    .int()
    .min(WEB_SEARCH_MIN_RESULTS, `maxResults must be at least ${WEB_SEARCH_MIN_RESULTS}`)
    .max(WEB_SEARCH_MAX_RESULTS, `maxResults must not exceed ${WEB_SEARCH_MAX_RESULTS}`)
    .default(5),
  searchDepth: z.enum(["basic", "advanced"]).default("basic"),
});

export type WebSearchRequestInput = z.infer<typeof webSearchRequestSchema>;

/**
 * Normalize a search base URL once.
 *
 * Behavior:
 *   - trims surrounding whitespace;
 *   - rejects empty values;
 *   - requires an http/https URL;
 *   - collapses duplicate slashes and strips trailing slashes so requests never
 *     contain accidental double slashes (e.g. `.../com//search`).
 *
 * Throws on invalid input so misconfiguration fails fast at construction time.
 */
export function normalizeSearchBaseUrl(baseUrl: string | undefined | null): string {
  const trimmed = (baseUrl ?? "").trim();

  if (!trimmed) {
    throw new Error("Search base URL is required");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Search base URL must be a valid URL: "${trimmed}"`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Search base URL must use http or https protocol: "${trimmed}"`);
  }

  // Collapse internal duplicate slashes and strip trailing slashes.
  const cleanedPath = parsed.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
  parsed.pathname = cleanedPath;

  // `URL.toString()` always appends a trailing slash for an empty path; strip
  // it so callers can safely append `/search` without a double slash.
  let result = parsed.toString();
  if (result.endsWith("/")) {
    result = result.slice(0, -1);
  }

  return result;
}

/**
 * Combine two AbortSignals so that aborting either one aborts the combined
 * signal. Falls back to a simple implementation when `AbortSignal.any()` is
 * unavailable.
 */
export function combineSignals(
  ...signals: Array<AbortSignal | undefined | null>
): AbortSignal {
  const active = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined && signal !== null,
  );

  if (active.length === 0) {
    // No input signals: return a signal that never aborts on its own so callers
    // can still pass a single combined signal to fetch.
    const controller = new AbortController();
    return controller.signal;
  }

  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(active);
  }

  const controller = new AbortController();
  for (const signal of active) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}
