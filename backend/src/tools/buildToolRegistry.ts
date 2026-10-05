import type { WebSearchConfig } from "../provider/schemas.js";
import { config } from "../config/env.js";
import { TavilySearchProvider } from "../search/tavily.js";
import {
  createWebSearchTool,
  type WebSearchToolConfig,
} from "./webSearchTool.js";
import { createCalculatorTool } from "./calculatorTool.js";
import { createToolRegistry } from "./registry.js";
import type { ToolRegistry } from "./types.js";

/**
 * Backend-authoritative defaults for the application/user-controlled web search
 * knobs. The model cannot change these (they are not part of the tool input
 * schema); they are only the fallbacks used when the request omits them.
 */
const WEB_SEARCH_DEFAULT_MAX_RESULTS = 5;
const WEB_SEARCH_DEFAULT_SEARCH_DEPTH = "basic" as const;

/**
 * Options that drive request-scoped tool composition.
 *
 * Every built-in tool is opt-in: an omitted/`undefined` field means the tool is
 * not registered for that request. The set of fields grows as new tools are
 * added (e.g. `calculator`, `fetchUrl`) without ever changing the call shape,
 * which is why composition takes a single options object rather than positional
 * tool arguments.
 */
export interface BuildToolRegistryOptions {
  readonly webSearch?: WebSearchConfig;
  /**
   * Opt-in built-in tool switches. Every field is optional and off by default;
   * an omitted/`undefined` field means the tool is not registered for that
   * request. The set grows as new tools are added (e.g. `fetchUrl` in Step 50)
   * without changing the call shape.
   */
  readonly tools?: Readonly<{
    readonly calculator?: boolean;
  }>;
}

/**
 * Compose the request-scoped tool registry for a chat request.
 *
 * This is the single point where built-in tools are wired into a request. It:
 *
 * - creates a fresh {@link ToolRegistry} for every call (never a shared/global
 *   singleton, so credentials and config from one request can never leak into
 *   another),
 * - registers each enabled tool through its own branch,
 * - returns `undefined` when no tool is enabled, or the populated registry when
 *   at least one tool is registered.
 *
 * Callers must treat `undefined` as "no tools available" and a non-`undefined`
 * return as "at least one tool is available". They should never re-derive that
 * decision from a per-tool flag such as `webSearch.enabled`.
 *
 * For web search: the backend-owned base URL comes from `config.TAVILY_BASE_URL`
 * and the API key is injected request-scoped. Neither is ever persisted, logged,
 * or echoed back through SSE, tool content, sources, or error details.
 */
export function buildToolRegistry(
  options: BuildToolRegistryOptions,
): ToolRegistry | undefined {
  const registry = createToolRegistry();

  if (options.webSearch?.enabled) {
    const provider = new TavilySearchProvider({
      baseUrl: config.TAVILY_BASE_URL,
      apiKey: options.webSearch.apiKey as string,
    });

    const toolConfig: WebSearchToolConfig = {
      maxResults: options.webSearch.maxResults ?? WEB_SEARCH_DEFAULT_MAX_RESULTS,
      searchDepth: options.webSearch.searchDepth ?? WEB_SEARCH_DEFAULT_SEARCH_DEPTH,
    };

    registry.register(createWebSearchTool(toolConfig, provider));
  }

  if (options.tools?.calculator) {
    registry.register(createCalculatorTool());
  }

  // The invariant this factory guarantees: it never returns an empty registry.
  // `createToolRegistry()` always yields a registry, so a non-`undefined` return
  // here means at least one tool was registered. Callers rely on this to choose
  // between the tool-aware orchestrator and the direct streaming path.
  return registry.listDefinitions().length > 0 ? registry : undefined;
}
