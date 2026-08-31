import { estimateTokens } from "./token-estimate.js";
import { buildDocumentContextMessage, buildDocumentContentMessage } from "../utils/documentContext.js";

/**
 * Metadata about document truncation produced by budget calculation.
 */
export interface ContextTruncationMetadata {
  documentTruncated: boolean;
  originalDocumentCharacters: number;
  includedDocumentCharacters: number;
  estimatedOriginalDocumentTokens: number;
  estimatedIncludedDocumentTokens: number;
}

/**
 * Configuration for context budget calculation.
 */
export interface ContextBudgetConfig {
  /** Maximum context window in tokens (raw, before safety margin). */
  contextSizeTokens: number;
  /** System/application instructions content (may be empty). */
  systemInstructions: string;
  /** Conversation history messages (excluding the current user message). */
  conversationHistory: { role: string; content: string }[];
  /** The current user message content. */
  currentUserMessage: string;
  /** The attached document text (may be truncated). */
  documentText: string | null;
  /** The document filename (used in the document context template). */
  documentFilename: string | null;
  /** Whether a document is attached. */
  hasDocument: boolean;
}

/**
 * Result of context budget calculation.
 */
export interface ContextBudgetResult {
  /** Whether the request is valid (provider may be called). */
  valid: boolean;
  /** Error message if the request is invalid (provider must NOT be called). */
  errorMessage?: string;
  /** The document text to include (possibly truncated). */
  includedDocumentText: string;
  /** Truncation metadata (always present, even when no truncation occurred). */
  truncationMetadata: ContextTruncationMetadata;
}

/**
 * Calculate usable context tokens after applying safety margin.
 */
export function calculateUsableContextTokens(contextSizeTokens: number): number {
  return Math.floor(contextSizeTokens * 0.9);
}

/**
 * Calculate response reserve tokens.
 *
 * Reserve at least 512 tokens or 25% of usable context, capped at 50%.
 */
export function calculateResponseReserveTokens(usableContextTokens: number): number {
  let responseReserveTokens = Math.max(512, Math.floor(usableContextTokens * 0.25));
  responseReserveTokens = Math.min(responseReserveTokens, Math.floor(usableContextTokens * 0.5));
  return responseReserveTokens;
}

/**
 * Calculate input budget tokens (available for all input text).
 */
export function calculateInputBudgetTokens(usableContextTokens: number, responseReserveTokens: number): number {
  return usableContextTokens - responseReserveTokens;
}

/**
 * Estimate the token count for the document context template overhead.
 *
 * This includes:
 * - The fixed text from `buildDocumentContextMessage()` (system policy)
 * - The filename
 * - The `<document>` wrapper prefix/suffix from `buildDocumentContentMessage()`
 *
 * Does NOT include the document body itself.
 */
export function estimateDocumentTemplateOverhead(filename: string): number {
  // Reuse the actual prompt builders with empty document text so the overhead
  // matches exactly what buildAllMessages() sends.
  const emptyDoc = { fileId: "", filename, text: "" };
  const contextMessage = buildDocumentContextMessage(emptyDoc);
  const contentMessage = buildDocumentContentMessage(emptyDoc);
  const totalText = contextMessage.content + contentMessage.content;
  return estimateTokens(totalText);
}

/**
 * Estimate non-document token usage.
 *
 * nonDocumentTokens = system instructions + document template overhead +
 *                     conversation history + current user message
 */
export function estimateNonDocumentTokens(config: ContextBudgetConfig): number {
  let total = 0;

  // System/application instructions
  total += estimateTokens(config.systemInstructions);

  // Document template overhead (if document is attached)
  if (config.hasDocument && config.documentFilename) {
    total += estimateDocumentTemplateOverhead(config.documentFilename);
  }

  // Conversation history
  for (const msg of config.conversationHistory) {
    total += estimateTokens(msg.content);
  }

  // Current user message
  total += estimateTokens(config.currentUserMessage);

  return total;
}

/**
 * Truncate document text to fit within a character budget.
 *
 * Preserves the beginning of the document, prefers safe text boundaries,
 * and appends a truncation marker.
 *
 * @param text - The full document text.
 * @param maxCharacters - Maximum characters allowed (including the marker).
 * @returns The truncated text with the marker appended, or the original text
 *          if it fits within the budget.
 */
export function truncateDocumentToBudget(text: string, maxCharacters: number): string {
  const truncationMarker = "[Document truncated due to context limit.]";

  // If the text fits entirely (including room for marker), return as-is
  if (text.length <= maxCharacters) {
    return text;
  }

  // Reserve space for the marker
  const availableCharacters = maxCharacters - truncationMarker.length;

  if (availableCharacters <= 0) {
    // No room at all — return only the marker
    return truncationMarker;
  }

  // Take the prefix
  let prefix = text.slice(0, availableCharacters);

  // Unicode safety: avoid leaving an isolated surrogate
  // Check if the last code unit is a high surrogate (D800-DBFF)
  const lastChar = prefix.charCodeAt(prefix.length - 1);
  if (lastChar >= 0xd800 && lastChar <= 0xdbff) {
    // High surrogate at the end — adjust back by one code unit
    prefix = prefix.slice(0, -1);
  }

  // Prefer safe text boundaries by scanning backwards up to 500 characters
  const searchWindow = 500;
  const searchStart = Math.max(0, prefix.length - searchWindow);
  const searchSuffix = prefix.slice(searchStart);

  // Try boundaries in order of preference:
  // 1. Paragraph break ("\n\n")
  // 2. Newline ("\n")
  // 3. Space (" ")

  let breakIndex = -1;

  // Search for paragraph break (prefer longest match)
  // We want to break BEFORE the paragraph break, so slice up to the first newline
  const paragraphBreak = searchSuffix.lastIndexOf("\n\n");
  if (paragraphBreak !== -1) {
    breakIndex = searchStart + paragraphBreak;
  }

  // If no paragraph break, search for single newline
  if (breakIndex === -1) {
    // We want to break BEFORE the newline
    const newlineBreak = searchSuffix.lastIndexOf("\n");
    if (newlineBreak !== -1) {
      breakIndex = searchStart + newlineBreak;
    }
  }

  // If no newline, search for space
  if (breakIndex === -1) {
    // We want to break BEFORE the space
    const spaceBreak = searchSuffix.lastIndexOf(" ");
    if (spaceBreak !== -1) {
      breakIndex = searchStart + spaceBreak;
    }
  }

  // Apply the break if found (must be > 0 to avoid dropping all content)
  if (breakIndex > 0 && breakIndex < prefix.length) {
    prefix = prefix.slice(0, breakIndex);
  }

  return prefix + truncationMarker;
}

/**
 * Calculate the context budget and determine if/how the document should be truncated.
 *
 * This is the main entry point for context budgeting.
 *
 * @param config - The budget configuration.
 * @returns The budget result indicating validity, included text, and metadata.
 */
export function calculateContextBudget(config: ContextBudgetConfig): ContextBudgetResult {
  const contextSizeTokens = config.contextSizeTokens;
  const usableContextTokens = calculateUsableContextTokens(contextSizeTokens);
  const responseReserveTokens = calculateResponseReserveTokens(usableContextTokens);
  const inputBudgetTokens = calculateInputBudgetTokens(usableContextTokens, responseReserveTokens);

  // Estimate non-document usage
  const nonDocumentTokens = estimateNonDocumentTokens(config);

  // Calculate available document budget
  const availableDocumentTokens = inputBudgetTokens - nonDocumentTokens;

  // Calculate character budget for the document
  const documentText = config.documentText ?? "";
  const originalDocumentCharacters = documentText.length;
  const estimatedOriginalDocumentTokens = estimateTokens(documentText);

  // Case 1: Conversation-only overflow (no document)
  if (nonDocumentTokens > inputBudgetTokens && !config.hasDocument) {
    return {
      valid: false,
      errorMessage:
        "The current conversation is too large for the configured context size. Start a new conversation or increase the configured context size.",
      includedDocumentText: "",
      truncationMetadata: {
        documentTruncated: false,
        originalDocumentCharacters: 0,
        includedDocumentCharacters: 0,
        estimatedOriginalDocumentTokens: 0,
        estimatedIncludedDocumentTokens: 0,
      },
    };
  }

  // Case 2: No room for document
  if (config.hasDocument && availableDocumentTokens <= 0) {
    return {
      valid: false,
      errorMessage:
        "The current conversation is too large to include the attached document. Start a new conversation or increase the configured context size.",
      includedDocumentText: "",
      truncationMetadata: {
        documentTruncated: false,
        originalDocumentCharacters: originalDocumentCharacters,
        includedDocumentCharacters: 0,
        estimatedOriginalDocumentTokens: estimatedOriginalDocumentTokens,
        estimatedIncludedDocumentTokens: 0,
      },
    };
  }

  // Case 3: Full document fits
  if (estimatedOriginalDocumentTokens <= availableDocumentTokens) {
    return {
      valid: true,
      includedDocumentText: documentText,
      truncationMetadata: {
        documentTruncated: false,
        originalDocumentCharacters: originalDocumentCharacters,
        includedDocumentCharacters: originalDocumentCharacters,
        estimatedOriginalDocumentTokens: estimatedOriginalDocumentTokens,
        estimatedIncludedDocumentTokens: estimatedOriginalDocumentTokens,
      },
    };
  }

  // Case 4: Document needs truncation
  const maxDocumentCharacters = Math.floor(availableDocumentTokens * 4);
  const truncatedText = truncateDocumentToBudget(documentText, maxDocumentCharacters);
  const includedDocumentCharacters = truncatedText.length;
  const estimatedIncludedDocumentTokens = estimateTokens(truncatedText);

  return {
    valid: true,
    includedDocumentText: truncatedText,
    truncationMetadata: {
      documentTruncated: true,
      originalDocumentCharacters: originalDocumentCharacters,
      includedDocumentCharacters: includedDocumentCharacters,
      estimatedOriginalDocumentTokens: estimatedOriginalDocumentTokens,
      estimatedIncludedDocumentTokens: estimatedIncludedDocumentTokens,
    },
  };
}
