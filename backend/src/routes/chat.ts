import type { FastifyPluginAsync } from "fastify";
import { OpenAICompatibleClient } from "../provider/client.js";
import { chatRequestSchema, type ChatMessage } from "../provider/schemas.js";
import { normalizeError, AppError } from "../utils/errorHandler.js";
import { SseParser } from "../provider/sseParser.js";
import {
  buildDocumentContextMessage,
  buildDocumentContentMessage,
} from "../utils/documentContext.js";
import {
  calculateContextBudget,
  type ContextTruncationMetadata,
} from "../context/context-budget.js";

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

    // Create AbortController for client disconnect detection
    const cleanupController = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    // Detect client disconnect and abort upstream
    reply.sse.onClose(() => {
      cleanupController.abort();
      if (reader) {
        void reader.cancel();
      }
    });

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

    try {
      // Get the streaming response from the provider (timeout signal owned by the client)
      const stream = await client.chatStream(
        {
          baseUrl: provider.baseUrl,
          model: provider.model,
          apiKey: provider.apiKey,
          timeoutMs: provider.timeoutMs,
        },
        allMessages,
      );

      // Get the reader from the stream
      reader = stream.getReader();

      // Create SSE parser with cleanup signal
      const parser = new SseParser({ signal: cleanupController.signal });

      // Stream events from the parser to the response
      for await (const event of parser.parse(reader)) {
        // If client disconnected, stop streaming
        if (cleanupController.signal.aborted) {
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
    } catch (error) {
      // If client disconnected (user Stop/cancel), stay silent — no error event
      if (cleanupController.signal.aborted) {
        return;
      }

      // User-initiated abort from the provider client is also silent
      if (error instanceof Error) {
        const errorInfo = client.getErrorInfo(error);
        if (errorInfo.errorType === OpenAICompatibleClient.ErrorType.USER_ABORT) {
          return;
        }
      }

      // Provider error → send as SSE error event
      const appError = normalizeError(error);
      await reply.sse.send({
        event: "error",
        data: { message: appError.userMessage },
      });
    }
  });
};

export default chat;
