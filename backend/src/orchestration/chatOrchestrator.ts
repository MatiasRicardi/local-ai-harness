import type { ChatMessage } from "../provider/schemas.js";
import type { ProviderClient, ProviderRequestMessage } from "../provider/types.js";
import type { ProviderConfig } from "../provider/schemas.js";
import { OpenAICompatibleClient, ProviderClientError } from "../provider/client.js";
import { SseParser, type AccumulatedToolCall } from "../provider/sseParser.js";
import type { ToolDefinition, ToolExecutionResult, ToolRegistry } from "../tools/types.js";
import { sanitizeSourceCandidate, type SourceRef } from "../tools/sourceSanitization.js";
import { TurnSourceAccumulator, type DeliveredSource } from "./turnSources.js";
import { normalizeError, AppError } from "../utils/errorHandler.js";
import { estimateTokens } from "../context/token-estimate.js";
import {
  calculateToolResultBudget,
  truncateContentPreservingStructure,
} from "../context/toolResultBudget.js";

/**
 * Estimate the tokens of a complete provider request message list.
 *
 * Serializes the messages to their stable JSON representation so the estimate
 * accounts for everything actually sent to the provider — `role`, `content`,
 * assistant `tool_calls` (name + arguments), tool call `id`s, tool names and
 * the `role: "tool"` structure — not just the `content` fields. Not a real
 * tokenizer: it reuses the shared character→token estimator over the JSON, which
 * is deterministic and consistent with how the rest of the request is measured.
 */
function estimateProviderMessagesTokens(messages: ProviderRequestMessage[]): number {
  return estimateTokens(JSON.stringify(messages));
}
import { validateToolCalls, type ResolvedToolCall } from "./toolCallValidation.js";
import {
  WEB_SEARCH_UNTRUSTED_CONTENT_MARKER,
  formatSourceBlock,
  type WebSearchSource,
} from "../tools/webSearchFormat.js";

// ── Chat orchestration loop ──────────────────────────────────────────────────
//
// A small, provider-agnostic orchestration layer that lets a model request a
// tool, executes it once, returns the result to the model, and streams the
// final answer. It knows nothing about any concrete provider (Tavily, …): it
// only depends on the generic {@link ToolRegistry}, the provider client, the
// context-budget helpers and the shared cancellation signal.
//
// Sequential, bounded multi-step loop:
//   - at most MAX_TOOL_EXECUTIONS_PER_TURN executed tools per user turn;
//   - the final answer may be a fourth model round, sent without tools;
//   - at most MAX_MODEL_ROUNDS model rounds per turn;
//   - at most one tool call accepted per model round (parallel calls unsupported).
//
// The loop is bounded by MAX_MODEL_ROUNDS on every iteration, so a fifth round
// is structurally impossible. The orchestrator is intentionally decoupled from
// the HTTP layer and from any tool configuration: callers inject an
// already-configured registry. Step 31 owns wiring it into `/api/chat/stream`.
//
// Tool results are budgeted per-execution against the full input budget, and
// the budget is recomputed every time a new result is accumulated (step 42):
// the fixed content of each round already includes every prior tool-call and
// tool-result message, so a chain of tools shares one finite, cumulative input
// budget instead of each getting an independent full-size allowance.

/** Maximum number of model rounds in a single user turn (tools + final answer). */
export const MAX_MODEL_ROUNDS = 4;

/** Maximum number of executed tools in a single user turn. */
export const MAX_TOOL_EXECUTIONS_PER_TURN = 3;

/**
 * Short, harness-controlled text sent as the `role: "tool"` body when a tool
 * returned real content but the context budget left no room to include it.
 * Distinct from a genuinely empty tool result so the model can tell "nothing
 * was returned" apart from "the result was omitted because of context limits".
 * Its token cost is always reserved inside the fixed budget (see
 * {@link buildToolResultMessages}), so it never pushes the request over the
 * configured context target.
 */
export const TOOL_RESULT_CONTEXT_OMISSION_TEXT =
  "Tool result omitted: there is not enough context space to include this result.";

/**
 * Input for a single orchestrated chat turn.
 *
 * `tools` is an optional, already-configured registry. When it is omitted or
 * empty, the orchestrator behaves exactly like the plain model streaming path.
 */
export interface ChatOrchestrationInput {
  providerConfig: ProviderConfig;
  messages: ChatMessage[];
  tools?: ToolRegistry;
  signal?: AbortSignal;
  /**
   * Configured model context window, used to budget tool-result content. When
   * omitted the web result is never truncated (no context limit is applied).
   */
  contextSizeTokens?: number;
}

/**
 * Events emitted by the orchestrator. The future caller (the SSE route) maps
 * each onto a matching SSE event. Internal tool-call/tool-result messages never
 * surface as visible text.
 *
 * Tool lifecycle events (`tool_start` / `tool_end` / `sources`) are only ever
 * emitted from the tool-execution path, so a plain model turn (no tools) still
 * yields only `delta` / `done` — preserving the v1.0.0 streaming shape.
 */
export type ChatOrchestrationEvent =
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "tool_start"; name: string }
  | { type: "tool_end"; name: string }
  | { type: "sources"; sources: SourceRef[] };

/** Outcome of consuming one model round. */
type RoundOutcome =
  | { status: "cancelled" }
  | { status: "done"; textDeltas: string[] }
  | { status: "tool_calls"; toolCalls: AccumulatedToolCall[] };


function sanitizeSseData(text: string): string {
  return text.replace(/\u0000/g, "");
}

/**
 * Extract the structured per-source blocks the web-search tool emits.
 *
 * The tool stores one entry per result in `metadata.sources`, each carrying the
 * exact `id`, `title`, `url` and `content` used to render its `[id]`-prefixed
 * block (see webSearchFormat). A source is kept only when it has this full,
 * well-formed shape; anything else (other tools, partial or untrusted metadata)
 * yields no blocks, so the delivered-id logic stays scoped to the web-search
 * content layout instead of trusting arbitrary metadata.
 *
 * @param value raw `metadata.sources` from the tool result
 * @returns the well-formed structured sources, in block order
 */
function toStructuredSources(value: unknown): WebSearchSource[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const sources: WebSearchSource[] = [];
  for (const entry of value) {
    const source = entry as {
      id?: unknown;
      title?: unknown;
      url?: unknown;
      content?: unknown;
    };
    if (
      typeof source?.id === "number" &&
      Number.isFinite(source.id) &&
      typeof source?.title === "string" &&
      typeof source?.url === "string" &&
      typeof source?.content === "string"
    ) {
      sources.push({ id: source.id, title: source.title, url: source.url, content: source.content });
    }
  }
  return sources;
}

/**
 * Which source IDs actually entered the model's context.
 *
 * The full web content is the untrusted marker followed by one exact
 * `[id]`-prefixed block per source (see webSearchFormat), joined by a blank
 * line. `toolResultContent` is that content cut at a blank-line boundary, so
 * every block start and end lands on that boundary. A source is delivered iff
 * its whole block fits within the truncated content, computed from the known
 * block lengths and positions — never by re-parsing the untrusted body.
 *
 * This keeps source IDs as structured metadata: a blank-line paragraph inside
 * another source's body (for example a `[2]\nTitle:` mention in source 1) can
 * never be mistaken for a delivered source, and a source dropped by truncation
 * is excluded. The set stays consistent with what the model actually received.
 *
 * @param sources structured sources in block order (see {@link toStructuredSources})
 * @param toolResultContent the (possibly truncated) content sent to the model
 * @returns the set of source IDs whose blocks were delivered
 */
function deliveredSourceIds(sources: WebSearchSource[], toolResultContent: string): Set<number> {
  const delivered = new Set<number>();
  const markerLength = WEB_SEARCH_UNTRUSTED_CONTENT_MARKER.length;
  const contentLength = toolResultContent.length;
  let offset = markerLength + "\n\n".length;
  for (const source of sources) {
    const block = formatSourceBlock(source);
    const blockEnd = offset + block.length;
    if (blockEnd <= contentLength) {
      delivered.add(source.id);
    }
    offset = blockEnd + "\n\n".length;
  }
  return delivered;
}

export class ChatOrchestrator {
  private readonly client: ProviderClient;

  constructor(client: ProviderClient) {
    this.client = client;
  }

  /**
   * Run one orchestrated turn, yielding the visible assistant stream.
   *
   * When tools are registered this drives a bounded, sequential multi-step
   * loop (see {@link MAX_MODEL_ROUNDS} / {@link MAX_TOOL_EXECUTIONS_PER_TURN}):
   *
   * ```text
   * round 1 [tools] --tool--> execute ->
   * round 2 [tools] --tool--> execute ->
   * round 3 [tools] --tool--> execute ->
   * round 4 [no tools] ------> final streamed answer
   * ```
   *
   * A turn finishes early when a tool-enabled round returns ordinary assistant
   * text instead of another tool call. At most one tool call is accepted per
   * model round; parallel tool calls are unsupported in v1.2.0.
   */
  async *stream(input: ChatOrchestrationInput): AsyncGenerator<ChatOrchestrationEvent> {
    const definitions = input.tools?.listDefinitions() ?? [];

    // No tools: equivalent to the existing model streaming path — stream live,
    // without buffering, so latency and behaviour are unchanged.
    if (definitions.length === 0) {
      yield* this.streamRoundLive({
        providerConfig: input.providerConfig,
        messages: input.messages,
        signal: input.signal,
      });
      return;
    }

    // Working copy of the conversation. Tool-call / tool-result messages are
    // appended in place as each tool executes, preserving the OpenAI-compatible
    // tool-call history across every round.
    const workingMessages: ProviderRequestMessage[] = [...input.messages];

    // Two independent counters. `modelRoundCount` bounds the number of model
    // rounds; `toolExecutionCount` bounds the number of executed tools in the
    // turn. Both are request-local and never persist beyond this turn.
    let modelRoundCount = 0;
    let toolExecutionCount = 0;
    // Per-tool execution attempts actually started this turn, keyed by tool
    // name. Incremented immediately before each real `tool.execute` so a
    // failing tool still consumes its quota (step 41). Request-local: it lives
    // only on this invocation and resets to empty for every turn.
    const executionsByTool = new Map<string, number>();
    // Tools stay available until the execution cap is reached; after that the
    // final round is sent without tool definitions.
    let toolsAvailable = true;

    // Turn-local cumulative source accumulator. Each tool execution merges its
    // delivered sources here and the FULL accumulated list is re-emitted, so the
    // UI (which replaces `message.sources` per event) never loses sources from
    // earlier tools in the turn.
    const turnSources = new TurnSourceAccumulator();

    // The loop is bounded by MAX_MODEL_ROUNDS on every iteration, so a fifth
    // round is structurally impossible regardless of how the control flow
    // branches below.
    while (modelRoundCount < MAX_MODEL_ROUNDS) {
      modelRoundCount++;

      // Once the execution cap is reached, the final round runs with no tools.
      // Stream it live (progressive) instead of buffering: the model can no
      // longer execute a tool, so there is no filler to discard. `streamRoundLive`
      // also rejects a stray tool call here via TOOL_CALL_LIMIT_EXCEEDED, so a
      // tool-enabled round that returns plain text is never mistaken for this
      // final live answer.
      if (!toolsAvailable) {
        yield* this.streamRoundLive({
          providerConfig: input.providerConfig,
          messages: workingMessages,
          signal: input.signal,
        });
        return;
      }

      const round = await this.runModelRound({
        providerConfig: input.providerConfig,
        messages: workingMessages,
        signal: input.signal,
        tools: definitions,
        toolChoice: "auto",
      });

      if (round.status === "cancelled") {
        // Cancellation is silent: no error, no further round.
        return;
      }

      if (round.status === "done") {
        // A tool-enabled round that returned plain text flushes its already
        // buffered text as the final answer, as a single
        // delta/done sequence. Progressive live streaming is reserved for the
        // forced no-tools final round (handled above).
        for (const delta of round.textDeltas) {
          yield { type: "delta", text: sanitizeSseData(delta) };
        }
        yield { type: "done" };
        return;
      }

      // round.status === "tool_calls": resolve, validate, and execute (or
      // block) one tool call, then loop. `executeToolRound` returns `true` when
      // the requested tool was blocked by its per-turn execution policy: no
      // tool executed and no lifecycle event emitted, so the loop closes the
      // call with a synthetic result and takes the final no-tools round.
      const toolBlockedByPolicy = yield* this.executeToolRound(
        input,
        workingMessages,
        round.toolCalls,
        executionsByTool,
        turnSources,
      );
      if (toolBlockedByPolicy) {
        toolsAvailable = false;
        continue;
      }

      // Cancellation during/just after execution: stop before the next round,
      // silently, matching the pre-existing cancellation semantics.
      if (input.signal?.aborted) {
        return;
      }

      toolExecutionCount++;
      if (toolExecutionCount >= MAX_TOOL_EXECUTIONS_PER_TURN) {
        toolsAvailable = false;
      }
    }

    // Defensive: the loop can only exit by answering (done) or throwing, so
    // this is unreachable in practice. Guard it explicitly so an impossible
    // state fails loudly instead of ending the turn with no answer.
    throw new AppError({
      code: "TOOL_CALL_LIMIT_EXCEEDED",
      statusCode: 502,
      message: "The model exceeded the allowed number of tool rounds without producing an answer.",
    });
  }

  /**
   * Resolve, validate and execute (or block) a single tool call from one
   * buffered model round, appending the provider-compatible assistant tool-call
   * and `role: "tool"` result messages to `workingMessages`, and yielding the
   * `tool_start` / `tool_end` / `sources` lifecycle events in order.
   *
   * When the tool's per-turn execution limit is already reached the call is
   * blocked instead of executed: no lifecycle events are emitted, a synthetic
   * `role: "tool"` result is appended to close the call, and the generator
   * returns `true` so the caller disables tools for the rest of the turn.
   *
   * Returns `true` when the tool was blocked by its per-turn execution policy,
   * `false` otherwise (executed, or an error was thrown).
   *
   * The tool-result body is budgeted against the context window exactly as in
   * the pre-existing path (see {@link buildToolResultMessages});
   * this is intentionally per-result and does not yet aggregate budgets across
   * multiple accumulated results (step 42 owns that).
   */
  private async *executeToolRound(
    input: ChatOrchestrationInput,
    workingMessages: ProviderRequestMessage[],
    toolCalls: AccumulatedToolCall[],
    executionsByTool: Map<string, number>,
    turnSources: TurnSourceAccumulator,
  ): AsyncGenerator<ChatOrchestrationEvent, boolean, unknown> {
    const { tool, call } = validateToolCalls(toolCalls, input.tools);

    // Parse JSON only after the full call has been accumulated.
    let args: unknown;
    try {
      // Reject empty or whitespace-only arguments as malformed before
      // execution so this follows the TOOL_INVALID_ARGUMENTS path instead of
      // falling through to the tool (which would surface a VALIDATION_ERROR).
      // Valid JSON, including the empty-object string "{}", still parses.
      const rawArguments = call.function.arguments.trim();
      if (rawArguments.length === 0) {
        throw new SyntaxError("empty tool-call arguments");
      }
      args = JSON.parse(rawArguments);
    } catch {
      throw new AppError({
        code: "TOOL_INVALID_ARGUMENTS",
        statusCode: 502,
        message: "The model returned a malformed tool call. Retry without requesting tools.",
      });
    }

    // Validate semantic arguments before surfacing a tool_start. An invalid or
    // unknown call fails here with no tool_start event, so the UI never sees a
    // search that never started.
    if (tool.validate) {
      tool.validate(args);
    }

    // Per-turn execution policy (step 41): a tool may run at most
    // `maxExecutionsPerTurn` times within a single turn. When the limit is
    // already reached we do NOT execute, do NOT emit any lifecycle event, and
    // instead close the call with a synthetic harness result. The caller then
    // disables tools for the remainder of the turn, so the model cannot keep
    // requesting the blocked tool.
    const perToolLimit = tool.executionPolicy?.maxExecutionsPerTurn;
    if (
      typeof perToolLimit === "number" &&
      (executionsByTool.get(tool.definition.name) ?? 0) >= perToolLimit
    ) {
      yield* this.appendBlockedToolResult(workingMessages, call, tool.definition.name);
      return true;
    }

    // Abort before execution: count nothing and invoke nothing.
    if (input.signal?.aborted) {
      return false;
    }

    // A real execution attempt is about to begin. Count it against this tool's
    // per-turn limit immediately before invoking `execute`, so a failing tool
    // still consumes its quota and cannot be retried indefinitely. Only calls
    // that passed validation, resolution, policy and abort checks reach this
    // point; unknown/malformed/invalid/blocked calls and pre-execution aborts
    // are never counted.
    executionsByTool.set(
      tool.definition.name,
      (executionsByTool.get(tool.definition.name) ?? 0) + 1,
    );

    // The tool has started: emit tool_start exactly once, immediately before
    // execution. The event is generic (tool name only) so it stays valid for
    // any tool, not just web search.
    yield { type: "tool_start", name: tool.definition.name };

    // Execute. The same cancellation signal reaches the tool.
    let result: ToolExecutionResult;
    try {
      result = await tool.execute(args, { signal: input.signal });
    } catch (error) {
      // Cancellation during execution: no further round, silent. The attempt
      // was already counted, so this returns false (not a policy block).
      if (input.signal?.aborted) {
        return false;
      }
      // Preserve provider/search error mappings (normalizeError maps both the
      // generic provider client and any concrete provider's errors onto the
      // PROVIDER_* codes). A non-provider failure — a generic/unexpected error,
      // or a tool-produced error that is not a provider error — becomes a
      // tool-execution failure so the caller can retry without tools.
      const mapped = normalizeError(error);
      if (!mapped.code.startsWith("PROVIDER_")) {
        throw new AppError({
          code: "TOOL_EXECUTION_FAILED",
          statusCode: 502,
          message: "The requested tool could not be executed. Retry without requesting tools.",
        });
      }
      throw mapped;
    }

    // Cancellation after the tool completed but before the next round: do not
    // start it. The attempt was already counted, so this returns false (not a
    // policy block).
    if (input.signal?.aborted) {
      return false;
    }

    // Append the internal assistant tool-call / tool-result messages to the
    // working list (budgeting the tool-result body against the context window).
    const { assistantMessage, toolResultMessage, deliveredSources } =
      await this.buildToolResultMessages(
        workingMessages,
        call,
        result,
        turnSources,
        input.contextSizeTokens,
      );
    workingMessages.push(assistantMessage, toolResultMessage);

    // Emit the tool lifecycle tail. `buildToolResultMessages` returns only the
    // sources actually delivered to the model; merge them into the turn-local
    // accumulator and re-emit the COMPLETE cumulative list so the UI keeps every
    // source from earlier tools in the turn (it replaces `message.sources` per
    // event). A tool that adds no source (e.g. calculator) re-emits the existing
    // accumulator unchanged, so prior sources are never dropped.
    const accumulatedSources = turnSources.add(deliveredSources);
    yield { type: "tool_end", name: tool.definition.name };
    yield { type: "sources", sources: accumulatedSources };

    // Executed normally (no policy block). The only other exits are the early
    // `return false` paths above and thrown errors.
    return false;
  }

  /**
   * Close a tool call that was blocked by its per-turn execution policy.
   *
   * Preserves the OpenAI-compatible contract by appending the assistant
   * tool-call message and a matching `role: "tool"` result, but the result is
   * a short, stable harness-generated note (never an internal error, config,
   * counter, or stack trace). No `tool_start` / `tool_end` / `sources` events
   * are emitted because no execution occurred.
   */
  private async *appendBlockedToolResult(
    workingMessages: ProviderRequestMessage[],
    call: ResolvedToolCall["call"],
    toolName: string,
  ): AsyncGenerator<ChatOrchestrationEvent> {
    const syntheticContent =
      `Tool execution skipped: the per-turn execution limit for "${toolName}" has been reached. ` +
      `Continue using the information already available.`;

    const assistantMessage: ProviderRequestMessage = {
      role: "assistant",
      tool_calls: [
        {
          id: call.id,
          type: "function",
          function: { name: call.function.name, arguments: call.function.arguments },
        },
      ],
    };
    const toolResultMessage: ProviderRequestMessage = {
      role: "tool",
      tool_call_id: call.id,
      content: syntheticContent,
    };
    workingMessages.push(assistantMessage, toolResultMessage);
  }

  /**
   * Build the internal assistant tool-call and `role: "tool"` messages that
   * follow the given base messages, budgeting the tool-result content against
   * the context window and truncating if needed. The base conversation (which
   * already contains every prior round's tool interactions) is never displaced;
   * only the tool-result *body* is the thing budgeted/shrunk.
   *
   * Reused for every tool execution in the multi-step loop. The budget is
   * recomputed each round against the full request, so every prior tool-call and
   * tool-result message counts against the room available to the next result
   * (step 42): a chain of tools shares one finite, cumulative input budget
   * instead of each getting an independent full-size allowance.
   */
  private async buildToolResultMessages(
    baseMessages: ProviderRequestMessage[],
    call: ResolvedToolCall["call"],
    result: ToolExecutionResult,
    turnSources: TurnSourceAccumulator,
    contextSizeTokens?: number,
  ): Promise<{
    assistantMessage: ProviderRequestMessage;
    toolResultMessage: ProviderRequestMessage;
    /**
     * The sources actually delivered to the model, as untrusted `{ title, url }`
     * candidates each carrying a turn-local id drawn from the shared allocator
     * (both web search and fetch_url). The ids equal the `[N]` references the
     * model sees in the tool-result body, so the metadata never disagrees with
     * them. The accumulator sanitizes and deduplicates these.
     */
    deliveredSources: DeliveredSource[];
  }> {
    const toolContent = result.content;

    // The two internal messages we are about to append. The tool-result *body*
    // is budgeted, so — until we know how much fits — we reserve the mandatory
    // omission fallback as its content. Keeping the fallback inside the fixed
    // estimate guarantees its token cost is never dropped out from under the
    // budget: even when no room remains for the real payload, the final request
    // stays within the configured context target.
    const assistantMessage: ProviderRequestMessage = {
      role: "assistant",
      tool_calls: [
        {
          id: call.id,
          type: "function",
          function: { name: call.function.name, arguments: call.function.arguments },
        },
      ],
    };
    const fallbackToolResultMessage: ProviderRequestMessage = {
      role: "tool",
      tool_call_id: call.id,
      content: TOOL_RESULT_CONTEXT_OMISSION_TEXT,
    };

    // Fixed content: the base conversation (all prior rounds, with their full
    // tool-call/tool-result structure) plus the two internal messages above.
    // The tool-result *body* is deliberately excluded so it is the only thing
    // budgeted/shrunk. Estimating the messages as complete provider messages
    // (not just their `content`) means prior assistant `tool_calls` and prior
    // tool results genuinely count against the budget.
    const fixedMessages: ProviderRequestMessage[] = [
      ...baseMessages,
      assistantMessage,
      fallbackToolResultMessage,
    ];
    const messageTokens = estimateProviderMessagesTokens(fixedMessages);

    // Without a configured context window there is no budget to apply: keep the
    // full tool result. Only when `contextSizeTokens` is provided is the result
    // budgeted and possibly truncated/omitted.
    const budget =
      contextSizeTokens === undefined
        ? {
            includedToolCharacters: toolContent.length,
            originalToolCharacters: toolContent.length,
            truncated: false,
          }
        : calculateToolResultBudget({
            maxTokens: contextSizeTokens,
            messageTokens,
            toolResultCharacters: toolContent.length,
          });

    // Choose the actual tool-result body:
    // - fits entirely  -> keep the real content (replacing the reserved fallback);
    // - truncated       -> keep as much of the real content as fits, at a section
    //                     boundary and preserving any structural header;
    // - no room at all  -> keep the harness omission fallback (already reserved
    //                     in `messageTokens`, so nothing extra is added).
    let toolResultContent = budget.truncated
      ? budget.includedToolCharacters > 0
        ? truncateContentPreservingStructure(toolContent, budget.includedToolCharacters)
        : TOOL_RESULT_CONTEXT_OMISSION_TEXT
      : toolContent;

    // The sources actually delivered to the model, as untrusted `{ title, url }`
    // candidates with an optional stable id. Delivery is always derived from
    // harness structure, never from a substring search of the untrusted body:
    //   - web search: ids whose known `[id]` block fits the (budgeted) content;
    //   - fetch url:  a single source, delivered iff at least some real page text
    //                 (offset past the harness-authored header) entered the budget.
    const deliveredSources: DeliveredSource[] = [];

    if (typeof result.metadata?.sourceContentStart === "number") {
      // fetch_url-style: one source, delivered iff real page text entered the
      // budget (`includedToolCharacters` past the header offset). An omitted
      // result (0 characters) or a header-only result (nothing past the header)
      // yields no delivered source.
      const contentStart = result.metadata.sourceContentStart;
      if (budget.includedToolCharacters > contentStart) {
        const candidate = sanitizeSourceCandidate(result.metadata.source);
        if (candidate) {
          deliveredSources.push(candidate);
        }
      }
    } else {
      // web_search-style: ids whose known `[id]` block actually entered the
      // (possibly truncated or omitted) content sent to the model. The set is
      // derived from complete block boundaries, not from a substring search of
      // the (untrusted) body. When the payload was omitted, no block is present,
      // so no source is reported as delivered.
      const structuredSources = toolContent.startsWith(WEB_SEARCH_UNTRUSTED_CONTENT_MARKER)
        ? toStructuredSources(result.metadata?.sources)
        : [];
      const deliveredIds = deliveredSourceIds(structuredSources, toolResultContent);

      // Assign the model-visible block ids from the shared turn-local allocator
      // instead of the tool's per-call `[1]`, `[2]`, … sequence: that sequence
      // restarts on each call and would collide with a fetch_url id assigned
      // earlier in the turn. The allocated ids are used in BOTH the structured
      // metadata pushed below and the blocks rewritten here, so the `[N]` the
      // model sees always matches the source metadata.
      const deliveredBlocks: WebSearchSource[] = [];
      for (const source of structuredSources) {
        if (!deliveredIds.has(source.id)) {
          continue;
        }
        const id = turnSources.allocate();
        const candidate = sanitizeSourceCandidate({ title: source.title, url: source.url });
        if (candidate) {
          deliveredSources.push({ ...candidate, id });
        }
        deliveredBlocks.push({ ...source, id });
      }

      // Rewrite the delivered blocks to carry the allocated ids. The blocks are
      // regenerated from the structured metadata (never by re-parsing the
      // untrusted body), so remote content is never rewritten. Only when at
      // least one block was delivered and the payload still starts with the
      // marker (i.e. it was not omitted) is the content rewritten.
      if (
        deliveredBlocks.length > 0 &&
        toolResultContent.startsWith(WEB_SEARCH_UNTRUSTED_CONTENT_MARKER)
      ) {
        toolResultContent =
          `${WEB_SEARCH_UNTRUSTED_CONTENT_MARKER}\n\n${deliveredBlocks
            .map(formatSourceBlock)
            .join("\n\n")}`;
      }
    }

    const toolResultMessage: ProviderRequestMessage = {
      role: "tool",
      tool_call_id: call.id,
      content: toolResultContent,
    };

    return {
      assistantMessage,
      toolResultMessage,
      deliveredSources,
    };
  }

  /**
   * Consume one model round to completion, returning what happened. Text deltas
   * are buffered (never yielded) so the caller can decide whether to flush or
   * discard them. Throws a normalized AppError on a provider parse error.
   */
  private async runModelRound(opts: {
    providerConfig: ProviderConfig;
    messages: ProviderRequestMessage[];
    signal?: AbortSignal;
    tools?: readonly ToolDefinition[];
    toolChoice: "auto";
  }): Promise<RoundOutcome> {
    const stream = await this.client.chatStream(
      opts.providerConfig,
      opts.messages,
      { tools: opts.tools, toolChoice: opts.toolChoice, signal: opts.signal },
    );

    const parser = new SseParser({ signal: opts.signal });
    const reader = stream.getReader();

    const textDeltas: string[] = [];
    let toolCalls: AccumulatedToolCall[] | undefined;
    let parseErrorMessage: string | undefined;

    try {
      for await (const event of parser.parse(reader)) {
        // Abort surfaces as an "error" event from the parser; treat cancellation
        // as silent and stop before doing any further work.
        if (opts.signal?.aborted) {
          return { status: "cancelled" };
        }
        if (event.type === "delta") {
          textDeltas.push(event.text);
        } else if (event.type === "tool_calls") {
          toolCalls = event.toolCalls;
        } else if (event.type === "error") {
          parseErrorMessage = event.message;
        }
        // "done" needs no handling; the loop ends when the stream completes.
      }
    } finally {
      // A round can end early (abort, malformed response, or consumer
      // abandonment). The parse() generator does not cancel the reader, so
      // release the provider body and its lock here to avoid leaving the
      // response active until the provider timeout.
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }

    if (opts.signal?.aborted) {
      return { status: "cancelled" };
    }
    if (parseErrorMessage !== undefined) {
      throw normalizeError(
        new ProviderClientError(
          OpenAICompatibleClient.ErrorType.MALFORMED_RESPONSE,
          parseErrorMessage,
        ),
      );
    }
    if (toolCalls) {
      return { status: "tool_calls", toolCalls };
    }
    return { status: "done", textDeltas };
  }

  /**
   * Stream a model round progressively, forwarding deltas and the final `done`
   * to the caller, with no buffering.
   *
   * Used for:
   *   - a normal no-tools pass-through;
   *   - the forced final no-tools round after the tool-execution cap is reached.
   *
   * Unexpected tool calls are rejected through the existing safe error path.
   */
  private async *streamRoundLive(opts: {
    providerConfig: ProviderConfig;
    messages: ProviderRequestMessage[];
    signal?: AbortSignal;
  }): AsyncGenerator<ChatOrchestrationEvent> {
    const stream = await this.client.chatStream(
      opts.providerConfig,
      opts.messages,
      { signal: opts.signal },
    );

    const parser = new SseParser({ signal: opts.signal });
    const reader = stream.getReader();

    try {
      for await (const event of parser.parse(reader)) {
        // Cancellation is silent: stop without emitting `done` or an error.
        if (opts.signal?.aborted) {
          return;
        }
        if (event.type === "delta") {
          yield { type: "delta", text: sanitizeSseData(event.text) };
        } else if (event.type === "tool_calls") {
          // This round runs with no tools attached (a normal no-tools
          // pass-through or the forced final no-tools round). Any tool call is a
          // protocol violation — a provider trying to open another tool round —
          // and is rejected rather than ignored.
          throw new AppError({
            code: "TOOL_CALL_LIMIT_EXCEEDED",
            statusCode: 502,
            message: "The model returned a tool call when no tools were available.",
          });
        } else if (event.type === "done") {
          yield { type: "done" };
        } else if (event.type === "error") {
          // A provider parse error on the final round is a real failure, not a
          // cancellation, so surface it as a normalized AppError.
          throw normalizeError(
            new ProviderClientError(
              OpenAICompatibleClient.ErrorType.MALFORMED_RESPONSE,
              event.message,
            ),
          );
        }
      }
    } finally {
      // Release the provider body and reader lock on any early exit (abort,
      // tool-limit, malformed response, or consumer abandonment) so the
      // response is not left active until the provider timeout.
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
