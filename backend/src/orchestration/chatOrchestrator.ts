import type { ChatMessage } from "../provider/schemas.js";
import type { ProviderClient, ProviderRequestMessage } from "../provider/types.js";
import type { ProviderConfig } from "../provider/schemas.js";
import { OpenAICompatibleClient, ProviderClientError } from "../provider/client.js";
import { SseParser, type AccumulatedToolCall } from "../provider/sseParser.js";
import type { ToolDefinition, ToolExecutionResult, ToolRegistry } from "../tools/types.js";
import type { SourceRef } from "../tools/sourceSanitization.js";
import { sanitizeSources } from "../tools/sourceSanitization.js";
import { normalizeError, AppError } from "../utils/errorHandler.js";
import { estimateTokens } from "../context/token-estimate.js";
import {
  calculateToolResultBudget,
  truncateContentPreservingStructure,
} from "../context/toolResultBudget.js";
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
// NOTE (temporary, step 42): tool results are budgeted per-execution against
// the full input budget. Step 42 makes the budget generic across multiple
// accumulated results.

/** Maximum number of model rounds in a single user turn (tools + final answer). */
export const MAX_MODEL_ROUNDS = 4;

/** Maximum number of executed tools in a single user turn. */
export const MAX_TOOL_EXECUTIONS_PER_TURN = 3;

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

    // Two independent counters, kept separate for legibility and so step 41 can
    // extend their semantics without re-deriving one from the other.
    let modelRoundCount = 0;
    let toolExecutionCount = 0;
    // Tools stay available until the execution cap is reached; after that the
    // final round is sent without tool definitions.
    let toolsAvailable = true;

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

      // round.status === "tool_calls": execute one tool, then loop.
      yield* this.executeToolRound(input, workingMessages, round.toolCalls);

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
   * Resolve, validate and execute a single tool call from one buffered model
   * round, appending the provider-compatible assistant tool-call and
   * `role: "tool"` result messages to `workingMessages`, and yielding the
   * `tool_start` / `tool_end` / `sources` lifecycle events in order.
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
  ): AsyncGenerator<ChatOrchestrationEvent> {
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

    // The tool has started: emit tool_start exactly once, immediately before
    // execution. The event is generic (tool name only) so it stays valid for
    // any tool, not just web search.
    yield { type: "tool_start", name: tool.definition.name };

    // Execute. The same cancellation signal reaches the tool.
    let result: ToolExecutionResult;
    try {
      result = await tool.execute(args, { signal: input.signal });
    } catch (error) {
      // Cancellation during execution: no further round, silent.
      if (input.signal?.aborted) {
        return;
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
    // start it.
    if (input.signal?.aborted) {
      return;
    }

    // Append the internal assistant tool-call / tool-result messages to the
    // working list (budgeting the tool-result body against the context window).
    const { assistantMessage, toolResultMessage, delivered } =
      await this.buildToolResultMessages(
        workingMessages,
        call,
        result,
        input.contextSizeTokens,
      );
    workingMessages.push(assistantMessage, toolResultMessage);

    // Emit the tool lifecycle tail: only the sources whose blocks actually
    // entered the model's context (see {@link buildToolResultMessages}), so a
    // source emitted to the UI but never sent to the model is not surfaced.
    const sanitizedSources = sanitizeSources(result.metadata?.sources);
    const deliveredSources = sanitizedSources.filter((source) => delivered.has(source.id));
    yield { type: "tool_end", name: tool.definition.name };
    yield { type: "sources", sources: deliveredSources };
  }

  /**
   * Build the internal assistant tool-call and `role: "tool"` messages that
   * follow the given base messages, budgeting the tool-result content against
   * the context window and truncating if needed. The base conversation (which
   * already contains every prior round's tool interactions) is never displaced;
   * only the tool-result *body* is the thing budgeted/shrunk.
   *
   * Reused for every tool execution in the multi-step loop (step 40); step 42
   * will make the budget generic across multiple accumulated results.
   */
  private async buildToolResultMessages(
    baseMessages: ProviderRequestMessage[],
    call: ResolvedToolCall["call"],
    result: ToolExecutionResult,
    contextSizeTokens?: number,
  ): Promise<{ assistantMessage: ProviderRequestMessage; toolResultMessage: ProviderRequestMessage; delivered: Set<number> }> {
    const webContent = result.content;

    // Fixed content: the base conversation (all prior rounds) plus the overhead
    // of the two internal messages. The tool-result *body* is deliberately
    // excluded so it is the only thing budgeted/shrunk.
    // Only messages that carry `content` contribute to the conversation text;
    // the assistant tool-call message (no `content`) is excluded from this
    // token estimate — its overhead is accounted for separately below.
    const conversationText = baseMessages
      .map((message) => ("content" in message ? message.content : ""))
      .join("\n");
    const assistantToolCallText = JSON.stringify({
      role: "assistant",
      tool_calls: [
        { id: call.id, type: "function", function: { name: call.function.name, arguments: call.function.arguments } },
      ],
    });
    const toolResultStructureText = JSON.stringify({ role: "tool", tool_call_id: call.id });
    const messageTokens = estimateTokens(
      conversationText + assistantToolCallText + toolResultStructureText,
    );

    // Without a configured context window there is no budget to apply: keep the
    // full web result. Only when `contextSizeTokens` is provided is the result
    // budgeted and possibly truncated.
    const budget =
      contextSizeTokens === undefined
        ? {
            includedWebCharacters: webContent.length,
            originalWebCharacters: webContent.length,
            truncated: false,
          }
        : calculateToolResultBudget({
            maxTokens: contextSizeTokens,
            messageTokens,
            webResultCharacters: webContent.length,
          });
    const toolResultContent = budget.truncated
      ? truncateContentPreservingStructure(webContent, budget.includedWebCharacters)
      : webContent;

    // Report only the sources whose blocks are actually present in the (possibly
    // truncated) content sent to the model, so the emitted `sources` event stays
    // consistent with the delivered content. The set is derived from complete
    // block boundaries, not from a substring search of the (untrusted) body.
    const structuredSources = webContent.startsWith(WEB_SEARCH_UNTRUSTED_CONTENT_MARKER)
      ? toStructuredSources(result.metadata?.sources)
      : [];
    const delivered = deliveredSourceIds(structuredSources, toolResultContent);

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
      content: toolResultContent,
    };

    return {
      assistantMessage,
      toolResultMessage,
      delivered,
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
