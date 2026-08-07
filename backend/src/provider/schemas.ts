import { z } from "zod";

// ── Provider configuration schema ────────────────────────────────────────────

/**
 * Zod schema for provider configuration.
 * Covers the fields the frontend sends when testing or chatting with a provider.
 */
export const providerConfigSchema = z.object({
  baseUrl: z
    .string()
    .min(1, "Base URL is required")
    .url("Base URL must be a valid URL")
    .refine((url) => {
      try {
        const parsed = new URL(url);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
      } catch {
        return false;
      }
    }, "Base URL must use http or https protocol"),
  model: z
    .string()
    .min(1, "Model name is required")
    .max(200, "Model name must not exceed 200 characters"),
  apiKey: z.string().optional(),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(300_000, "Timeout must not exceed 300 seconds")
    .default(120_000),
});

export type ProviderConfig = z.infer<typeof providerConfigSchema>;

// ── Chat message schema ──────────────────────────────────────────────────────

/**
 * Zod schema for a single chat message.
 */
export const chatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z
    .string()
    .min(1, "Message content must not be empty")
    .refine((val) => val.trim().length > 0, {
      message: "Message content must not be empty or only whitespace",
    }),
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;

/**
 * Zod schema for a list of chat messages.
 */
export const chatMessagesSchema = z
  .array(chatMessageSchema)
  .min(1, "At least one message is required");

export type ChatMessages = z.infer<typeof chatMessagesSchema>;

// ── Chat request schema ──────────────────────────────────────────────────────

/**
 * Zod schema for the chat request body sent to the backend.
 * Note: Document/file context is not supported in this step and will be
 * added in a later step when file handling is implemented.
 */
export const chatRequestSchema = z.object({
  provider: providerConfigSchema,
  messages: chatMessagesSchema,
}).strict(); // Reject extra fields (e.g., document context not supported in step09)

export type ChatRequest = z.infer<typeof chatRequestSchema>;
