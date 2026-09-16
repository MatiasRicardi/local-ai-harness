import type { AccumulatedToolCall } from "../provider/sseParser.js";
import type { Tool, ToolRegistry } from "../tools/types.js";
import { AppError } from "../utils/errorHandler.js";

/**
 * A single, validated tool call resolved against the registry, ready to be
 * executed. `id` is guaranteed to be a non-empty string by {@link validateToolCalls}.
 */
export interface ResolvedToolCall {
  tool: Tool;
  call: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  };
}

/**
 * Validate a fully-accumulated `tool_calls` event against the Phase-2 limits
 * and resolve the single executable call through the registry.
 *
 * Phase-2 hard limits:
 *   - exactly one tool call per user turn (parallel calls unsupported);
 *   - only `type: "function"` tool calls are supported.
 *
 * Throws a stable {@link AppError} on any violation so the orchestrator can map
 * it straight to the SSE/error boundary:
 *   - zero calls / missing id / unsupported type → `TOOL_INVALID_ARGUMENTS`
 *   - more than one call → `TOOL_CALL_LIMIT_EXCEEDED`
 *   - unknown tool name → `TOOL_NOT_FOUND`
 */
export function validateToolCalls(
  toolCalls: AccumulatedToolCall[],
  registry: ToolRegistry | undefined,
): ResolvedToolCall {
  if (!registry) {
    // Should not happen: the orchestrator only enters the tool path when a
    // registry with definitions is supplied, but fail closed regardless.
    throw new AppError({
      code: "TOOL_NOT_FOUND",
      statusCode: 502,
      message: "The model requested a tool that this instance does not support. Retry without requesting tools.",
    });
  }

  if (toolCalls.length === 0) {
    // The model reported a tool-call completion but produced no valid call.
    throw new AppError({
      code: "TOOL_INVALID_ARGUMENTS",
      statusCode: 502,
      message: "The model returned a malformed tool call. Retry without requesting tools.",
    });
  }

  if (toolCalls.length > 1) {
    // Reject predictably; do not execute any of them.
    throw new AppError({
      code: "TOOL_CALL_LIMIT_EXCEEDED",
      statusCode: 502,
      message: "The model tried to use tools more than once. Retry without requesting tools.",
    });
  }

  const call = toolCalls[0];

  if (call.type !== "function") {
    throw new AppError({
      code: "TOOL_INVALID_ARGUMENTS",
      statusCode: 502,
      message: "The model returned a malformed tool call. Retry without requesting tools.",
    });
  }

  if (!call.id || call.id.trim().length === 0) {
    throw new AppError({
      code: "TOOL_INVALID_ARGUMENTS",
      statusCode: 502,
      message: "The model returned a malformed tool call. Retry without requesting tools.",
    });
  }

  const tool = registry.get(call.function.name);
  if (!tool) {
    throw new AppError({
      code: "TOOL_NOT_FOUND",
      statusCode: 502,
      message: "The model requested a tool that this instance does not support. Retry without requesting tools.",
    });
  }

  return {
    tool,
    call: {
      id: call.id,
      type: "function",
      function: {
        name: call.function.name,
        arguments: call.function.arguments,
      },
    },
  };
}
