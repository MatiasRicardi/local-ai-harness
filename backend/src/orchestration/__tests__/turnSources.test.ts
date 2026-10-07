import { describe, it, expect } from "vitest";
import {
  TurnSourceAccumulator,
  normalizeSourceUrlForDedup,
  type DeliveredSource,
} from "../turnSources.js";

function idOf(sources: DeliveredSource[]): number[] {
  return sources.map((s) => (s.id ?? 0));
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

  it("stores only id/title/url (no harness wrapper metadata)", () => {
    const acc = new TurnSourceAccumulator();
    const sources = acc.add([{ title: "A", url: "https://a.com" }]);
    expect(sources[0]).toEqual({ id: 1, title: "A", url: "https://a.com" });
    expect(sources[0]).not.toHaveProperty("sourceContentStart");
    expect(sources[0]).not.toHaveProperty("includedToolCharacters");
  });
});
