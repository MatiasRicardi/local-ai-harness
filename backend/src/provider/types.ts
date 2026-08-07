import type { ProviderConfig, ChatMessage, ChatMessages } from "./schemas.js";

// ── ProviderClient interface ─────────────────────────────────────────────────

/**
 * Abstract client interface for communicating with OpenAI-compatible providers.
 *
 * The interface is split into two methods:
 *   - chat()          — non-streaming (used for testing)
 *   - chatStream()    — streaming (used for chat responses)
 *
 * Both methods accept the same provider config and messages.
 * Implementations will fill in the streaming response shape.
 */
export interface ProviderClient {
  /**
   * Send a chat completion request and return the full response.
   */
  chat(config: ProviderConfig, messages: ChatMessages): Promise<ChatResponse>;

  /**
   * Send a chat completion request and return a stream of text deltas.
   */
  chatStream(
    config: ProviderConfig,
    messages: ChatMessages,
  ): Promise<ProviderStream>;
}

// ── Response types ───────────────────────────────────────────────────────────

/**
 * Minimal ChatCompletion response shape that matches the OpenAI contract.
 */
export interface ChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatChoice[];
  usage: Usage;
  errorType?: string;
}

export interface ChatChoice {
  index: number;
  message: ChatMessage;
  finish_reason: string | null;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

// ── Error types ──────────────────────────────────────────────────────────────

/**
 * Structured error information returned by the provider client.
 */
export interface ProviderError {
  /**
   * Error type identifier for mapping.
   */
  errorType: string;
  
  /**
   * Human-readable error message.
   */
  message: string;
}

// ── Stream types ─────────────────────────────────────────────────────────────

/**
 * Stream returned by the provider client.
 * Implementations should use ReadableStream or a similar async iterator.
 */
export interface ProviderStream {
  /**
   * Read text chunks from the stream.
   * Each chunk is a string delta (partial text).
   */
  getReader(): ReadableStreamDefaultReader<string>;

  /**
   * The base URL of the provider. Useful for error messages.
   */
  readonly baseUrl: string;
}
