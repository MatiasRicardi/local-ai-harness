import { describe, it, expect } from "vitest";
import { AppError } from "../../utils/errorHandler.js";
import {
  calculatorToolDefinition,
  createCalculatorTool,
} from "../calculatorTool.js";

describe("calculator tool — definition", () => {
  it("exposes name, description and a strict expression-only schema", () => {
    expect(calculatorToolDefinition.name).toBe("calculator");
    expect(typeof calculatorToolDefinition.description).toBe("string");
    expect(calculatorToolDefinition.inputSchema).toEqual({
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "The mathematical expression to evaluate.",
        },
      },
      required: ["expression"],
      additionalProperties: false,
    });
  });
});

describe("calculator tool — execution policy", () => {
  it("caps calculator at 3 executions per turn", () => {
    expect(createCalculatorTool().executionPolicy?.maxExecutionsPerTurn).toBe(3);
  });
});

describe("calculator tool — valid expression", () => {
  it("returns a deterministic, concise result (operator precedence)", async () => {
    const tool = createCalculatorTool();
    const result = await tool.execute({ expression: "2 + 3 * 4" }, {});

    // 2 + (3 * 4) === 14, not (2 + 3) * 4 === 20.
    expect(result.content).toBe("Expression: 2 + 3 * 4\nResult: 14");
  });

  it("uses the trimmed expression in the output", async () => {
    const tool = createCalculatorTool();
    const result = await tool.execute({ expression: "  6 * 7  " }, {});

    expect(result.content).toBe("Expression: 6 * 7\nResult: 42");
  });

  it("returns no metadata", async () => {
    const tool = createCalculatorTool();
    const result = await tool.execute({ expression: "1 + 1" }, {});

    expect(result.metadata).toBeUndefined();
  });
});

describe("calculator tool — invalid expression is rejected before tool_start", () => {
  it("rejects a grammatically invalid expression", () => {
    const tool = createCalculatorTool();

    expect(() => tool.validate!({ expression: "2 +" })).toThrow(AppError);
  });

  it("rejects division by zero", () => {
    const tool = createCalculatorTool();

    expect(() => tool.validate!({ expression: "1 / 0" })).toThrow(AppError);
  });

  it("maps the rejection to a stable VALIDATION_ERROR without raw expression", () => {
    const tool = createCalculatorTool();

    expect(() => tool.validate!({ expression: "2 +" })).toThrow(
      /Invalid calculator expression\./,
    );

    expect(() => {
      try {
        tool.validate!({ expression: "2 +" });
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        const appError = error as AppError;
        expect(appError.code).toBe("VALIDATION_ERROR");
        expect(appError.statusCode).toBe(400);
        // No raw expression, no stack trace, no parser internals.
        expect(appError.userMessage).not.toContain("2 +");
        expect(appError.userMessage).not.toContain("at ");
      }
    });
  });

  it("rejects an empty string argument", () => {
    const tool = createCalculatorTool();

    expect(() => tool.validate!({ expression: "   " })).toThrow(AppError);
  });
});

describe("calculator tool — extra argument is rejected", () => {
  it("rejects unknown keys (additionalProperties: false)", () => {
    const tool = createCalculatorTool();

    expect(() =>
      tool.validate!({ expression: "2 + 2", foo: "bar" }),
    ).toThrow(AppError);
  });

  it("maps the rejection to VALIDATION_ERROR with a stable message", () => {
    const tool = createCalculatorTool();

    expect(() => tool.validate!({ expression: "2 + 2", foo: "bar" })).toThrow(
      /Invalid calculator arguments\./,
    );
  });
});
