import type { FastifyPluginAsync } from "fastify";
import { OpenAICompatibleClient } from "../provider/client.js";
import { chatRequestSchema } from "../provider/schemas.js";
import { mapErrorToReply } from "../utils/errorHandler.js";

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
};

export default chat;
