import type { FastifyPluginAsync } from "fastify";
import { OpenAICompatibleClient } from "../provider/client.js";
import { chatMessagesSchema, providerConfigSchema } from "../provider/schemas.js";
import { z } from "zod";

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

export default providerTest;
