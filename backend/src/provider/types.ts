import type { ProviderConfig, ChatMessage } from "./schemas.js";
import type { ChatToolOptions } from "./tools.js";

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
  chat(
    config: ProviderConfig,
    messages: ProviderRequestMessage[],
    options?: ChatToolOptions,
  ): Promise<ChatResponse>;

  /**
   * Send a chat completion request and return a stream of text deltas.
   */
  chatStream(
    config: ProviderConfig,
    messages: ProviderRequestMessage[],
    options?: ChatToolOptions & { signal?: AbortSignal },
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

/**
 * A raw OpenAI-style tool call as returned in a chat-completion response
 * message. `function.arguments` is the raw streamed JSON text: it is parsed by
 * a later orchestration step, never here. This is the response (provider →
 * client) shape and is distinct from the streaming-parser
 * {@link AccumulatedToolCall}.
 */
export interface ProviderToolCall {
  id?: string;
  type?: "function";
  function: { name: string; arguments: string };
}

/**
 * Assistant message in a chat-completion response.
 *
 * `content` is nullable: a tool-call response carries `content: null` with a
 * populated `tool_calls`. This is a response-only shape and must not be reused
 * for incoming request messages (which require non-empty string content).
 */
export interface ChatAssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ProviderToolCall[];
}

export interface ChatChoice {
  index: number;
  message: ChatAssistantMessage;
  finish_reason: string | null;
}

/**
 * Internal `tool` request message used by the orchestration layer to return a
 * tool result to the model on the second model round. It mirrors the OpenAI
 * contract (`{ role: "tool", tool_call_id, content }`).
 *
 * This is an internal orchestration-only message: it is never sent by the
 * frontend and must not appear in the visible conversation state.
 */
export interface ProviderToolResultMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

/**
 * Internal `assistant` request message that carries the tool calls the model
 * requested on the first model round. Mirrors the OpenAI contract
 * (`{ role: "assistant", tool_calls: [...] }`).
 *
 * This is an internal orchestration-only message: it is never sent by the
 * frontend and must not appear in the visible conversation state.
 */
export interface ProviderAssistantToolCallMessage {
  role: "assistant";
  tool_calls: ProviderToolCall[];
}

/**
 * The superset of request messages the provider client accepts. It extends the
 * frontend-facing {@link ChatMessage} with the two internal orchestration
 * message shapes above so the orchestrator can build the round-2 request.
 *
 * The frontend HTTP schema ({@link chatMessageSchema}) is intentionally left
 * unchanged: only the frontend sends {@link ChatMessage}, while the
 * orchestrator additionally constructs the internal tool messages.
 */
export type ProviderRequestMessage =
  | ChatMessage
  | ProviderToolResultMessage
  | ProviderAssistantToolCallMessage;

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
 * Returns raw bytes (Uint8Array) from the upstream HTTP response body.
 * A separate SSE parser is responsible for converting bytes → text deltas.
 */
export interface ProviderStream {
  /**
   * Read raw bytes from the upstream response body.
   * The caller is responsible for SSE parsing and text decoding.
   */
  getReader(): ReadableStreamDefaultReader<Uint8Array>;

  /**
   * The base URL of the provider. Useful for error messages.
   */
  readonly baseUrl: string;
}
