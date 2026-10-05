import { z } from "zod";
import { AppError } from "../utils/errorHandler.js";
import {
  CalculatorExpressionError,
  evaluate,
  MAX_EXPRESSION_LENGTH,
} from "./calculatorExpression.js";
import type {
  Tool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./types.js";

// ── Calculator tool ───────────────────────────────────────────────────────────
//
// Adapter that exposes the pure, dependency-free expression engine
// (`calculatorExpression.ts`) as a generic model tool.
//
// This file owns ONLY the tool-shaped concerns: the provider-facing definition,
// the model-argument schema, the safe pre-flight validation and the
// deterministic result formatting. It never touches HTTP/SSE, orchestration or
// error-code mapping beyond the two `AppError` throws below. The grammar
// itself stays the authority of `calculatorExpression.ts`.

/**
 * Provider-facing tool definition.
 *
 * Published to the model as an OpenAI-compatible function tool. The model is
 * steered toward deterministic arithmetic rather than "mental" calculation.
 */
export const calculatorToolDefinition = {
  name: "calculator",
  description:
    "Evaluate a mathematical expression accurately. Use this for arithmetic instead of mental calculation.",
  inputSchema: {
    type: "object",
    properties: {
      expression: {
        type: "string",
        description: "The mathematical expression to evaluate.",
      },
    },
    required: ["expression"],
    additionalProperties: false,
  },
} as const;

/**
 * Strict schema for model-supplied calculator arguments.
 *
 * Mirrors the published tool definition exactly: only `expression` is allowed,
 * so `.strict()` rejects any extra key (matching `additionalProperties: false`).
 * The bound matches the engine's own length guard so validation and evaluation
 * never disagree about an over-long expression.
 */
const calculatorToolArgsSchema = z
  .object({
    expression: z
      .string()
      .trim()
      .min(1, "expression must not be empty")
      .max(MAX_EXPRESSION_LENGTH, `expression must not exceed ${MAX_EXPRESSION_LENGTH} characters`),
  })
  .strict();

/**
 * Pre-flight validation of a model-supplied calculator call.
 *
 * Runs BEFORE any `tool_start` event, exactly like the web-search argument
 * validation. It validates the argument shape and then asks the expression
 * engine to be the authority for grammar validity.
 *
 * A mathematically/gramarically invalid expression is rejected here as a stable,
 * concise `VALIDATION_ERROR` — never as `INTERNAL_ERROR` and never with the raw
 * expression, a stack trace or parser internals in the message.
 *
 * Malformed JSON on the request side is unrelated to this function: it is
 * rejected by the orchestrator before a `Tool` is ever invoked, so it keeps its
 * `TOOL_INVALID_ARGUMENTS` behaviour.
 */
function validateCalculatorArgs(args: unknown): void {
  const parsed = calculatorToolArgsSchema.safeParse(args);

  if (!parsed.success) {
    throw new AppError({
      code: "VALIDATION_ERROR",
      statusCode: 400,
      message: "Invalid calculator arguments.",
    });
  }

  try {
    evaluate(parsed.data.expression);
  } catch (error) {
    if (error instanceof CalculatorExpressionError) {
      throw new AppError({
        code: "VALIDATION_ERROR",
        statusCode: 400,
        message: "Invalid calculator expression.",
      });
    }

    throw error;
  }
}

/**
 * Create the `calculator` tool.
 *
 * Stateless and dependency-free: it needs no configuration and no credentials.
 * The harness-internal per-turn limit (3) keeps calculator inside the same
 * global tool cap the orchestrator already enforces for every tool.
 */
export function createCalculatorTool(): Tool {
  return {
    definition: calculatorToolDefinition,
    // Harness-internal per-turn limit: at most three calculator runs per user
    // turn. This policy is never serialized into the provider-facing definition.
    executionPolicy: { maxExecutionsPerTurn: 3 },
    validate: validateCalculatorArgs,

    async execute(
      args: unknown,
      _context: ToolExecutionContext,
    ): Promise<ToolExecutionResult> {
      // Defence-in-depth for direct callers: the orchestrator also runs
      // `validate()` before `tool_start`, but this keeps the tool correct even
      // when invoked outside the orchestrator. The double evaluation of the
      // engine (once in `validate`, once here) is intentional and cheap.
      const parsed = calculatorToolArgsSchema.parse(args);
      const result = evaluate(parsed.expression);

      // Deterministic, model-facing output only: the validated/trimmed
      // expression and its result. No prose, no stack trace, no parser or AST
      // internals, no token counts.
      return {
        content: `Expression: ${parsed.expression}\nResult: ${result}`,
      };
    },
  };
}
