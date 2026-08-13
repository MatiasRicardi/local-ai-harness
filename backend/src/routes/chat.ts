import type { FastifyPluginAsync } from "fastify";
import { OpenAICompatibleClient } from "../provider/client.js";
import { chatRequestSchema } from "../provider/schemas.js";
import { mapErrorToReply } from "../utils/errorHandler.js";
import { SseParser } from "../provider/sseParser.js";
import { config } from "../config/env.js";

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
  server.post("/api/chat/stream", async (request, reply) => {
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

    // Determine CORS origin from request
    const requestOrigin = request.headers.origin;
    const allowedOrigins = config.CORS_ORIGINS;
    const corsOrigin = allowedOrigins.includes(requestOrigin ?? "") ? requestOrigin : null;

    // Set up SSE headers for the response (including CORS since reply.raw bypasses Fastify's CORS plugin)
    const headers: Record<string, string> = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no", // Disable nginx buffering
    };
    if (corsOrigin) {
      headers["Access-Control-Allow-Origin"] = corsOrigin;
      headers["Access-Control-Allow-Credentials"] = "true";
    }

    reply.raw.writeHead(200, headers);

    // Create AbortController for client disconnect detection
    const abortController = new AbortController();

    // Detect client disconnect and abort upstream
    reply.raw.on("close", () => {
      abortController.abort();
    });

    // Write start event
    reply.raw.write(`event: start\ndata: ${JSON.stringify({ model: provider.model })}\n\n`);

    try {
      // Get the streaming response from the provider
      const stream = await client.chatStream(
        {
          baseUrl: provider.baseUrl,
          model: provider.model,
          apiKey: provider.apiKey,
          timeoutMs: provider.timeoutMs,
        },
        messages,
      );

      // Get the reader from the stream
      const reader = stream.getReader();

      // Create SSE parser
      const parser = new SseParser();

      // Stream events from the parser to the response
      for await (const event of parser.parse(reader)) {
        // If client disconnected, stop streaming
        if (abortController.signal.aborted) {
          break;
        }

        switch (event.type) {
          case "delta":
            reply.raw.write(`event: delta\ndata: ${JSON.stringify({ text: event.text })}\n\n`);
            break;
          case "done":
            reply.raw.write(`event: done\ndata: {}\n\n`);
            break;
          case "error":
            reply.raw.write(`event: error\ndata: ${JSON.stringify({ message: event.message })}\n\n`);
            break;
        }
      }

      // Close the response
      reply.raw.end();
    } catch (error) {
      // If client disconnected, don't send error
      if (abortController.signal.aborted) {
        return;
      }

      // Write error event
      const errorInfo = client.getErrorInfo(error);
      const { body: errorBody } = mapErrorToReply(errorInfo);
      reply.raw.write(`event: error\ndata: ${JSON.stringify({ message: errorBody.error })}\n\n`);
      reply.raw.end();
    }
  });
};

export default chat;
