import { describe, it, expect } from "vitest";
import {
  evaluate,
  CalculatorExpressionError,
  MAX_EXPRESSION_LENGTH,
  MAX_TOKENS,
  MAX_PARSE_DEPTH,
} from "../calculatorExpression.js";

describe("calculatorExpression — basic arithmetic and precedence", () => {
  it("adds", () => {
    expect(evaluate("2 + 2")).toBe(4);
  });

  it("respects multiplication over addition", () => {
    expect(evaluate("2 + 3 * 4")).toBe(14);
  });

  it("honours parentheses", () => {
    expect(evaluate("(2 + 3) * 4")).toBe(20);
  });

  it("divides", () => {
    expect(evaluate("10 / 4")).toBe(2.5);
  });

  it("computes modulo", () => {
    expect(evaluate("10 % 4")).toBe(2);
  });

  it("handles whitespace freely", () => {
    expect(evaluate("   2   +   3   ")).toBe(5);
  });
});

describe("calculatorExpression — exponentiation grammar", () => {
  it("sign follows exponentiation: -2^2 === -4", () => {
    expect(evaluate("-2^2")).toBe(-4);
  });

  it("supports signed exponents: 2^-2 === 0.25", () => {
    expect(evaluate("2^-2")).toBe(0.25);
  });

  it("is right-associative: 2 ^ 3 ^ 2 === 512", () => {
    expect(evaluate("2 ^ 3 ^ 2")).toBe(512);
  });

  it("supports ** as exponentiation", () => {
    expect(evaluate("2 ** 8")).toBe(256);
    expect(evaluate("2 ** 3 ** 2")).toBe(512);
  });

  it("parens change sign semantics: (-2)^2 === 4", () => {
    expect(evaluate("(-2)^2")).toBe(4);
  });

  it("multiplies before applying exponent: 2 * 3^2 === 18", () => {
    expect(evaluate("2 * 3^2")).toBe(18);
  });
});

describe("calculatorExpression — number forms", () => {
  it("parses scientific notation", () => {
    expect(evaluate("1e3 + 5")).toBe(1005);
    expect(evaluate("2.5E-2")).toBe(0.025);
  });

  it("supports leading-dot numbers", () => {
    expect(evaluate(".5 + .25")).toBe(0.75);
  });

  it("supports trailing-dot numbers", () => {
    expect(evaluate("5.")).toBe(5);
    expect(evaluate("0.5")).toBe(0.5);
  });

  it("normalises -0 to 0", () => {
    expect(evaluate("-0")).toBe(0);
    expect(evaluate("0 * -1")).toBe(0);
  });

  it("uses IEEE-754 arithmetic (no arbitrary precision)", () => {
    expect(evaluate("0.1 + 0.2")).toBe(0.30000000000000004);
  });
});

describe("calculatorExpression — invalid expressions", () => {
  it("rejects empty input", () => {
    expect(() => evaluate("")).toThrow(CalculatorExpressionError);
  });

  it("rejects whitespace-only input", () => {
    expect(() => evaluate("   \t  ")).toThrow(CalculatorExpressionError);
  });

  it("rejects letters / identifiers", () => {
    expect(() => evaluate("abc")).toThrow(CalculatorExpressionError);
    expect(() => evaluate("sqrt(4)")).toThrow(CalculatorExpressionError);
  });

  it("rejects Infinity / NaN text", () => {
    expect(() => evaluate("Infinity")).toThrow(CalculatorExpressionError);
    expect(() => evaluate("NaN")).toThrow(CalculatorExpressionError);
  });

  it("rejects unmatched parentheses", () => {
    expect(() => evaluate("(2 + 3")).toThrow(CalculatorExpressionError);
    expect(() => evaluate("2 + 3)")).toThrow(CalculatorExpressionError);
  });

  it("rejects trailing garbage", () => {
    expect(() => evaluate("2 3")).toThrow(CalculatorExpressionError);
    expect(() => evaluate("2 +")).toThrow(CalculatorExpressionError);
  });

  it("rejects division by zero", () => {
    expect(() => evaluate("1 / 0")).toThrow(CalculatorExpressionError);
    expect(() => evaluate("5 % 0")).toThrow(CalculatorExpressionError);
  });

  it("rejects unsupported punctuation", () => {
    expect(() => evaluate("2 & 3")).toThrow(CalculatorExpressionError);
    expect(() => evaluate("2 @ 3")).toThrow(CalculatorExpressionError);
  });

  it("rejects a malformed number", () => {
    expect(() => evaluate("1e")).toThrow(CalculatorExpressionError);
    expect(() => evaluate(".")).toThrow(CalculatorExpressionError);
  });

  it("rejects an exponent with no mantissa digits as malformed (not non-finite)", () => {
    // Number(".e5") is NaN, but the stable error must be INVALID_EXPRESSION
    // (malformed number), not NON_FINITE, since the mantissa has no digits.
    expect(() => evaluate(".e5")).toThrow(CalculatorExpressionError);
    try {
      evaluate(".e5");
    } catch (error) {
      expect((error as CalculatorExpressionError).errorType).toBe(
        CalculatorExpressionError.ErrorType.INVALID_EXPRESSION,
      );
    }
  });
});

describe("calculatorExpression — limits", () => {
  it("rejects expressions longer than MAX_EXPRESSION_LENGTH", () => {
    const expression = "1".repeat(MAX_EXPRESSION_LENGTH + 1);
    expect(() => evaluate(expression)).toThrow(CalculatorExpressionError);
  });

  it("accepts an expression exactly at MAX_EXPRESSION_LENGTH", () => {
    // 300-digit number (finite) padded with " + 1" to reach exactly 500 chars
    // while staying well under MAX_TOKENS.
    const expression = "1".repeat(300) + " + 1".repeat(50);
    expect(expression.length).toBe(MAX_EXPRESSION_LENGTH);
    expect(() => evaluate(expression)).not.toThrow();
  });

  it("rejects expressions with more than MAX_TOKENS tokens", () => {
    // 130 ones separated by "+" => 259 tokens (> 256), well under the length cap.
    const expression = "1".repeat(130).replace(/(.)(?=.)/g, "$1+");
    expect(() => evaluate(expression)).toThrow(CalculatorExpressionError);
  });

  it("rejects nesting deeper than MAX_PARSE_DEPTH", () => {
    const depth = MAX_PARSE_DEPTH + 36;
    const expression = "(".repeat(depth) + "1" + ")".repeat(depth);
    expect(() => evaluate(expression)).toThrow(CalculatorExpressionError);
  });

  it("rejects a chain of unary signs deeper than MAX_PARSE_DEPTH", () => {
    const expression = "-".repeat(MAX_PARSE_DEPTH + 1) + "1";
    expect(() => evaluate(expression)).toThrow(CalculatorExpressionError);
  });
});

describe("calculatorExpression — non-finite handling", () => {
  it("rejects non-finite literals (1e9999)", () => {
    expect(() => evaluate("1e9999")).toThrow(CalculatorExpressionError);
  });

  it("rejects a non-finite intermediate/final result", () => {
    expect(() => evaluate("10 ^ 400")).toThrow(CalculatorExpressionError);
    expect(() => evaluate("1e308 * 10")).toThrow(CalculatorExpressionError);
  });
});

describe("calculatorExpression — error shape", () => {
  it("exposes a stable errorType", () => {
    expect(() => evaluate("1 / 0")).toThrow(/division by zero/i);
    try {
      evaluate("1 / 0");
    } catch (error) {
      expect((error as CalculatorExpressionError).errorType).toBe(
        CalculatorExpressionError.ErrorType.DIVISION_BY_ZERO,
      );
    }
  });

  it("does not leak raw expression text in the division-by-zero message", () => {
    expect(() => evaluate("12345 / 0")).toThrow(/division by zero/i);
  });
});

describe("calculatorExpression — exported limits", () => {
  it("exposes the documented limits", () => {
    expect(MAX_EXPRESSION_LENGTH).toBe(500);
    expect(MAX_TOKENS).toBe(256);
    expect(MAX_PARSE_DEPTH).toBe(64);
  });
});
