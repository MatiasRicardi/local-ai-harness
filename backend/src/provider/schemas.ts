import { z } from "zod";
import { WEB_SEARCH_MIN_RESULTS, WEB_SEARCH_MAX_RESULTS } from "../search/types.js";

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

// ── Chat context schema ──────────────────────────────────────────────────────

/**
 * Zod schema for the context configuration included in chat requests.
 */
export const chatContextSchema = z.object({
  maxTokens: z
    .number()
    .int()
    .min(1024, "Context size must be at least 1024 tokens")
    .max(2_000_000, "Context size must not exceed 2,000,000 tokens"),
});

export type ChatContext = z.infer<typeof chatContextSchema>;

// ── Web search configuration schema ──────────────────────────────────────────

/**
 * Zod schema for the optional per-request web search configuration.
 *
 * Web search is an opt-in capability. When `enabled` is `true` the backend
 * wires the `web_search` tool into the streaming chat turn. The model only
 * ever controls the search `query`; the endpoint (`TAVILY_BASE_URL`) and the
 * credentials (`apiKey`) are owned by the backend configuration and by the
 * user request respectively, and can never be altered through this object.
 *
 * Only `tavily` is supported in this phase, so an unknown provider is a plain
 * validation failure (no dedicated error code yet). `maxResults` and
 * `searchDepth` are application/user knobs: optional here, defaulted by the
 * backend where omitted.
 */
export const webSearchSchema = z
  .object({
    enabled: z.boolean(),
    provider: z.enum(["tavily"], {
      message: "Only the 'tavily' web search provider is supported",
    }),
    apiKey: z
      .string()
      .min(1, "API key must not be empty")
      .optional(),
    maxResults: z
      .int()
      .min(WEB_SEARCH_MIN_RESULTS, `maxResults must be at least ${WEB_SEARCH_MIN_RESULTS}`)
      .max(WEB_SEARCH_MAX_RESULTS, `maxResults must not exceed ${WEB_SEARCH_MAX_RESULTS}`)
      .optional(),
    searchDepth: z.enum(["basic", "advanced"]).optional(),
  })
  .refine((value) => !(value.enabled && !value.apiKey), {
    message: "An API key is required when web search is enabled",
    path: ["apiKey"],
  });

export type WebSearchConfig = z.infer<typeof webSearchSchema>;

// ── Chat request schema ──────────────────────────────────────────────────────

/**
 * Zod schema for the chat request body sent to the backend.
 */
export const chatRequestSchema = z.object({
  provider: providerConfigSchema,
  messages: chatMessagesSchema,
  document: chatDocumentContextSchema.optional(),
  context: chatContextSchema.optional(),
  webSearch: webSearchSchema.optional(),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;
