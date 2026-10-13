import { describe, it, expect } from "vitest";
import { buildToolGuidanceMessage, NO_TOOLS_CAPABILITIES, type ToolCapabilities } from "../toolGuidance.js";

const ALL_CAPABILITIES: ToolCapabilities = {
  webSearch: true,
  calculator: true,
  fetchUrl: true,
};

/**
 * The eight possible capability combinations. Each entry names the enabled
 * tools so the "disabled tool is never advertised" assertions read clearly.
 */
const COMBINATIONS: Array<{ name: string; capabilities: ToolCapabilities; enabled: string[] }> = [
  { name: "none", capabilities: { webSearch: false, calculator: false, fetchUrl: false }, enabled: [] },
  { name: "calculator", capabilities: { webSearch: false, calculator: true, fetchUrl: false }, enabled: ["calculator"] },
  { name: "fetch", capabilities: { webSearch: false, calculator: false, fetchUrl: true }, enabled: ["fetch_url"] },
  { name: "web", capabilities: { webSearch: true, calculator: false, fetchUrl: false }, enabled: ["web_search"] },
  { name: "calculator+fetch", capabilities: { webSearch: false, calculator: true, fetchUrl: true }, enabled: ["calculator", "fetch_url"] },
  { name: "calculator+web", capabilities: { webSearch: true, calculator: true, fetchUrl: false }, enabled: ["calculator", "web_search"] },
  { name: "fetch+web", capabilities: { webSearch: true, calculator: false, fetchUrl: true }, enabled: ["web_search", "fetch_url"] },
  { name: "all", capabilities: ALL_CAPABILITIES, enabled: ["calculator", "fetch_url", "web_search"] },
];

// A tool is "advertised" when its name appears as a tool reference in the
// guidance text (backtick-quoted, matching how the guidance names tools).
function advertises(guidance: string | undefined, tool: string): boolean {
  return guidance?.includes(`\`${tool}\``) ?? false;
}

describe("buildToolGuidanceMessage", () => {
  it("returns undefined when no tool is enabled (no phantom guidance)", () => {
    expect(buildToolGuidanceMessage(NO_TOOLS_CAPABILITIES)).toBeUndefined();
  });

  it.each(COMBINATIONS.filter((c) => c.name !== "none"))("produces guidance for $name", ({ name, capabilities }) => {
    const guidance = buildToolGuidanceMessage(capabilities);
    expect(guidance).toBeDefined();
    expect(guidance!.role).toBe("system");
    expect(guidance!.content.length).toBeGreaterThan(0);
    // A single, compact system message per enabled capability set.
    expect(name).not.toBe("none");
  });

  it.each(COMBINATIONS.filter((c) => c.name !== "none"))("only advertises enabled tools for $name", ({ capabilities, enabled }) => {
    const guidance = buildToolGuidanceMessage(capabilities);
    expect(guidance).toBeDefined();

    for (const tool of ["web_search", "calculator", "fetch_url"]) {
      expect(advertises(guidance!.content, tool)).toBe(enabled.includes(tool));
    }
  });

  it.each(COMBINATIONS)("includes the sequential-execution instruction whenever tools are enabled", ({ capabilities }) => {
    const guidance = buildToolGuidanceMessage(capabilities);
    if (capabilities.webSearch || capabilities.calculator || capabilities.fetchUrl) {
      expect(guidance!.content).toContain("one tool call at a time");
      expect(guidance!.content).toContain("Parallel tool calls are not supported");
    }
  });

  it.each(COMBINATIONS.filter((c) => c.name !== "none"))("states the global limit of three executions when tools are enabled", ({ capabilities }) => {
    const guidance = buildToolGuidanceMessage(capabilities);
    expect(guidance).toBeDefined();
    expect(guidance!.content).toContain("at most 3 tool executions total");
  });

  it("calculator-only advertises calculator, not web_search or fetch_url, and no web-trust warning", () => {
    const guidance = buildToolGuidanceMessage({ webSearch: false, calculator: true, fetchUrl: false });
    expect(guidance).toBeDefined();
    expect(guidance!.content).toContain("calculator");
    expect(advertises(guidance!.content, "web_search")).toBe(false);
    expect(advertises(guidance!.content, "fetch_url")).toBe(false);
    expect(guidance!.content).not.toContain("untrusted reference material");
  });

  it("fetch_url-only advertises fetch_url with the local/private-network and untrusted guidance, not web_search", () => {
    const guidance = buildToolGuidanceMessage({ webSearch: false, calculator: false, fetchUrl: true });
    expect(guidance).toBeDefined();
    expect(guidance!.content).toContain("fetch_url");
    expect(advertises(guidance!.content, "web_search")).toBe(false);
    expect(guidance!.content).toContain("Local or private-network targets are unavailable");
    expect(guidance!.content).toContain("untrusted reference material");
  });

  it("web_search-only advertises web_search with one-search-per-turn guidance, not fetch_url", () => {
    const guidance = buildToolGuidanceMessage({ webSearch: true, calculator: false, fetchUrl: false });
    expect(guidance).toBeDefined();
    expect(guidance!.content).toContain("web_search");
    expect(guidance!.content).toContain("One search execution is available per user turn");
    expect(advertises(guidance!.content, "fetch_url")).toBe(false);
    expect(guidance!.content).toContain("untrusted reference material");
  });

  it("web_search + fetch_url recommends web_search -> fetch_url and warns against fetching every result", () => {
    const guidance = buildToolGuidanceMessage({ webSearch: true, calculator: false, fetchUrl: true });
    expect(guidance).toBeDefined();
    expect(advertises(guidance!.content, "web_search")).toBe(true);
    expect(advertises(guidance!.content, "fetch_url")).toBe(true);
    expect(guidance!.content).toContain("Do not fetch every result from a search");
  });

  it("all three includes every section without duplicating blocks", () => {
    const guidance = buildToolGuidanceMessage(ALL_CAPABILITIES);
    expect(guidance).toBeDefined();
    expect(advertises(guidance!.content, "calculator")).toBe(true);
    expect(advertises(guidance!.content, "web_search")).toBe(true);
    expect(advertises(guidance!.content, "fetch_url")).toBe(true);
    // The shared "General rules:" block appears exactly once.
    expect((guidance!.content.match(/General rules:/g) ?? []).length).toBe(1);
  });

  it("does not duplicate the untrusted-content block", () => {
    const guidance = buildToolGuidanceMessage({ webSearch: true, calculator: false, fetchUrl: true });
    expect((guidance!.content.match(/untrusted reference material/g) ?? []).length).toBe(1);
  });

  it("does not duplicate the runtime context message", () => {
    const guidance = buildToolGuidanceMessage({ webSearch: true, calculator: true, fetchUrl: true });
    expect((guidance!.content.match(/Current runtime context:/g) ?? []).length).toBe(0);
  });
});
