import { describe, it, expect } from "vitest";
import {
  MapToolRegistry,
  createToolRegistry,
  ToolRegistrationError,
} from "../registry.js";
import type { Tool, ToolDefinition } from "../types.js";
import { AppError } from "../../utils/errorHandler.js";
import { z } from "zod";

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildTool(definition: ToolDefinition): Tool {
  return {
    definition,
    execute: async () => ({ content: "ok" }),
  };
}

const SEARCH_DEFINITION: ToolDefinition = {
  name: "web_search",
  description: "Search the web for up-to-date information.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
    },
    required: ["query"],
  },
};

// ── get ───────────────────────────────────────────────────────────────────────

describe("MapToolRegistry.get", () => {
  it("returns a registered tool by name", () => {
    const registry = new MapToolRegistry();
    const tool = buildTool(SEARCH_DEFINITION);
    registry.register(tool);

    expect(registry.get("web_search")).toBe(tool);
  });

  it("returns undefined for an unknown tool name", () => {
    const registry = new MapToolRegistry();

    expect(registry.get("does-not-exist")).toBeUndefined();
  });
});

// ── listDefinitions ───────────────────────────────────────────────────────────

describe("MapToolRegistry.listDefinitions", () => {
  it("returns only definitions without exposing implementation internals", () => {
    const registry = new MapToolRegistry();
    const tool = buildTool(SEARCH_DEFINITION);
    registry.register(tool);

    const definitions = registry.listDefinitions();

    expect(definitions).toEqual([SEARCH_DEFINITION]);
    // No internal Tool reference leaks through the accessor.
    for (const definition of definitions) {
      expect(definition).not.toBe(tool);
    }
  });

  it("returns a fresh array that does not share references with internal state", () => {
    const registry = new MapToolRegistry();
    registry.register(buildTool(SEARCH_DEFINITION));

    const first = registry.listDefinitions();
    first.push({ name: "injected", description: "", inputSchema: {} });

    // Mutating the returned array must not affect the registry.
    expect(registry.listDefinitions()).toHaveLength(1);
  });
});

// ── register duplicates ───────────────────────────────────────────────────────

describe("MapToolRegistry.register", () => {
  it("rejects duplicate tool names with ToolRegistrationError", () => {
    const registry = new MapToolRegistry();
    registry.register(buildTool(SEARCH_DEFINITION));

    expect(() => registry.register(buildTool(SEARCH_DEFINITION))).toThrow(
      ToolRegistrationError,
    );
    expect(() => registry.register(buildTool(SEARCH_DEFINITION))).toThrow(
      'Tool already registered: "web_search"',
    );
  });

  it("keeps the first registration when a duplicate is rejected", () => {
    const registry = new MapToolRegistry();
    const first = buildTool(SEARCH_DEFINITION);
    registry.register(first);

    expect(() => registry.register(buildTool(SEARCH_DEFINITION))).toThrow(
      ToolRegistrationError,
    );
    // Deterministic: the registry still resolves to the original tool.
    expect(registry.get("web_search")).toBe(first);
  });

  it("allows distinct tool names", () => {
    const registry = new MapToolRegistry();

    expect(() =>
      registry.register(
        buildTool({ name: "a", description: "", inputSchema: {} }),
      ),
    ).not.toThrow();
    expect(() =>
      registry.register(
        buildTool({ name: "b", description: "", inputSchema: {} }),
      ),
    ).not.toThrow();

    expect(registry.listDefinitions()).toHaveLength(2);
  });
});

describe("createToolRegistry", () => {
  it("returns an empty registry", () => {
    const registry = createToolRegistry();

    expect(registry.listDefinitions()).toEqual([]);
    expect(registry.get("anything")).toBeUndefined();
  });
});

// ── validation failure maps into the existing error model ─────────────────────

describe("tool argument validation maps to VALIDATION_ERROR", () => {
  it("throws a VALIDATION_ERROR AppError when arguments are invalid", async () => {
    const querySchema = z.object({ query: z.string().min(1) });

    const tool: Tool = {
      definition: SEARCH_DEFINITION,
      execute: async (args: unknown) => {
        const parsed = querySchema.safeParse(args);
        if (!parsed.success) {
          // Existing error path: no new codes introduced in this step.
          throw new AppError({
            code: "VALIDATION_ERROR",
            statusCode: 400,
            message: "The search query must be a non-empty string.",
          });
        }
        return { content: `search(${parsed.data.query})` };
      },
    };

    const registry = new MapToolRegistry();
    registry.register(tool);

    const resolved = registry.get("web_search");
    expect(resolved).toBeDefined();

    const context = {};

    await expect(resolved!.execute({ query: "" }, context)).rejects.toBeInstanceOf(
      AppError,
    );

    const error = (await resolved!.execute({ query: "" }, context).catch(
      (error: unknown) => error,
    )) as AppError;
    expect(error.code).toBe("VALIDATION_ERROR");

    // Valid arguments still execute.
    await expect(resolved!.execute({ query: "cats" }, context)).resolves.toEqual({
      content: "search(cats)",
    });
  });
});
