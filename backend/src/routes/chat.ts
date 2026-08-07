import type { FastifyPluginAsync } from "fastify";
import { OpenAICompatibleClient } from "../provider/client.js";
import { chatRequestSchema } from "../provider/schemas.js";

/**
 * Maximum request body size for chat requests (1 MB).
 */
const MAX_CHAT_BODY_SIZE = 1_048_576; // 1 MB in bytes

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

    // Enforce maximum request body size using the actual processed body
    if (request.body) {
      const bodySize = Buffer.byteLength(JSON.stringify(request.body), 'utf-8');
      if (bodySize > MAX_CHAT_BODY_SIZE) {
        return reply.code(413).send({
          success: false,
          error: "Request body exceeds maximum size of 1 MB",
        });
      }
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
      // Use structured error mapping from the client
      const errorInfo = client.getErrorInfo(error);

      switch (errorInfo.errorType) {
        case OpenAICompatibleClient.ErrorType.TIMEOUT:
          return reply.code(504).send({
            success: false,
            error: "Provider request timed out",
          });

        case OpenAICompatibleClient.ErrorType.HTTP_ERROR:
          // Map HTTP 401/403 to authentication errors
          if (
            errorInfo.message.includes("401") ||
            errorInfo.message.includes("403")
          ) {
            return reply.code(401).send({
              success: false,
              error: "Provider authentication or authorization failed",
            });
          }
          return reply.code(502).send({
            success: false,
            error: "Provider returned an invalid response",
          });

        case OpenAICompatibleClient.ErrorType.MALFORMED_RESPONSE:
          return reply.code(400).send({
            success: false,
            error: "Provider returned a malformed response",
          });

        case OpenAICompatibleClient.ErrorType.NETWORK_ERROR:
          return reply.code(502).send({
            success: false,
            error: "Provider connection failed",
          });

        default:
          // Generic error
          return reply.code(500).send({
            success: false,
            error: errorInfo.message || "Provider request failed",
          });
      }
    }
  });
};

export default chat;
