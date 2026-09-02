import type { ProviderClient, ChatResponse, ProviderStream, ProviderError } from "./types.js";
import { type ProviderConfig, type ChatMessages, type ChatMessage } from "./schemas.js";

export class ProviderClientError extends Error {
  readonly errorType: string;

  constructor(errorType: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderClientError";
    this.errorType = errorType;
  }
}

/**
 * Combine two AbortSignals so that aborting either one aborts the combined signal.
 * Falls back to a simple implementation when AbortSignal.any() is unavailable.
 */
function combineSignals(...signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(signals);
  }

  // Fallback: create a new AbortController that aborts if any input signal aborts
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

/**
 * Normalizes a base URL by ensuring it ends with /v1 and stripping trailing slashes.
 * Preserves any custom path prefix after /v1.
 *
 * Examples:
 *   "http://localhost:8080/v1"             → "http://localhost:8080/v1"
 *   "http://localhost:8080/v1/"            → "http://localhost:8080/v1"
 *   "http://localhost:8080/v1/chat"        → "http://localhost:8080/v1/chat"
 *   "http://localhost:8080/v1/chat/"       → "http://localhost:8080/v1/chat"
 *   "https://api.example.com/openai/v1"    → "https://api.example.com/openai/v1"
 */
export function normalizeBaseUrl(baseUrl: string): string {
  let url = baseUrl.trim();

  // Strip trailing slash before normalizing
  if (url.endsWith("/")) {
    url = url.slice(0, -1);
  }

  // Ensure the URL has a trailing /v1 if it doesn't have a custom path
  const parsed = new URL(url);
  const pathSegments = parsed.pathname.split("/").filter(Boolean);

  // Only normalize to /v1 if there is no path or the path is exactly /v1.
  // Preserve custom paths like /v1/chat, /openai/v1, etc.
  if (pathSegments.length === 0 || pathSegments.length === 1 && pathSegments[0] === "v1") {
    parsed.pathname = "/v1";
  }

  return parsed.toString();
}

/**
 * OpenAI-compatible client implementation.
 *
 * Sends requests to the configured provider URL using native fetch.
 * Supports both non-streaming and streaming chat completions.
 */
export class OpenAICompatibleClient implements ProviderClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  /**
   * Error type identifiers for structured error mapping.
   */
  static readonly ErrorType = {
    TIMEOUT: "timeout",
    HTTP_ERROR: "http_error",
    MALFORMED_RESPONSE: "malformed_response",
    NETWORK_ERROR: "network_error",
    USER_ABORT: "user_abort",
    UNKNOWN: "unknown",
  };

  /**
   * Get error information from a caught error.
   * Uses structured error type detection instead of fragile string matching.
   */
  getErrorInfo(error: unknown): ProviderError {
    // User-initiated abort (AbortController.abort()) — not a provider error.
    if (error instanceof DOMException && error.name === "AbortError") {
      return {
        errorType: OpenAICompatibleClient.ErrorType.USER_ABORT,
        message: "Request was cancelled",
      };
    }

    // Provider timeout (AbortSignal.timeout() throws DOMException with name "TimeoutError")
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return {
        errorType: OpenAICompatibleClient.ErrorType.TIMEOUT,
        message: "Provider request timed out",
      };
    }

    // Check for network errors (DOMException with name "NetworkError")
    if (error instanceof DOMException && error.name === "NetworkError") {
      return {
        errorType: OpenAICompatibleClient.ErrorType.NETWORK_ERROR,
        message: "Provider connection failed",
      };
    }

    // Node fetch commonly throws TypeError (for example: "fetch failed").
    if (
      error instanceof TypeError &&
      /fetch failed|failed to fetch|network/i.test(error.message)
    ) {
      return {
        errorType: OpenAICompatibleClient.ErrorType.NETWORK_ERROR,
        message: "Provider connection failed",
      };
    }

    if (error instanceof SyntaxError) {
      return {
        errorType: OpenAICompatibleClient.ErrorType.MALFORMED_RESPONSE,
        message: "Provider returned invalid JSON",
      };
    }

    if (error instanceof Error) {
      // Check the cause chain for HTTP status errors (from the client wrapper)
      const cause = error.cause;

      if (
        cause instanceof TypeError &&
        /fetch failed|failed to fetch|network/i.test(cause.message)
      ) {
        return {
          errorType: OpenAICompatibleClient.ErrorType.NETWORK_ERROR,
          message: "Provider connection failed",
        };
      }

      // Check for timeout errors in the cause chain
      if (
        cause instanceof DOMException &&
        cause.name === "TimeoutError"
      ) {
        return {
          errorType: OpenAICompatibleClient.ErrorType.TIMEOUT,
          message: "Provider request timed out",
        };
      }

      // Preserve user-initiated abort classification when the AbortError is
      // wrapped (for example by ProviderClientError) so it is not lost.
      if (cause instanceof DOMException && cause.name === "AbortError") {
        return {
          errorType: OpenAICompatibleClient.ErrorType.USER_ABORT,
          message: "Request was cancelled",
        };
      }

      if (
        cause instanceof Error &&
        cause.message.startsWith("Provider returned HTTP")
      ) {
        const status = cause.message.match(/HTTP (\d+)/)?.[1];
        const statusNum = status ? parseInt(status, 10) : 0;

        if (statusNum > 0) {
          return {
            errorType: OpenAICompatibleClient.ErrorType.HTTP_ERROR,
            message: `Provider returned HTTP ${statusNum}`,
          };
        }

        return {
          errorType: OpenAICompatibleClient.ErrorType.HTTP_ERROR,
          message: cause.message,
        };
      }

      // Check for malformed response errors (from the client wrapper)
      if (
        cause instanceof Error &&
        (cause.message.includes("no choices") ||
          cause.message.includes("empty response") ||
          cause.message.includes("empty choices") ||
          cause.message.includes("did not return a text stream") ||
          cause.message.includes("did not return a response body"))
      ) {
        return {
          errorType: OpenAICompatibleClient.ErrorType.MALFORMED_RESPONSE,
          message: cause.message,
        };
      }

      // Generic error
      return {
        errorType: OpenAICompatibleClient.ErrorType.UNKNOWN,
        message: error.message,
      };
    }

    return {
      errorType: OpenAICompatibleClient.ErrorType.UNKNOWN,
      message: "Unknown error",
    };
  }

  /**
   * Send a non-streaming chat completion request.
   */
  async chat(
    config: ProviderConfig,
    messages: ChatMessages,
  ): Promise<ChatResponse> {
    const url = `${this.baseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (config.apiKey) {
      headers["Authorization"] = `Bearer ${config.apiKey}`;
    }

    const body = JSON.stringify({
      model: config.model,
      messages,
    });

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(config.timeoutMs),
      });

      if (!response.ok) {
        throw new Error(
          `Provider returned HTTP ${response.status}: ${response.statusText}`,
        );
      }

      const json = await response.json() as {
        id?: string;
        object?: string;
        created?: number;
        model?: string;
        choices: {
          index?: number;
          message: ChatMessage;
          finish_reason?: string | null;
        }[];
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        };
      };

      // Basic validation of the response structure
      if (!json.choices || json.choices.length === 0) {
        throw new Error("Provider returned no choices in the response");
      }

      const choice = json.choices[0];
      const message = choice.message;

      return {
        id: json.id || "",
        object: json.object || "chat.completion",
        created: json.created || Date.now(),
        model: json.model || config.model,
        choices: [
          {
            index: choice.index || 0,
            message,
            finish_reason: choice.finish_reason || null,
          },
        ],
        usage: {
          prompt_tokens: json.usage?.prompt_tokens || 0,
          completion_tokens: json.usage?.completion_tokens || 0,
          total_tokens: json.usage?.total_tokens || 0,
        },
      };
    } catch (error) {
      const errorInfo = this.getErrorInfo(error);
      throw new ProviderClientError(errorInfo.errorType, errorInfo.message, {
        cause: error,
      });
    }
  }

  /**
   * Send a streaming chat completion request.
   * Returns a ProviderStream that can be read for text deltas.
   */
  async chatStream(
    config: ProviderConfig,
    messages: ChatMessages,
    options?: { signal?: AbortSignal },
  ): Promise<ProviderStream> {
    const capturedBaseUrl = this.baseUrl;

    try {
      const url = `${capturedBaseUrl}/chat/completions`;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      };

      if (config.apiKey) {
        headers["Authorization"] = `Bearer ${config.apiKey}`;
      }

      const body = JSON.stringify({
        model: config.model,
        messages,
        stream: true,
      });

      const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
      const combinedSignal = options?.signal
        ? combineSignals(options.signal, timeoutSignal)
        : timeoutSignal;

      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: combinedSignal,
      });

      if (!response.ok) {
        throw new Error(
          `Provider returned HTTP ${response.status}: ${response.statusText}`,
        );
      }

      // Validate that the response is a text stream
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text/") && !contentType.includes("application/json")) {
        throw new Error("Provider did not return a text stream");
      }

      const stream = response.body;

      if (!stream) {
        throw new Error("Provider did not return a response body");
      }

      return {
        getReader() {
          return stream.getReader();
        },
        baseUrl: capturedBaseUrl,
      };
    } catch (error) {
      const errorInfo = this.getErrorInfo(error);
      throw new ProviderClientError(errorInfo.errorType, errorInfo.message, {
        cause: error,
      });
    }
  }
}


