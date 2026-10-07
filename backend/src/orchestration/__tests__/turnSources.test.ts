import { describe, it, expect } from "vitest";
import { TurnSourceAccumulator, normalizeSourceUrlForDedup } from "../turnSources.js";

function idOf(sources: Array<{ id: number }>): number[] {
  return sources.map((s) => s.id);
}

describe("normalizeSourceUrlForDedup", () => {
  it("lowercases scheme and host, strips default ports and the hash fragment", () => {
    expect(normalizeSourceUrlForDedup("https://Example.COM:443/Path?a=1#frag")).toBe(
      "https://example.com/Path?a=1",
    );
    expect(normalizeSourceUrlForDedup("http://example.com:80/x")).toBe(
      "http://example.com/x",
    );
  });

  it("preserves path/query casing and trailing slash (only scheme/host/port/hash change)", () => {
    expect(normalizeSourceUrlForDedup("https://Example.com/Path?A=B&C=D/")).toBe(
      "https://example.com/Path?A=B&C=D/",
    );
  });

  it("treats a hash fragment as the same page", () => {
    expect(normalizeSourceUrlForDedup("https://example.com/page#top")).toBe(
      normalizeSourceUrlForDedup("https://example.com/page"),
    );
  });

  it("treats a different query string as a different page", () => {
    expect(normalizeSourceUrlForDedup("https://example.com/p?a=1")).not.toBe(
      normalizeSourceUrlForDedup("https://example.com/p?a=2"),
    );
  });

  it("treats a different trailing slash as a different page", () => {
    expect(normalizeSourceUrlForDedup("https://example.com/dir")).not.toBe(
      normalizeSourceUrlForDedup("https://example.com/dir/"),
    );
  });
});

describe("TurnSourceAccumulator", () => {
  it("returns an empty list for empty input", () => {
    const acc = new TurnSourceAccumulator();
    expect(acc.add([])).toEqual([]);
  });

  it("assigns sequential ids and accumulates across calls (cumulative)", () => {
    const acc = new TurnSourceAccumulator();

    const afterFirst = acc.add([
      { title: "A", url: "https://a.com" },
      { title: "B", url: "https://b.com" },
    ]);
    expect(idOf(afterFirst)).toEqual([1, 2]);

    const afterSecond = acc.add([{ title: "C", url: "https://c.com" }]);
    expect(idOf(afterSecond)).toEqual([1, 2, 3]);
  });

  it("deduplicates by normalized url, keeping the first id (fragment same page)", () => {
    const acc = new TurnSourceAccumulator();

    const first = acc.add([{ title: "A", url: "https://example.com/page" }]);
    const second = acc.add([{ title: "A", url: "https://example.com/page#comments" }]);

    expect(idOf(first)).toEqual([1]);
    expect(idOf(second)).toEqual([1]);
    expect(second).toEqual(first);
  });

  it("deduplicates across case/normalized differences", () => {
    const acc = new TurnSourceAccumulator();
    acc.add([{ title: "A", url: "https://Example.COM/page" }]);
    const second = acc.add([{ title: "A", url: "https://example.com/page" }]);
    expect(idOf(second)).toEqual([1]);
  });

  it("keeps a different query string as a separate source", () => {
    const acc = new TurnSourceAccumulator();
    acc.add([{ title: "A", url: "https://example.com/p?x=1" }]);
    const second = acc.add([{ title: "B", url: "https://example.com/p?x=2" }]);
    expect(idOf(second)).toEqual([1, 2]);
  });

  it("keeps a different trailing slash as a separate source", () => {
    const acc = new TurnSourceAccumulator();
    acc.add([{ title: "A", url: "https://example.com/dir" }]);
    const second = acc.add([{ title: "B", url: "https://example.com/dir/" }]);
    expect(idOf(second)).toEqual([1, 2]);
  });

  it("preserves an existing accumulator when a later tool adds no source (calculator)", () => {
    const acc = new TurnSourceAccumulator();
    const afterFirst = acc.add([{ title: "A", url: "https://a.com" }]);

    // add([]) re-emits the existing accumulator unchanged (never []).
    const preserved = acc.add([]);
    expect(idOf(preserved)).toEqual([1]);
    expect(preserved).toEqual(afterFirst);
  });

  it("shares one allocator between a reserved id and id-less sources (no collision)", () => {
    // Mirrors the orchestrator: a web_search block reserves its id from the
    // shared counter before its block is rendered, while a fetch_url source
    // committed through `add` gets one atomically. Both draw from the same
    // counter so a web_search block and a fetch_url source never both receive
    // the same `[N]` label (web search's own per-call `[1]`, `[2]`, … sequence
    // restarts each call and would collide).
    const acc = new TurnSourceAccumulator();

    const afterFetch = acc.add([{ title: "F", url: "https://f.com" }]);
    expect(idOf(afterFetch)).toEqual([1]);

    const reservation = acc.reserveSource("https://w.com");
    expect(reservation).toEqual({ id: 2, isNew: true });
    acc.commitSource({ title: "W", url: "https://w.com" }, reservation);
    expect(idOf(acc.toList())).toEqual([1, 2]);

    const afterMore = acc.add([{ title: "M", url: "https://m.com" }]);
    expect(idOf(afterMore)).toEqual([1, 2, 3]);
  });

  it("stores only id/title/url (no harness wrapper metadata)", () => {
    const acc = new TurnSourceAccumulator();
    const sources = acc.add([{ title: "A", url: "https://a.com" }]);
    expect(sources[0]).toEqual({ id: 1, title: "A", url: "https://a.com" });
    expect(sources[0]).not.toHaveProperty("sourceContentStart");
    expect(sources[0]).not.toHaveProperty("includedToolCharacters");
  });
});

describe("TurnSourceAccumulator — atomic, url-aware id reservation", () => {
  it("reserves a distinct id per reservation instead of the same free id", () => {
    // The bug this guards: an allocator that reported the smallest free id
    // without occupying it handed the same id to every result of one search
    // (`A -> 1`, `B -> 1`, `C -> 1`), so several urls were labeled `[1]`.
    const acc = new TurnSourceAccumulator();

    const a = acc.reserveSource("https://a.com");
    const b = acc.reserveSource("https://b.com");
    const c = acc.reserveSource("https://c.com");

    expect([a, b, c]).toEqual([
      { id: 1, isNew: true },
      { id: 2, isNew: true },
      { id: 3, isNew: true },
    ]);
  });

  it("reuses the existing id of a url committed earlier (reverse dedup)", () => {
    // fetch A -> id 1; a later web_search that returns A again must be rendered
    // with `[1]`, not with a fresh label that the frontend never learns about.
    const acc = new TurnSourceAccumulator();
    acc.add([{ title: "A", url: "https://a.com" }]);

    const reservation = acc.reserveSource("https://a.com#section");
    expect(reservation).toEqual({ id: 1, isNew: false });
    acc.commitSource({ title: "A again", url: "https://a.com#section" }, reservation);

    expect(acc.toList()).toEqual([{ id: 1, title: "A", url: "https://a.com" }]);
  });

  it("reuses the id of a url that is reserved but not committed yet", () => {
    // Two results of the SAME search pointing at the same page: the second one
    // gets the id the first one reserved, so both blocks carry one label and the
    // cumulative list holds a single entry.
    const acc = new TurnSourceAccumulator();

    const first = acc.reserveSource("https://a.com");
    const second = acc.reserveSource("https://a.com");

    expect(second).toEqual({ id: first.id, isNew: false });
  });

  it("continues after a committed source instead of restarting at 1", () => {
    // fetch X first, then a three-result search: the search ids must continue
    // the shared counter (2, 3, 4) instead of restarting at 1.
    const acc = new TurnSourceAccumulator();
    acc.add([{ title: "X", url: "https://x.com" }]);

    const ids = ["https://a.com", "https://b.com", "https://c.com"].map(
      (url) => acc.reserveSource(url).id,
    );
    expect(ids).toEqual([2, 3, 4]);

    for (const [index, url] of ["https://a.com", "https://b.com", "https://c.com"].entries()) {
      acc.commitSource({ title: `S${index}`, url }, { id: ids[index], isNew: true });
    }
    expect(idOf(acc.toList())).toEqual([1, 2, 3, 4]);
  });

  it("releases a dropped reservation so its id becomes free again", () => {
    // A block truncated away was never shown to the model, so its label must not
    // stay burned for the rest of the turn.
    const acc = new TurnSourceAccumulator();

    const kept = acc.reserveSource("https://a.com");
    const dropped = acc.reserveSource("https://b.com");
    acc.commitSource({ title: "A", url: "https://a.com" }, kept);
    acc.releaseSource("https://b.com", dropped);

    expect(acc.reserveSource("https://b.com")).toEqual({ id: 2, isNew: true });

    // Releasing a committed source's reservation never frees its id: it is in
    // front of the model, so the next new source takes the next free id.
    acc.releaseSource("https://a.com", kept);
    expect(acc.reserveSource("https://d.com")).toEqual({ id: 3, isNew: true });
    expect(idOf(acc.toList())).toEqual([1]);
  });

  it("ignores a commit whose reservation does not belong to its url", () => {
    const acc = new TurnSourceAccumulator();
    const reservation = acc.reserveSource("https://a.com");

    acc.commitSource({ title: "B", url: "https://b.com" }, reservation);
    expect(acc.toList()).toEqual([]);

    acc.commitSource({ title: "A", url: "https://a.com" }, reservation);
    expect(acc.toList()).toEqual([{ id: 1, title: "A", url: "https://a.com" }]);
  });

  it("keys an unparseable url by its raw string and still assigns a unique id", () => {
    // A block whose url cannot be parsed still needs a label the model can see,
    // and that label must never be shared with another block.
    const acc = new TurnSourceAccumulator();

    const broken = acc.reserveSource("not a url");
    const other = acc.reserveSource("also not a url");
    const sameBroken = acc.reserveSource("not a url");

    expect(broken).toEqual({ id: 1, isNew: true });
    expect(other).toEqual({ id: 2, isNew: true });
    expect(sameBroken).toEqual({ id: 1, isNew: false });
  });

  it("keeps reservations isolated between accumulator instances", () => {
    // Request-local only: no module-level or static counter is involved.
    const first = new TurnSourceAccumulator();
    first.add([{ title: "A", url: "https://a.com" }]);
    first.reserveSource("https://b.com");

    expect(new TurnSourceAccumulator().reserveSource("https://a.com")).toEqual({
      id: 1,
      isNew: true,
    });
  });
});
