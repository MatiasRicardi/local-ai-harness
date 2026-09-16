import { describe, it, expect } from "vitest";
import { toOpenAiToolDefinition, type OpenAIToolDefinition } from "../openAiToolDefinition.js";
import type { ToolDefinition } from "../types.js";

const DEFINITION: ToolDefinition = {
  name: "web_search",
  description: "Search the web",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

const EXPECTED_WIRE: OpenAIToolDefinition = {
  type: "function",
  function: {
    name: "web_search",
    description: "Search the web",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
};

describe("toOpenAiToolDefinition", () => {
  it("maps name, description and inputSchema to the OpenAI function shape", () => {
    expect(toOpenAiToolDefinition(DEFINITION)).toEqual(EXPECTED_WIRE);
  });

  it("does not mutate or share a reference to the input definition", () => {
    const result = toOpenAiToolDefinition(DEFINITION);
    expect(result.function.parameters).not.toBe(DEFINITION.inputSchema);
    expect(DEFINITION.inputSchema).toEqual({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    });
  });

  it("keeps the internal definition unchanged across repeated calls", () => {
    const first = toOpenAiToolDefinition(DEFINITION);
    (first.function.parameters as { required?: unknown[] }).required?.push("extra");
    expect(DEFINITION.inputSchema).toEqual({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    });
  });
});
