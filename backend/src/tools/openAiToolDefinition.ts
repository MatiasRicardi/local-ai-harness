import type { ToolDefinition } from "./types.js";

// ── OpenAI tool-definition adapter ───────────────────────────────────────────
//
// The generic tool layer describes a tool with the internal {@link ToolDefinition}
// shape (`{ name, description, inputSchema }`). That shape is NOT the OpenAI Chat
// Completions wire format, so it cannot be sent to a provider unchanged. This
// adapter is the single, pure conversion point from the internal shape to the
// OpenAI `{ type: "function", function: { name, description, parameters } }`
// object. The provider client is the only consumer; there is no second, parallel
// conversion anywhere in the codebase.

/**
 * A single OpenAI Chat Completions tool object on the wire:
 * `{ type: "function", function: { name, description, parameters } }`.
 */
export interface OpenAIToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * Convert an internal generic {@link ToolDefinition} into an
 * {@link OpenAIToolDefinition}.
 *
 * Pure: it does not mutate or share references to the input definition, so the
 * shared tool definitions (e.g. `webSearchToolDefinition`) stay immutable.
 */
export function toOpenAiToolDefinition(
  definition: ToolDefinition,
): OpenAIToolDefinition {
  return {
    type: "function",
    function: {
      name: definition.name,
      description: definition.description,
      // Deep-clone so the wire object never shares a reference with the shared,
      // immutable tool definition (e.g. `webSearchToolDefinition`).
      parameters: structuredClone(definition.inputSchema),
    },
  };
}
