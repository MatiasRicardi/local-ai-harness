import type {
  Tool,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./types.js";
import type {
  WebSearchProvider,
  WebSearchRequest,
} from "../search/types.js";
import { webSearchRequestSchema } from "../search/types.js";
import { AppError } from "../utils/errorHandler.js";
import {
  WEB_SEARCH_UNTRUSTED_CONTENT_MARKER,
  formatContent,
  formatSources,
  type WebSearchSource,
} from "./webSearchFormat.js";

// ── Web search tool ───────────────────────────────────────────────────────────
//
// The first concrete generic tool. It exposes an OpenAI-style `web_search`
// definition to a model and executes a single search through the generic
// {@link WebSearchProvider} abstraction. It never knows about Tavily, the
// Tavily base URL, or API keys: those belong to the provider and to
// application/user configuration.
//
// The model only ever controls the `query`. Application/user configuration
// owns maxResults, searchDepth, the endpoint, and the credentials.

/**
 * Application/user-controlled settings used to build the search request.
 *
 * These are the only knobs the application exposes; the model cannot change
 * them through tool arguments.
 */
export interface WebSearchToolConfig {
  maxResults: number;
  searchDepth: "basic" | "advanced";
}

// Re-exported so consumers import the source type from the tool module.
export type { WebSearchSource };
export { WEB_SEARCH_UNTRUSTED_CONTENT_MARKER };

/** Recommended OpenAI-style description of the tool. */
export const WEB_SEARCH_TOOL_DESCRIPTION =
  "Search the public web for current or external information when the user's\n" +
  "request requires information that may not be available in the model's\n" +
  "training data.";

/** OpenAI-style tool definition. Only `query` is model-controllable. */
export const webSearchToolDefinition: ToolDefinition = {
  name: "web_search",
  description: WEB_SEARCH_TOOL_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "A concise web search query.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

/**
 * Validate model-supplied web search arguments.
 *
 * Throws a {@link AppError} with `VALIDATION_ERROR` when the query is missing
 * or invalid, or when unknown/extra fields are present. Shared by the tool's
 * own `execute` (defence-in-depth for direct callers) and by the orchestrator,
 * which calls `validate` before emitting a `tool_start` event so an invalid
 * call fails without ever signaling that a search started.
 */
function validateWebSearchArgs(args: unknown): void {
  const parsed = webSearchRequestSchema.safeParse(args);
  if (!parsed.success) {
    throw new AppError({
      code: "VALIDATION_ERROR",
      statusCode: 400,
      message: "Invalid web search arguments.",
    });
  }
}

/**
 * Create the `web_search` tool.
 *
 * @param config application/user-controlled settings (maxResults, searchDepth)
 * @param provider generic web-search provider (already configured with the
 *   backend-owned base URL and the request-scoped API key)
 */
export function createWebSearchTool(
  config: WebSearchToolConfig,
  provider: WebSearchProvider,
): Tool {
  return {
    definition: webSearchToolDefinition,
    validate: validateWebSearchArgs,

    async execute(
      args: unknown,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionResult> {
      // Validate our own arguments before any external work. Invalid input
      // surfaces through the existing VALIDATION_ERROR path; the provider is
      // never contacted. (The orchestrator also runs `validate()` before
      // tool_start; this covers direct callers.)
      validateWebSearchArgs(args);

      // The model only supplies the query. Application configuration owns the
      // rest, so provider-only knobs are taken from `config`, never from args.
      const parsed = webSearchRequestSchema.parse(args);
      const request: WebSearchRequest = {
        query: parsed.query,
        maxResults: config.maxResults,
        searchDepth: config.searchDepth,
      };

      // A rejected search propagates out of this async execute unchanged; the
      // route layer maps provider errors (e.g. TavilySearchError) into the
      // structured error model. Only the pure formatting below is wrapped.
      const results = await provider.search(request, { signal: context.signal });

      // Formatting is pure and internal. Any unexpected failure here is an
      // internal tool failure, mapped to INTERNAL_ERROR — not a provider error.
      try {
        return {
          content: formatContent(results),
          metadata: { sources: formatSources(results) },
        };
      } catch {
        throw new AppError({
          code: "INTERNAL_ERROR",
          statusCode: 500,
          message: "Web search failed while formatting results.",
        });
      }
    },
  };
}
