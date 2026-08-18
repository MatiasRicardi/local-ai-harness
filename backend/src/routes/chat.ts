import type { FastifyPluginAsync } from "fastify";
import { OpenAICompatibleClient } from "../provider/client.js";
import { chatRequestSchema } from "../provider/schemas.js";
import { mapErrorToReply } from "../utils/errorHandler.js";
import { SseParser } from "../provider/sseParser.js";

/**
 * Minimal HTML/JSON sanitizer for untrusted SSE data from providers.
 * Escapes characters that could break the SSE wire format or inject HTML.
 */
function sanitizeSseData(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;")
    .replace(/\u0000/g, "")
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
      return reply.code(400).send({
        success: false,
        error: "Invalid request payload",
      });
    }

    const { provider, messages } = result.data;
    const client = new OpenAICompatibleClient(provider.baseUrl);

    try {
      // Forward messages through ProviderClient
      const response = await client.chat(
        {
          baseUrl: provider.baseUrl,
          model: provider.model,
          apiKey: provider.apiKey,
          timeoutMs: provider.timeoutMs,
        },
        messages,
      );

      // Extract the assistant message from the response
      const assistantMessage = response.choices[0]?.message;

      if (!assistantMessage?.content) {
        return reply.code(500).send({
          success: false,
          error: "Provider returned an empty response",
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
      const errorInfo = client.getErrorInfo(error);
      const { code, body } = mapErrorToReply(errorInfo);
      return reply.code(code).send(body);
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
      return reply.code(400).send({
        success: false,
        error: "Invalid request payload",
      });
    }

    const { provider, messages } = result.data;
    const client = new OpenAICompatibleClient(provider.baseUrl);

    // Create AbortController for client disconnect detection
    const abortController = new AbortController();

    // Detect client disconnect and abort upstream
    reply.sse.onClose(() => {
      abortController.abort();
    });

    // Write start event
    await reply.sse.send({
      event: "start",
      data: { model: provider.model },
    });

    try {
      // Get the streaming response from the provider (passing abort signal for end-to-end cancellation)
      const stream = await client.chatStream(
        {
          baseUrl: provider.baseUrl,
          model: provider.model,
          apiKey: provider.apiKey,
          timeoutMs: provider.timeoutMs,
        },
        messages,
        { signal: abortController.signal },
      );

      // Get the reader from the stream
      const reader = stream.getReader();

      // Create SSE parser with abort signal
      const parser = new SseParser({ signal: abortController.signal });

      // Stream events from the parser to the response
      for await (const event of parser.parse(reader)) {
        // If client disconnected, stop streaming
        if (abortController.signal.aborted) {
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
      // If client disconnected, don't send error
      if (abortController.signal.aborted) {
        return;
      }

      // Write error event
      const errorInfo = client.getErrorInfo(error);
      const { body: errorBody } = mapErrorToReply(errorInfo);
      await reply.sse.send({
        event: "error",
        data: { message: errorBody.error },
      });
    }
  });
};

export default chat;
