// ── Generic tool contracts ────────────────────────────────────────────────────
//
// Provider-agnostic building blocks for tools that a model may call through a
// future orchestration layer. This layer is intentionally decoupled from any
// concrete provider (e.g. the Tavily web-search provider implemented later) so
// that generic orchestration never imports provider-specific behavior.

/**
 * Static description of a tool as it would be exposed to a model.
 *
 * `inputSchema` follows the JSON-Schema shape used by OpenAI-compatible
 * chat-completion APIs so it can be forwarded to a model unchanged.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Runtime context passed to a tool on every execution.
 *
 * Currently carries an optional `AbortSignal` so a tool can honour request
 * cancellation. New fields can be added here without touching call sites.
 */
export interface ToolExecutionContext {
  signal?: AbortSignal;
}

/**
 * Result returned by a successfully executed tool.
 *
 * `content` is the normalized, model-facing payload. `metadata` is optional and
 * may carry structured data (e.g. source links) that later layers can surface.
 */
export interface ToolExecutionResult {
  content: string;
  metadata?: Record<string, unknown>;
}

/**
 * A tool is a named, executable unit.
 *
 * `args` is intentionally `unknown`: each concrete tool owns its argument
 * validation (typically a Zod schema) and must validate its own input before
 * performing external work. Keeping `args` untyped here preserves the
 * provider-agnostic contract — the generic layer never assumes a shared
 * argument shape across tools.
 */
export interface Tool {
  definition: ToolDefinition;
  execute(
    args: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
}

/**
 * Resolves tools by name and lists their definitions.
 *
 * Kept intentionally small: no lifecycle hooks, permissions, plugins, or
 * dynamic loading.
 */
export interface ToolRegistry {
  /** Returns the registered tool, or `undefined` when the name is unknown. */
  get(name: string): Tool | undefined;
  /**
   * Returns the definitions of all registered tools.
   *
   * The returned array must be a fresh collection so callers cannot mutate the
   * registry's internal state through it.
   */
  listDefinitions(): ToolDefinition[];
}
