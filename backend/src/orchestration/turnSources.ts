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
// no state beyond it (no module-level or static counter). It sanitizes remote
// candidates, deduplicates by normalized URL, and assigns/preserves positive
// numeric ids. Both source types draw their ids from the same turn-local
// allocator, so a `web_search` block and a `fetch_url` source can never both
// receive the same `[N]` label.
//
// Id assignment is ATOMIC and URL-aware: {@link reserveSource} resolves a known
// URL to its existing id or allocates the smallest free id and reserves it in
// the same call, so two reservations for two different URLs can never receive
// the same id, and a reservation made before a model-facing block is rendered
// can never be handed to a later caller. {@link commitSource} turns a
// reservation into a delivered source, {@link releaseSource} gives back a
// reservation whose block never reached the model.

/**
 * A source delivered to the model, before id assignment.
 *
 * `title`/`url` are the raw (still untrusted) values from the tool result; the
 * accumulator sanitizes them. The id is never supplied by a tool: it always
 * comes from {@link TurnSourceAccumulator.reserveSource}, the only place turn-
 * local ids are drawn, so the `[N]` the model sees and the `SourceRef.id` sent
 * over SSE can never disagree.
 */
export interface DeliveredSource {
  title: string;
  url: string;
}

/**
 * Outcome of an atomic id reservation (see {@link TurnSourceAccumulator.reserveSource}).
 *
 * The id is already reserved when this is returned: no later reservation, from
 * this or any other caller inside the same turn, can receive it.
 */
export interface SourceReservation {
  /** Reserved turn-local id: a positive integer, request-local to this turn. */
  readonly id: number;
  /**
   * `true` when the call consumed a brand-new id, `false` when the URL was
   * already known and its existing id was returned (deduplication).
   */
  readonly isNew: boolean;
}

/**
 * Canonicalize a URL for deduplication using the WHATWG `URL` serializer:
 * scheme/hostname casing and default ports are normalized and the fragment is
 * dropped, so `https://EXAMPLE.com:443/page#section` and
 * `https://example.com/page#other` share a key. Query strings, path casing and
 * trailing slashes are preserved (they can denote different resources) and
 * nothing is manually decoded. Throws for a non-parseable URL.
 */
export function normalizeSourceUrlForDedup(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = "";
  return url.toString();
}

/**
 * Deduplication key for a URL: the normalized form when it parses. A URL that
 * cannot be parsed cannot be canonicalized, so it is keyed by its raw string.
 * A raw unparseable string can never collide with a normalized key (parsing is
 * idempotent: the serializer's own output always re-parses to itself).
 */
function dedupKey(rawUrl: string): string {
  try {
    return normalizeSourceUrlForDedup(rawUrl);
  } catch {
    return rawUrl;
  }
}

/**
 * Turn-local accumulator of the cumulative, deduplicated, stable-id source list.
 *
 * Two entry states are tracked separately:
 *   - *reserved* ids: handed out by {@link reserveSource} (and so already
 *     invisible to any later reservation) but not yet part of the emitted list;
 *   - *committed* sources: delivered to the model and emitted on `sources`.
 * {@link add} performs both steps in one call and is the convenience path used
 * when the caller does not need the id before building model-facing content.
 */
export class TurnSourceAccumulator {
  // Committed sources, keyed by normalized URL so dedup stays O(1).
  private readonly committed = new Map<string, SourceRef>();
  // Insertion order of committed keys, so the emitted list is stable.
  private readonly order: string[] = [];
  // Every id handed out or committed, to pick the smallest free positive integer.
  private readonly usedIds = new Set<number>();
  // Reserved-but-not-committed reservations, keyed the same way as `committed`.
  private readonly pending = new Map<string, number>();

  /**
   * Resolve the turn-local id of `rawUrl`, or atomically allocate a new one.
   *
   * ```text
   * URL already known (delivered or reserved earlier this turn) -> its id, isNew: false
   * URL seen for the first time                                 -> smallest free id,
   *                                                               reserved by this call,
   *                                                               isNew: true
   * ```
   *
   * The reservation happens inside this call, so a caller may resolve every URL
   * of a multi-result tool (a single `web_search` returning A, B, C) up-front
   * and get distinct ids (never the same id three times), and a `web_search`
   * that re-returns a URL already fetched by `fetch_url` gets that source's
   * existing id instead of a fresh label. Ids stay request-local deterministic
   * positive integers; no global state is involved.
   */
  reserveSource(rawUrl: string): SourceReservation {
    const key = dedupKey(rawUrl);

    const existing = this.committed.get(key);
    if (existing !== undefined) {
      return { id: existing.id, isNew: false };
    }
    const reserved = this.pending.get(key);
    if (reserved !== undefined) {
      return { id: reserved, isNew: false };
    }

    let id = 1;
    while (this.usedIds.has(id)) {
      id++;
    }
    this.usedIds.add(id);
    this.pending.set(key, id);
    return { id, isNew: true };
  }

  /**
   * Turn a reservation into a delivered source and add it to the cumulative
   * list. The URL of `candidate` must be the URL the reservation was taken for;
   * a candidate whose URL is already in the list keeps its original entry and
   * id, and a candidate whose reservation does not belong to its URL (a caller
   * mistake) is ignored rather than mislabeled.
   */
  commitSource(candidate: DeliveredSource, reservation: SourceReservation): void {
    const key = dedupKey(candidate.url);
    if (this.committed.has(key)) {
      return;
    }
    if (this.pending.get(key) !== reservation.id) {
      return;
    }
    this.pending.delete(key);
    this.committed.set(key, { id: reservation.id, title: candidate.title, url: candidate.url });
    this.order.push(key);
  }

  /**
   * Give back a reservation whose source never reached the model (for example a
   * search block dropped by context truncation): the id is released so a later
   * tool in the same turn can use it. Reservations whose URL is already
   * committed are never released, because that id belongs to the earlier source.
   */
  releaseSource(rawUrl: string, reservation: SourceReservation): void {
    const key = dedupKey(rawUrl);
    if (this.committed.has(key)) {
      return;
    }
    if (this.pending.get(key) === reservation.id) {
      this.pending.delete(key);
      this.usedIds.delete(reservation.id);
    }
  }

  /**
   * Merge the delivered candidates of one tool execution into the running list.
   *
   * Returns the complete, current cumulative list (sanitized, deduplicated,
   * id-assigned) so the orchestrator can emit it verbatim on the `sources`
   * event. Passing no candidates (e.g. a `calculator` run) still returns the
   * existing accumulated list, so prior sources are never dropped. Each
   * candidate is reserved and committed atomically, so it can never share an
   * id with another source of the same turn.
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
      this.commitSource(sanitized, this.reserveSource(sanitized.url));
    }

    return this.toList();
  }

  /** Snapshot of the current cumulative source list, in insertion order. */
  toList(): SourceRef[] {
    return this.order.map((key) => {
      const source = this.committed.get(key);
      // Defensive: every key pushed to `order` was stored in `committed`.
      return source ?? { id: 0, title: "", url: "" };
    });
  }
}
