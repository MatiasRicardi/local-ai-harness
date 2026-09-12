import type { Tool, ToolDefinition, ToolRegistry } from "./types.js";

/**
 * Raised when a tool name is registered more than once.
 *
 * This is internal infrastructure: it never crosses an HTTP/SSE boundary, so it
 * does not need to map onto `AppError`. Callers that own a client-facing
 * frontier can translate it into a stable error code when that layer exists.
 */
export class ToolRegistrationError extends Error {
  readonly toolName: string;

  constructor(toolName: string) {
    super(`Tool already registered: "${toolName}"`);
    this.name = "ToolRegistrationError";
    this.toolName = toolName;
  }
}

/**
 * In-memory `ToolRegistry` backed by a `Map`.
 *
 * Registration is mutable but rejects duplicate tool names (fail-fast and
 * deterministic). Definitions are exposed through read-only accessors.
 */
export class MapToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    const name = tool.definition.name;
    if (this.tools.has(name)) {
      throw new ToolRegistrationError(name);
    }
    this.tools.set(name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  listDefinitions(): ToolDefinition[] {
    // Fresh array of references only (definitions are immutable contracts);
    // never return the internal Map or a reusable array.
    return Array.from(this.tools.values()).map((tool) => tool.definition);
  }
}

/**
 * Creates a fresh, empty {@link MapToolRegistry}.
 */
export function createToolRegistry(): ToolRegistry {
  return new MapToolRegistry();
}
