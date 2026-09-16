import {
  calculateInputBudgetTokens,
  calculateResponseReserveTokens,
  calculateUsableContextTokens,
} from "./context-budget.js";

// Characters-per-token approximation. Kept in sync with
// `context/token-estimate.ts` (estimateTokens = ceil(length / 4)) so the
// character allowance derived from a token budget matches how the tool-result
// text is actually tokenised downstream.
const CHARACTERS_PER_TOKEN = 4;

/**
 * Result of budgeting web/tool-search result content against the input budget.
 */
export interface ToolResultBudgetResult {
  /**
   * Number of tool-result characters that fit after the rest of the request.
   * `0` means the web content did not fit at all and must be dropped.
   */
  includedWebCharacters: number;
  /** The original tool-result character count, before budgeting. */
  originalWebCharacters: number;
  /** `true` when the tool-result content had to be shrinked to fit. */
  truncated: boolean;
}

/**
 * Budget optional web/tool-search result content for the second model round.
 *
 * The rest of the request (conversation, document context and the two internal
 * orchestration messages — the assistant tool-call message and the tool-result
 * message structure) is treated as fixed and is never shrinked. Only the web
 * result content is shrinked to fit, and only after the current user message
 * and everything above it in priority is already accounted for.
 *
 * @param maxTokens          configured model context window for this request.
 * @param messageTokens      estimated tokens of the entire round-2 request
 *                           **except** the web-result body (which is what is
 *                           being budgeted here). Must already include the
 *                           overhead of the internal assistant tool-call and
 *                           tool-result messages plus the response reserve is
 *                           applied separately below.
 * @param webResultCharacters character count of the raw tool-result content.
 */
export function calculateToolResultBudget({
  maxTokens,
  messageTokens,
  webResultCharacters,
}: {
  maxTokens: number;
  messageTokens: number;
  webResultCharacters: number;
}): ToolResultBudgetResult {
  const usableContextTokens = calculateUsableContextTokens(maxTokens);
  const responseReserveTokens = calculateResponseReserveTokens(usableContextTokens);
  const inputBudgetTokens = calculateInputBudgetTokens(usableContextTokens, responseReserveTokens);

  // Whatever is left of the input budget after the fixed content. Never negative:
  // if the fixed content already exhausts the budget, the web content is simply
  // dropped (0 characters) instead of displacing anything more important.
  const availableForWebTokens = Math.max(inputBudgetTokens - messageTokens, 0);
  const maxWebCharacters = Math.min(webResultCharacters, availableForWebTokens * CHARACTERS_PER_TOKEN);

  return {
    includedWebCharacters: maxWebCharacters,
    originalWebCharacters: webResultCharacters,
    truncated: maxWebCharacters < webResultCharacters,
  };
}

/**
 * Truncate an arbitrary (untrusted) tool-result string while preserving its
 * structural layout:
 *
 * - the leading header block (everything before the first blank line) is always
 *   kept intact — for web search this is the untrusted-content marker;
 * - subsequent sections (separated by blank lines) are kept whole and dropped
 *   only at a section boundary, never cut mid-section;
 * - truncation is deterministic and never produces malformed content.
 *
 * Generic on purpose: it operates on a plain string so the orchestration layer
 * can shrink any tool result without knowing anything provider-specific.
 */
export function truncateContentPreservingStructure(text: string, maxCharacters: number): string {
  if (maxCharacters <= 0) {
    return "";
  }
  if (text.length <= maxCharacters) {
    return text;
  }

  const segments = text.split("\n\n");

  // Always keep the leading header block. If it alone exceeds the cap, truncate
  // it rather than dropping the policy marker entirely.
  if (segments[0].length <= maxCharacters) {
    const kept: string[] = [segments[0]];
    let length = segments[0].length;

    for (let i = 1; i < segments.length; i++) {
      const projected = length + "\n\n".length + segments[i].length;
      if (projected <= maxCharacters) {
        kept.push(segments[i]);
        length = projected;
      } else {
        break;
      }
    }

    return kept.join("\n\n");
  }

  return segments[0].slice(0, maxCharacters);
}
