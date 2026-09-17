// ── Source metadata sanitization (pure) ──────────────────────────────────────
//
// Backend-side guard for the structured `sources` SSE metadata. Sources derive
// from untrusted external search results, so every entry is re-validated before
// it reaches the wire: only entries with a numeric `id` and a safe
// `http:`/`https:` `url` survive. `content`/snippets are never forwarded — the
// `sources` payload carries only `{ id, title, url }`.
//
// Kept in its own module so the rule lives in one place and can be unit-tested
// in isolation from both the tool and the SSE route.

/**
 * A single, wire-safe source reference.
 *
 * Deliberately omits the result `content`: sources carry only enough metadata
 * for the UI to attribute and link to the origin, never the (untrusted) body.
 */
export interface SourceRef {
  id: number;
  title: string;
  url: string;
}

type MaybeSource = { id?: unknown; title?: unknown; url?: unknown } | null | undefined;

/**
 * Validate a single source URL.
 *
 * Returns the trimmed URL when it is a non-empty `http:`/`https:` URL, or
 * `undefined` otherwise (non-strings, malformed URLs, and schemes such as
 * `file:`, `data:` or `javascript:` are rejected).
 */
export function sanitizeSourceUrl(url: unknown): string | undefined {
  if (typeof url !== "string") {
    return undefined;
  }

  const trimmed = url.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }

  // Allow only web HTTP(S) links. This also drops the Tavily base URL and any
  // other non-https scheme that could leak configuration into source metadata.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return undefined;
  }

  return trimmed;
}

/**
 * Sanitize an arbitrary `metadata.sources` value into a list of {@link SourceRef}.
 *
 * - Non-array input yields an empty list.
 * - Entries without a numeric `id` or a safe URL are dropped.
 * - Missing/invalid `title` becomes an empty string.
 * - The returned array length equals the number of sources actually emitted,
 *   so callers can derive `tool_end.resultCount` from it.
 */
export function sanitizeSources(sources: unknown): SourceRef[] {
  if (!Array.isArray(sources)) {
    return [];
  }

  const out: SourceRef[] = [];
  for (const entry of sources) {
    const maybe = entry as MaybeSource;

    const url = sanitizeSourceUrl(maybe?.url);
    if (url === undefined) {
      continue;
    }

    const id = maybe?.id;
    if (typeof id !== "number" || !Number.isFinite(id)) {
      continue;
    }

    const title = typeof maybe?.title === "string" ? maybe.title : "";
    out.push({ id, title, url });
  }

  return out;
}
