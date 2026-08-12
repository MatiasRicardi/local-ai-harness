import type { FastifyPluginAsync } from "fastify";
import { OpenAICompatibleClient } from "../provider/client.js";
import { chatMessagesSchema, providerConfigSchema } from "../provider/schemas.js";
import { z } from "zod";
import { mapErrorToReply } from "../utils/errorHandler.js";

/**
 * Zod schema for provider test payload validation.
 */
export const providerTestPayloadSchema = z.object({
  baseUrl: providerConfigSchema.shape.baseUrl,
  model: providerConfigSchema.shape.model,
  apiKey: providerConfigSchema.shape.apiKey,
  timeout: providerConfigSchema.shape.timeoutMs,
});

/**
 * Request payload for provider test endpoint.
 */
export type ProviderTestPayload = z.infer<typeof providerTestPayloadSchema>;

/**
 * Provider test route handler.
 *
 * Tests the connection to a local model server by sending a minimal prompt
 * and returning a normalized response.
 */
const providerTest: FastifyPluginAsync = async (server) => {
  server.post("/api/provider/test", async (request, reply) => {
    const result = providerTestPayloadSchema.safeParse(request.body);
    if (!result.success) {
      return reply.code(400).send({
        success: false,
        error: "Invalid request payload",
      });
    }

    const payload = result.data;
    const client = new OpenAICompatibleClient(payload.baseUrl);

    try {
      // Create a minimal chat message and validate with schema
      const messages = chatMessagesSchema.parse([
        {
          role: "user",
          content: "Hello, respond with a short greeting.",
        },
      ]);

      // Send the chat completion request with timeout
      const timeoutMs = payload.timeout ?? 120_000;

      const response = await client.chat(
        {
          baseUrl: payload.baseUrl,
          model: payload.model,
          apiKey: payload.apiKey,
          timeoutMs,
        },
        messages,
      );

      // Extract the assistant text from the response
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
        model: response.model,
        text: assistantMessage.content,
      });
    } catch (error) {
      const errorInfo = client.getErrorInfo(error);
      const { code, body } = mapErrorToReply(errorInfo);
      return reply.code(code).send(body);
    }
  });
};

export default providerTest;
