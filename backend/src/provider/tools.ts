import type { ToolDefinition } from "../tools/types.js";

// ── Provider chat options (optional tool calling) ────────────────────────────
//
// The client accepts the generic internal tool definition
// ({@link ToolDefinition}: `{ name, description, inputSchema }`) produced by the
// tool layer and converts it to the OpenAI Chat Completions wire shape at
// serialization time (see `OpenAICompatibleClient.buildRequestBody`). The client
// never sends the internal shape on the wire.

/**
 * Options that extend a provider chat request with optional tool calling.
 */
export interface ChatToolOptions {
  /**
   * Tool definitions to expose to the model, as the generic internal
   * {@link ToolDefinition} shape. When omitted or empty, neither `tools` nor
   * `tool_choice` are sent on the wire. The client converts each definition to
   * the OpenAI `{ type: "function", function: {...} }` shape before sending.
   */
  tools?: readonly ToolDefinition[];

  /**
   * How the model should pick a tool choice. Defaults to `"auto"` whenever
   * tools are present; `"none"` forces the model to skip tool use.
   */
  toolChoice?: "auto" | "none";
}
