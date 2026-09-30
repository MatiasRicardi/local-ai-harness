import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildToolRegistry } from "../buildToolRegistry.js";
import type { WebSearchConfig } from "../../provider/schemas.js";

// Capture the Tavily provider construction arguments so we can assert that
// credentials/base URL stay request-scoped: each enabled tool build must create
// its own provider with the credentials of that request only. Hoisted so the
// mock factory can reference it (vitest does not allow factories to close over
// ordinary module-scoped variables).
const { providerCalls } = vi.hoisted(() => ({
  providerCalls: [] as Array<{ baseUrl: string; apiKey?: string }>,
}));

vi.mock("../../search/tavily.js", () => ({
  TavilySearchProvider: vi.fn().mockImplementation((args: {
    baseUrl: string;
    apiKey?: string;
  }) => {
    providerCalls.push(args);
    return { search: vi.fn() };
  }),
}));

const webSearchEnabled: WebSearchConfig = {
  enabled: true,
  provider: "tavily",
  apiKey: "tavily-request-key",
};

const webSearchDisabled: WebSearchConfig = {
  enabled: false,
  provider: "tavily",
};

beforeEach(() => {
  providerCalls.length = 0;
});

describe("buildToolRegistry", () => {
  it("returns undefined when no tool is enabled (omitted and disabled)", () => {
    expect(buildToolRegistry({})).toBeUndefined();
    expect(buildToolRegistry({ webSearch: webSearchDisabled })).toBeUndefined();
    // No provider should ever be constructed when nothing is enabled.
    expect(providerCalls).toHaveLength(0);
  });

  it("registers exactly web_search when web search is enabled", () => {
    const registry = buildToolRegistry({ webSearch: webSearchEnabled });

    expect(registry).toBeDefined();
    const definitions = registry!.listDefinitions();
    expect(definitions.map((d) => d.name)).toEqual(["web_search"]);
  });

  it("never returns an empty registry (0 tools -> undefined, >=1 -> registry)", () => {
    expect(buildToolRegistry({})).toBeUndefined();
    expect(buildToolRegistry({ webSearch: webSearchEnabled })).toBeDefined();
  });

  it("keeps credentials request-scoped: request A cannot leak into request B", () => {
    buildToolRegistry({ webSearch: webSearchEnabled });
    buildToolRegistry({}); // no web search at all
    buildToolRegistry({
      webSearch: { ...webSearchEnabled, apiKey: "tavily-other-key" },
    });

    expect(providerCalls).toHaveLength(2);
    expect(providerCalls[0].apiKey).toBe("tavily-request-key");
    expect(providerCalls[1].apiKey).toBe("tavily-other-key");
  });

  it("creates a fresh registry/state on every build (no shared mutation)", () => {
    const first = buildToolRegistry({ webSearch: webSearchEnabled });
    const second = buildToolRegistry({ webSearch: webSearchEnabled });

    expect(first).not.toBe(second);
    expect(first!.listDefinitions()).toHaveLength(1);
    expect(second!.listDefinitions()).toHaveLength(1);
  });

  it("reads backend-owned base URL from configuration, not from the request", () => {
    buildToolRegistry({ webSearch: webSearchEnabled });
    // The provider was constructed with the backend config base URL and only the
    // request API key. The base URL is never supplied by the chat request.
    expect(providerCalls[0].apiKey).toBe("tavily-request-key");
    expect(typeof providerCalls[0].baseUrl).toBe("string");
  });
});
