// ── Calculator expression engine ──────────────────────────────────────────────
//
// Deterministic, dependency-free evaluator for the future `calculator` tool.
// This step implements ONLY the lexer, recursive-descent parser and arithmetic.
// It performs no tool registration, no schema work and no HTTP/error-code
// mapping (that belongs to later steps). The expression language is parsed
// explicitly: there is no code-execution path (no eval/new Function/vm/
// child_process/dynamic import).
//
// Arithmetic is IEEE-754 (JavaScript `number`), not arbitrary precision.

/** Maximum length of the input expression string. */
export const MAX_EXPRESSION_LENGTH = 500;
/** Maximum number of tokens the lexer may produce. */
export const MAX_TOKENS = 256;
/** Maximum recursive-descent depth (parentheses / unary signs / exponents). */
export const MAX_PARSE_DEPTH = 64;

/**
 * Error thrown when an expression cannot be evaluated.
 *
 * Pure domain error: it carries a stable `errorType` and a concise, safe
 * message. It intentionally does NOT import AppError / AppErrorCode / HTTP
 * mapping — that translation happens when the evaluator is wired into a tool
 * (later step), keeping this module reusable and self-contained.
 */
export class CalculatorExpressionError extends Error {
  readonly errorType: string;

  static readonly ErrorType = {
    INVALID_EXPRESSION: "invalid_expression",
    UNSUPPORTED_CHARACTER: "unsupported_character",
    EXCEEDS_LENGTH: "exceeds_length",
    TOO_MANY_TOKENS: "too_many_tokens",
    TOO_DEEP: "too_deep",
    DIVISION_BY_ZERO: "division_by_zero",
    NON_FINITE: "non_finite",
  } as const;

  constructor(errorType: string, message: string) {
    super(message);
    this.name = "CalculatorExpressionError";
    this.errorType = errorType;
  }
}

type TokenType =
  | "number"
  | "plus"
  | "minus"
  | "star"
  | "slash"
  | "percent"
  | "caret"
  | "powstar"
  | "lparen"
  | "rparen";

interface Token {
  type: TokenType;
  raw: string;
}

/**
 * Evaluate a mathematical expression and return a JavaScript `number`.
 *
 * Supported grammar (highest precedence first):
 *
 * ```text
 * parentheses
 * exponentiation (^ and **) — right associative
 * unary + / -
 * multiplication / division %
 * addition / subtraction
 * ```
 *
 * Sign follows exponentiation, so `-2^2 === -(2^2) === -4`, while
 * `2^-2 === 0.25` and `2^3^2 === 2^(3^2) === 512`.
 *
 * Throws {@link CalculatorExpressionError} for anything outside the supported
 * grammar or beyond the enforced limits.
 */
export function evaluate(expression: string): number {
  if (typeof expression !== "string") {
    throw new CalculatorExpressionError(
      CalculatorExpressionError.ErrorType.INVALID_EXPRESSION,
      "The expression must be a string.",
    );
  }
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    throw new CalculatorExpressionError(
      CalculatorExpressionError.ErrorType.EXCEEDS_LENGTH,
      "The expression exceeds the maximum allowed length.",
    );
  }

  const tokens = tokenize(expression);
  return new ExpressionParser(tokens).evaluate();
}

// ── Lexer ─────────────────────────────────────────────────────────────────────

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;

  while (i < n) {
    const char = input[i];

    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      i += 1;
      continue;
    }

    switch (char) {
      case "+":
        tokens.push({ type: "plus", raw: char });
        i += 1;
        break;
      case "-":
        tokens.push({ type: "minus", raw: char });
        i += 1;
        break;
      case "/":
        tokens.push({ type: "slash", raw: char });
        i += 1;
        break;
      case "%":
        tokens.push({ type: "percent", raw: char });
        i += 1;
        break;
      case "^":
        tokens.push({ type: "caret", raw: char });
        i += 1;
        break;
      case "(":
        tokens.push({ type: "lparen", raw: char });
        i += 1;
        break;
      case ")":
        tokens.push({ type: "rparen", raw: char });
        i += 1;
        break;
      case "*":
        if (input[i + 1] === "*") {
          tokens.push({ type: "powstar", raw: "**" });
          i += 2;
        } else {
          tokens.push({ type: "star", raw: char });
          i += 1;
        }
        break;
      default:
        if (isDigit(char) || char === ".") {
          const result = readNumber(input, i);
          tokens.push({ type: "number", raw: result.value });
          i = result.next;
        } else {
          throw unsupportedCharacter();
        }
    }
  }

  if (tokens.length > MAX_TOKENS) {
    throw tooManyTokens();
  }

  return tokens;
}

/**
 * Read a single numeric literal starting at `start`.
 *
 * Accepts decimal integers, floats, leading-dot numbers (`.5`) and trailing-dot
 * numbers (`5.`), plus scientific notation (`1e3`, `2.5E-2`). Returns the raw
 * substring so the parser can reject non-finite results in one place.
 */
function readNumber(input: string, start: number): { value: string; next: number } {
  const n = input.length;
  let i = start;

  while (i < n && isDigit(input[i])) {
    i += 1;
  }

  if (i < n && input[i] === ".") {
    i += 1;
    while (i < n && isDigit(input[i])) {
      i += 1;
    }
  }

  if (i < n && (input[i] === "e" || input[i] === "E")) {
    i += 1;
    if (i < n && (input[i] === "+" || input[i] === "-")) {
      i += 1;
    }
    let exponentDigits = 0;
    while (i < n && isDigit(input[i])) {
      exponentDigits += 1;
      i += 1;
    }
    if (exponentDigits === 0) {
      throw invalidExpression("The expression contains a malformed number.");
    }
  }

  const raw = input.slice(start, i);
  if (!/[0-9]/.test(raw)) {
    // A lone "." reached here: treat it as an unsupported token.
    throw unsupportedCharacter();
  }

  return { value: raw, next: i };
}

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

// ── Recursive-descent parser / evaluator ──────────────────────────────────────

class ExpressionParser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  evaluate(): number {
    if (this.tokens.length === 0) {
      throw invalidExpression("The expression is empty.");
    }

    const result = this.parseExpression(0);

    const remaining = this.current();
    if (remaining !== undefined) {
      throw invalidExpression("The expression contains trailing tokens.");
    }

    return normalizeZero(result);
  }

  private current(): Token | undefined {
    return this.pos < this.tokens.length ? this.tokens[this.pos] : undefined;
  }

  private advance(): void {
    this.pos += 1;
  }

  private parseExpression(depth: number): number {
    this.checkDepth(depth);
    return this.parseAdditive(depth);
  }

  private parseAdditive(depth: number): number {
    let value = this.parseMultiplicative(depth);

    while (this.isBinary("plus", "minus")) {
      const token = this.current();
      if (token === undefined) {
        break;
      }
      const op = token.type;
      this.advance();
      const right = this.parseMultiplicative(depth);
      value = op === "plus" ? value + right : value - right;
      this.assertFinite(value);
    }

    return value;
  }

  private parseMultiplicative(depth: number): number {
    let value = this.parseUnary(depth);

    while (this.isBinary("star", "slash", "percent")) {
      const token = this.current();
      if (token === undefined) {
        break;
      }
      const op = token.type;
      this.advance();
      const right = this.parseUnary(depth);

      if (op === "slash" || op === "percent") {
        if (right === 0) {
          throw divisionByZero();
        }
        value = op === "slash" ? value / right : value % right;
      } else {
        value = value * right;
      }
      this.assertFinite(value);
    }

    return value;
  }

  private parseUnary(depth: number): number {
    this.checkDepth(depth);

    const token = this.current();
    if (token?.type === "plus") {
      this.advance();
      return this.parseUnary(depth + 1);
    }
    if (token?.type === "minus") {
      this.advance();
      return -this.parseUnary(depth + 1);
    }

    return this.parsePower(depth);
  }

  private parsePower(depth: number): number {
    const base = this.parsePrimary(depth);

    if (this.current()?.type === "caret" || this.current()?.type === "powstar") {
      this.advance();
      // The exponent is a unary expression, which keeps exponentiation right
      // associative and allows signed exponents (e.g. 2^-2).
      const exponent = this.parseUnary(depth + 1);
      const value = Math.pow(base, exponent);
      this.assertFinite(value);
      return value;
    }

    return base;
  }

  private parsePrimary(depth: number): number {
    this.checkDepth(depth);

    const token = this.current();
    if (token === undefined) {
      throw invalidExpression("The expression ends unexpectedly.");
    }

    if (token.type === "lparen") {
      this.advance();
      const value = this.parseExpression(depth + 1);
      if (this.current()?.type !== "rparen") {
        throw invalidExpression("The expression has unmatched parentheses.");
      }
      this.advance();
      return value;
    }

    if (token.type === "number") {
      this.advance();
      const value = Number(token.raw);
      // A literal such as 1e9999 parses to Infinity; reject it explicitly.
      this.assertFinite(value);
      return value;
    }

    throw invalidExpression("The expression contains an unexpected token.");
  }

  private isBinary(...types: TokenType[]): boolean {
    const token = this.current();
    return token !== undefined && types.includes(token.type);
  }

  private checkDepth(depth: number): void {
    if (depth > MAX_PARSE_DEPTH) {
      throw tooDeep();
    }
  }

  private assertFinite(value: number): void {
    if (!Number.isFinite(value)) {
      throw nonFinite();
    }
  }
}

// ── Errors / helpers ────────────────────────────────────────────────────────────

function invalidExpression(message: string): CalculatorExpressionError {
  return new CalculatorExpressionError(
    CalculatorExpressionError.ErrorType.INVALID_EXPRESSION,
    message,
  );
}

function unsupportedCharacter(): CalculatorExpressionError {
  return new CalculatorExpressionError(
    CalculatorExpressionError.ErrorType.UNSUPPORTED_CHARACTER,
    "The expression contains an unsupported character.",
  );
}

function tooManyTokens(): CalculatorExpressionError {
  return new CalculatorExpressionError(
    CalculatorExpressionError.ErrorType.TOO_MANY_TOKENS,
    "The expression has too many tokens.",
  );
}

function tooDeep(): CalculatorExpressionError {
  return new CalculatorExpressionError(
    CalculatorExpressionError.ErrorType.TOO_DEEP,
    "The expression nesting exceeds the maximum allowed depth.",
  );
}

function divisionByZero(): CalculatorExpressionError {
  return new CalculatorExpressionError(
    CalculatorExpressionError.ErrorType.DIVISION_BY_ZERO,
    "Division by zero is not allowed.",
  );
}

function nonFinite(): CalculatorExpressionError {
  return new CalculatorExpressionError(
    CalculatorExpressionError.ErrorType.NON_FINITE,
    "The expression produced a non-finite result.",
  );
}

function normalizeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}
