import type { FastifyPluginAsync } from "fastify";
import { OpenAICompatibleClient } from "../provider/client.js";
import { chatRequestSchema, type ChatMessage, type WebSearchConfig } from "../provider/schemas.js";
import {
  normalizeError,
  logNormalizedError,
  AppError,
} from "../utils/errorHandler.js";
import { SseParser } from "../provider/sseParser.js";
import {
  buildDocumentContextMessage,
  buildDocumentContentMessage,
} from "../utils/documentContext.js";
import {
  calculateContextBudget,
  type ContextTruncationMetadata,
} from "../context/context-budget.js";
import { config } from "../config/env.js";
import { ChatOrchestrator } from "../orchestration/chatOrchestrator.js";
import { TavilySearchProvider } from "../search/tavily.js";
import { createWebSearchTool } from "../tools/webSearchTool.js";
import { createToolRegistry } from "../tools/registry.js";
import type { ToolRegistry } from "../tools/types.js";
import { buildWebSearchGuidanceMessage } from "../utils/webSearchPrompt.js";

/**
 * Sanitize untrusted SSE data from providers.
 * Removes null characters which could cause issues in downstream processing.
 * No HTML escaping needed — SSE wire format does not require it,
 * and Vue renders content via {{ }} interpolation which escapes HTML automatically.
 */
function sanitizeSseData(text: string): string {
  return text.replace(/\u0000/g, "")
}

/**
 * Build the message list with document context if present.
 *
 * The document text passed here should already be truncated (if needed)
 * by the context budget calculation.
 */
function buildAllMessages(
  document: { fileId: string; filename: string; text: string } | undefined,
  messages: ChatMessage[],
): ChatMessage[] {
  if (!document) {
    return messages;
  }
  return [
    buildDocumentContextMessage(document),
    buildDocumentContentMessage(document),
    ...messages,
  ];
}

/**
 * Backend-authoritative defaults for the application/user-controlled web search
 * knobs. The model cannot change these (they are not part of the tool input
 * schema); they are only the fallbacks used when the request omits them.
 */
const WEB_SEARCH_DEFAULT_MAX_RESULTS = 5;
const WEB_SEARCH_DEFAULT_SEARCH_DEPTH = "basic" as const;

/**
 * Build the request-scoped web search tool registry for a chat request.
 *
 * Returns `undefined` when web search is not enabled so the caller keeps the
 * plain v1.0.0 path. When enabled, the Tavily base URL comes from backend
 * configuration (`config.TAVILY_BASE_URL`) and the API key is injected
 * request-scoped: neither is ever persisted, logged, or echoed back through
 * SSE, tool content, sources, or error details.
 */
function buildWebSearchRegistry(webSearch: WebSearchConfig | undefined): ToolRegistry | undefined {
  if (!webSearch?.enabled) {
    return undefined;
  }

  const provider = new TavilySearchProvider({
    baseUrl: config.TAVILY_BASE_URL,
    apiKey: webSearch.apiKey as string,
  });

  const tool = createWebSearchTool(
    {
      maxResults: webSearch.maxResults ?? WEB_SEARCH_DEFAULT_MAX_RESULTS,
      searchDepth: webSearch.searchDepth ?? WEB_SEARCH_DEFAULT_SEARCH_DEPTH,
    },
    provider,
  );

  const registry = createToolRegistry();
  registry.register(tool);
  return registry;
}

/**
 * Chat route handler.
 *
 * Forwards messages through ProviderClient and returns a normalized
 * assistant response. Provider HTTP behavior and errors remain inside the client.
 */
const chat: FastifyPluginAsync = async (server) => {
  server.post("/api/chat", async (request, reply) => {
    // Validate request payload using Zod schema
    const result = chatRequestSchema.safeParse(request.body);
    if (!result.success) {
      throw normalizeError(result.error);
    }

    const { provider, messages, document, context } = result.data;
    const client = new OpenAICompatibleClient(provider.baseUrl);

    // Determine context size (default 32768 if not provided)
    const contextSizeTokens = context?.maxTokens ?? 32768;

    // Calculate context budget before contacting provider
    const budgetResult = calculateContextBudget({
      contextSizeTokens,
      systemInstructions: "",
      conversationHistory: messages.slice(0, -1),
      currentUserMessage: messages[messages.length - 1].content,
      documentText: document?.text ?? null,
      documentFilename: document?.filename ?? null,
      hasDocument: !!document,
    });

    // If budget calculation says the request is invalid, reject before provider contact
    if (!budgetResult.valid) {
      const code = budgetResult.errorMessage?.includes("attached document")
        ? "DOCUMENT_CONTEXT_TOO_LARGE"
        : "CONTEXT_TOO_LARGE";
      const message = budgetResult.errorMessage ?? (
        code === "DOCUMENT_CONTEXT_TOO_LARGE"
          ? "The current conversation is too large to include the attached document. Start a new conversation or increase the configured context size."
          : "The current conversation is too large for the configured context size. Start a new conversation or increase the configured context size."
      );
      throw new AppError({
        code,
        statusCode: 400,
        message,
      });
    }

    // Build the full message list with (possibly truncated) document context
    const documentForMessages = document
      ? { ...document, text: budgetResult.includedDocumentText }
      : undefined;
    const allMessages = buildAllMessages(documentForMessages, messages);

    // Web search is only supported on the streaming endpoint. Reject an
    // explicitly enabled request here rather than silently ignoring it, so the
    // non-streaming endpoint keeps its documented v1.0.0 behavior.
    if (result.data.webSearch?.enabled === true) {
      throw new AppError({
        code: "VALIDATION_ERROR",
        statusCode: 400,
        message: "Web search is only available on the streaming chat endpoint.",
      });
    }

    try {
      // Forward messages through ProviderClient
      const response = await client.chat(
        {
          baseUrl: provider.baseUrl,
          model: provider.model,
          apiKey: provider.apiKey,
          timeoutMs: provider.timeoutMs,
        },
        allMessages,
      );

      // Extract the assistant message from the response
      const assistantMessage = response.choices[0]?.message;

      if (!assistantMessage?.content) {
        throw new AppError({
          code: "INVALID_PROVIDER_RESPONSE",
          statusCode: 502,
          message: "The provider returned an invalid response.",
        });
      }

      // Return a normalized success response
      return reply.send({
        success: true,
        message: {
          role: "assistant",
          content: assistantMessage.content,
        },
        model: response.model || provider.model,
        finishReason: response.choices[0]?.finish_reason || null,
      });
    } catch (error) {
      // User/request cancellation stays silent — do not classify as timeout/error
      if (error instanceof Error && error.cause) {
        const errorInfo = client.getErrorInfo(error);
        if (errorInfo.errorType === OpenAICompatibleClient.ErrorType.USER_ABORT) {
          return reply.code(499).send({});
        }
      }
      throw error;
    }
  });

  /**
   * Streaming chat endpoint.
   *
   * Forwards messages through ProviderClient and streams the response
   * to the frontend as Server-Sent Events (SSE).
   *
   * Uses @fastify/sse for proper backpressure handling, lifecycle
   * integration, and wire-format correctness.
   *
   * Protocol:
   *   event: start
   *   data: {"model":"llama3"}
   *
   *   event: delta
   *   data: {"text":"Hello"}
   *
   *   event: done
   *   data: {}
   *
   *   event: error
   *   data: {"message":"Provider connection failed"}
   *
   * When web search runs a tool call, the tool lifecycle is exposed as
   * structured events between `start` and the final answer (no search path
   * emits them):
   *   event: tool_start
   *   data: {"name":"web_search"} | {"name":"web_search","query":"..."}
   *
   *   event: tool_end
   *   data: {"name":"web_search","resultCount":5}
   *
   *   event: sources
   *   data: {"sources":[{"id":1,"title":"...","url":"..."}]}
   */
  server.post("/api/chat/stream", { sse: "manual" }, async (request, reply) => {
    // Validate request payload using Zod schema
    const result = chatRequestSchema.safeParse(request.body);
    if (!result.success) {
      throw normalizeError(result.error);
    }

    const { provider, messages, document, context } = result.data;
    const client = new OpenAICompatibleClient(provider.baseUrl);

    // Determine context size (default 32768 if not provided)
    const contextSizeTokens = context?.maxTokens ?? 32768;

    // Build the web search guidance message once, before budget calculation so
    // the budget accounts for the system message that the enabled-search branch
    // prepends to the request sent to ChatOrchestrator.
    const webSearchGuidanceMessage = buildWebSearchGuidanceMessage();

    // Calculate context budget before contacting provider
    const budgetResult = calculateContextBudget({
      contextSizeTokens,
      systemInstructions: result.data.webSearch?.enabled
        ? webSearchGuidanceMessage.content
        : "",
      conversationHistory: messages.slice(0, -1),
      currentUserMessage: messages[messages.length - 1].content,
      documentText: document?.text ?? null,
      documentFilename: document?.filename ?? null,
      hasDocument: !!document,
    });

    // If budget calculation says the request is invalid, reject before provider contact
    if (!budgetResult.valid) {
      const code = budgetResult.errorMessage?.includes("attached document")
        ? "DOCUMENT_CONTEXT_TOO_LARGE"
        : "CONTEXT_TOO_LARGE";
      const message = budgetResult.errorMessage ?? (
        code === "DOCUMENT_CONTEXT_TOO_LARGE"
          ? "The current conversation is too large to include the attached document. Start a new conversation or increase the configured context size."
          : "The current conversation is too large for the configured context size. Start a new conversation or increase the configured context size."
      );
      throw new AppError({
        code,
        statusCode: 400,
        message,
      });
    }

    // Build the full message list with (possibly truncated) document context
    const documentForMessages = document
      ? { ...document, text: budgetResult.includedDocumentText }
      : undefined;
    const allMessages = buildAllMessages(documentForMessages, messages);

    // Cancellation signal for the upstream provider request, driven by the client
    // connection. Fastify's `request.signal` cannot be used here: it is wired to the
    // IncomingMessage 'close' event, and on Node v26 that event fires as soon as the
    // request body has been consumed (`req.aborted === false`), so the signal is
    // already aborted when the handler starts and never reflects a real disconnect.
    // The response object does report disconnects correctly: 'close' before the
    // response ended means the client went away.
    const clientDisconnect = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    if (reply.raw.destroyed && !reply.raw.writableEnded) {
      // Client already gone before we could register the listener.
      clientDisconnect.abort();
    } else {
      reply.raw.once("close", () => {
        // Ignore the normal end-of-response close.
        if (reply.raw.writableEnded || clientDisconnect.signal.aborted) {
          return;
        }
        clientDisconnect.abort();
      });
    }

    // Build start event data (include context metadata only when truncation occurred)
    const startEventData: { model: string; context?: ContextTruncationMetadata } = {
      model: provider.model,
    };
    if (budgetResult.truncationMetadata.documentTruncated) {
      startEventData.context = budgetResult.truncationMetadata;
    }

    // Write start event
    await reply.sse.send({
      event: "start",
      data: startEventData,
    });

    // Build the request-scoped web search registry (undefined when web search is
    // not enabled, keeping the plain v1.0.0 streaming path).
    const webSearchRegistry = buildWebSearchRegistry(result.data.webSearch);

    try {
      if (webSearchRegistry) {
        // Web search enabled: run the turn through the single-tool orchestrator.
        // The safety guidance is prepended as a system message, and the tool
        // registry is request-scoped. Internal tool-call/tool-result messages and
        // the search results never surface as visible assistant text.
        const orchestratedMessages = [
          webSearchGuidanceMessage,
          ...allMessages,
        ];

        const orchestrator = new ChatOrchestrator(client);
        for await (const event of orchestrator.stream({
          providerConfig: {
            baseUrl: provider.baseUrl,
            model: provider.model,
            apiKey: provider.apiKey,
            timeoutMs: provider.timeoutMs,
          },
          messages: orchestratedMessages,
          tools: webSearchRegistry,
          signal: clientDisconnect.signal,
          contextSizeTokens,
        })) {
          if (clientDisconnect.signal.aborted) {
            break;
          }
          if (event.type === "delta") {
            await reply.sse.send({
              event: "delta",
              data: { text: sanitizeSseData(event.text) },
            });
          } else if (event.type === "done") {
            await reply.sse.send({
              event: "done",
              data: {},
            });
          } else if (event.type === "tool_start") {
            // Optionally carry the safe query; never a base URL, key or header.
            await reply.sse.send({
              event: "tool_start",
              data:
                event.query === undefined
                  ? { name: event.name }
                  : { name: event.name, query: event.query },
            });
          } else if (event.type === "tool_end") {
            await reply.sse.send({
              event: "tool_end",
              data: { name: event.name, resultCount: event.resultCount },
            });
          } else if (event.type === "sources") {
            // Backend-grounded source metadata: sanitized to { id, title, url }
            // with safe URLs only (see tools/sourceSanitization.ts).
            await reply.sse.send({
              event: "sources",
              data: { sources: event.sources },
            });
          }
        }
      } else {
        // Get the streaming response from the provider. clientDisconnect aborts the
        // upstream request as soon as the client disconnects (before headers arrive).
        const stream = await client.chatStream(
        {
          baseUrl: provider.baseUrl,
          model: provider.model,
          apiKey: provider.apiKey,
          timeoutMs: provider.timeoutMs,
        },
        allMessages,
        { signal: clientDisconnect.signal },
      );

      // Get the reader from the stream
      reader = stream.getReader();

      // Create SSE parser with the client-connection signal
      const parser = new SseParser({ signal: clientDisconnect.signal });

      // Stream events from the parser to the response
      for await (const event of parser.parse(reader)) {
        // If client disconnected, stop streaming
        if (clientDisconnect.signal.aborted) {
          break;
        }

        switch (event.type) {
          case "delta":
            await reply.sse.send({
              event: "delta",
              data: { text: sanitizeSseData(event.text) },
            });
            break;
          case "done":
            await reply.sse.send({
              event: "done",
              data: {},
            });
            break;
          case "error":
            await reply.sse.send({
              event: "error",
              data: { message: event.message },
            });
            break;
        }
      }
      }
    } catch (error) {
      // If client disconnected (user Stop/cancel), stay silent — no error event
      if (clientDisconnect.signal.aborted) {
        return;
      }

      // User-initiated abort from the provider client is also silent
      if (error instanceof Error) {
        const errorInfo = client.getErrorInfo(error);
        if (errorInfo.errorType === OpenAICompatibleClient.ErrorType.USER_ABORT) {
          return;
        }
      }

      // Provider error → send as SSE error event with the stable code.
      // This streaming boundary is the effective application boundary for this
      // error (it can never reach the global Fastify handler once headers have
      // been sent), so it is logged exactly once here.
      const appError = normalizeError(error);
      logNormalizedError(appError);

      const eventData: { code: AppError["code"]; message: string; detail?: string } = {
        code: appError.code,
        message: appError.userMessage,
      };
      if (appError.detail) {
        eventData.detail = appError.detail;
      }
      await reply.sse.send({
        event: "error",
        data: eventData,
      });
    }
  });
};

export default chat;
