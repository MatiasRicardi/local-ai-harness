/**
 * Estimate token count from text length.
 *
 * Uses a simple, model-agnostic approximation:
 * approximately 4 characters per token.
 *
 * This is intentionally approximate and not a substitute for
 * a real tokenizer. Do not label these values as exact counts.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
