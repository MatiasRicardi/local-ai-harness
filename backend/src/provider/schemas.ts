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
  id: z.string().optional(),
  role: z.enum(["system", "user", "assistant"]),
  content: z
    .string()
    .refine((val) => val.trim().length > 0, {
      message: "Message content must not be empty or only whitespace",
    }),
  stopped: z.boolean().optional(),
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;

/**
 * Zod schema for a list of chat messages.
 */
export const chatMessagesSchema = z
  .array(chatMessageSchema)
  .min(1, "At least one message is required");

export type ChatMessages = z.infer<typeof chatMessagesSchema>;

// ── Chat document context schema ─────────────────────────────────────────────

/**
 * Zod schema for the document context included in chat requests.
 */
export const chatDocumentContextSchema = z.object({
  fileId: z.string(),
  filename: z.string(),
  text: z.string(),
});

export type ChatDocumentContext = z.infer<typeof chatDocumentContextSchema>;

// ── Chat request schema ──────────────────────────────────────────────────────

/**
 * Zod schema for the chat request body sent to the backend.
 */
export const chatRequestSchema = z.object({
  provider: providerConfigSchema,
  messages: chatMessagesSchema,
  document: chatDocumentContextSchema.optional(),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;
