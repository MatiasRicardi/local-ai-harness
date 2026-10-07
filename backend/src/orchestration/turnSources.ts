import {
  sanitizeSourceCandidate,
  type SanitizedSourceCandidate,
  type SourceRef,
} from "../tools/sourceSanitization.js";

// ── Turn-local cumulative source accumulator (pure, deterministic) ────────────
//
// A single chat turn can execute several tools, each of which may contribute a
// source (web search contributes `[N]`-numbered blocks, fetch_url contributes a
// single page). The frontend replaces `message.sources` on every `sources` SSE
// event, so the backend must emit the CUMULATIVE, deduplicated, stable-id list
// on each event — never only the most recent tool's sources.
//
// This accumulator is request/turn-local: it is created fresh per turn and holds
// no state beyond it. It sanitizes remote candidates, deduplicates by normalized
// URL, and assigns/preserves positive numeric ids. web_search carries its
// model-visible ids (used inside its `[N]` content blocks), so those are kept
// verbatim; fetch_url carries no id, so the accumulator assigns the smallest
// unused positive integer.

/**
 * A source delivered to the model, before id assignment.
 *
 * `title`/`url` are the raw (still untrusted) values from the tool result; the
 * accumulator sanitizes them. `id` is present only for web search (its
 * model-visible block id) and must be preserved; fetch_url omits it.
 */
export interface DeliveredSource {
  title: string;
  url: string;
  id?: number;
}

/**
 * Canonicalize a URL for deduplication using the WHATWG `URL` serializer:
 * scheme/hostname casing and default ports are normalized and the fragment is
 * dropped, so `https://EXAMPLE.com:443/page#section` and
 * `https://example.com/page#other` share a key. Query strings and path casing
 * are preserved (they can denote different resources) and nothing is manually
 * decoded.
 */
export function normalizeSourceUrlForDedup(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = "";
  return url.toString();
}

/**
 * Turn-local accumulator of the cumulative, deduplicated, stable-id source list.
 *
 * Every {@link add} call merges the just-delivered candidates into the running
 * list and returns the full, current list so the caller can emit it unchanged.
 */
export class TurnSourceAccumulator {
  // Keyed by normalized URL so dedup stays O(1); keeps the canonical SourceRef.
  private readonly byKey = new Map<string, SourceRef>();
  // Insertion order, so the emitted list is stable and deterministic.
  private readonly order: string[] = [];
  // Ids already handed out, to pick the smallest free positive integer.
  private readonly usedIds = new Set<number>();

  /**
   * Merge the delivered candidates of one tool execution into the running list.
   *
   * Returns the complete, current cumulative list (sanitized, deduplicated,
   * id-assigned) so the orchestrator can emit it verbatim on the `sources`
   * event. Passing no candidates (e.g. a `calculator` run) still returns the
   * existing accumulated list, so prior sources are never dropped.
   */
  add(delivered: readonly DeliveredSource[]): SourceRef[] {
    for (const candidate of delivered) {
      let sanitized: SanitizedSourceCandidate | undefined;
      try {
        sanitized = sanitizeSourceCandidate(candidate);
      } catch {
        continue;
      }
      if (sanitized === undefined) {
        continue;
      }

      const key = normalizeSourceUrlForDedup(sanitized.url);
      // Deduplicate by normalized URL: reuse the existing entry (and its id)
      // instead of showing a duplicate.
      if (this.byKey.has(key)) {
        continue;
      }

      const id = this.reserveId(candidate.id);
      if (id === undefined) {
        continue;
      }

      this.usedIds.add(id);
      this.byKey.set(key, { id, title: sanitized.title, url: sanitized.url });
      this.order.push(key);
    }

    return this.toList();
  }

  /** Smallest unused positive integer id, or the candidate's id when valid. */
  private reserveId(candidateId: number | undefined): number | undefined {
    if (typeof candidateId === "number" && Number.isInteger(candidateId) && candidateId > 0) {
      return candidateId;
    }
    let id = 1;
    while (this.usedIds.has(id)) {
      id++;
    }
    return id;
  }

  /** Snapshot of the current cumulative source list, in insertion order. */
  toList(): SourceRef[] {
    return this.order.map((key) => {
      const source = this.byKey.get(key);
      // Defensive: every key pushed to `order` was stored in `byKey`.
      return source ?? { id: 0, title: "", url: "" };
    });
  }
}
