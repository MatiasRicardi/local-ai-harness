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

// ── Chat orchestration loop ──────────────────────────────────────────────────
//
// A small, provider-agnostic orchestration layer that lets a model request a
// tool, executes it once, returns the result to the model, and streams the
// final answer. It knows nothing about any concrete provider (Tavily, …): it
// only depends on the generic {@link ToolRegistry}, the provider client, the
// context-budget helpers and the shared cancellation signal.
//
// Phase-2 hard limits:
//   - max tool calls per user turn = 1 (parallel calls unsupported);
//   - max model rounds = 2 (a second tool request is rejected, never retried).
//
// The orchestrator is intentionally decoupled from the HTTP layer and from any
// tool configuration: callers inject an already-configured registry. Step 31
// owns wiring it into `/api/chat/stream`.

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
  | { type: "tool_start"; name: string; query?: string }
  | { type: "tool_end"; name: string; resultCount: number }
  | { type: "sources"; sources: SourceRef[] };

/** Outcome of consuming one model round. */
type RoundOutcome =
  | { status: "cancelled" }
  | { status: "done"; textDeltas: string[] }
  | { status: "tool_calls"; toolCalls: AccumulatedToolCall[] };

function sanitizeSseData(text: string): string {
  return text.replace(/\u0000/g, "");
}

export class ChatOrchestrator {
  private readonly client: ProviderClient;

  constructor(client: ProviderClient) {
    this.client = client;
  }

  /**
   * Run one orchestrated turn, yielding the visible assistant stream.
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

    // Round 1 with tools: buffer first-round text until the tool choice is
    // resolved (the model may emit filler text such as "I'll search for that…"
    // before requesting a tool, which must not reach the user).
    const round1 = await this.runModelRound({
      providerConfig: input.providerConfig,
      messages: input.messages,
      signal: input.signal,
      tools: definitions,
      toolChoice: "auto",
    });

    if (round1.status === "cancelled") {
      // Cancellation is silent: no error, no second round.
      return;
    }

    if (round1.status === "tool_calls") {
      // Execute exactly one tool, then stream the final answer from round 2.
      yield* this.executeToolAndStreamFinal(input, round1.toolCalls);
      return;
    }

    // Normal first-round completion: flush the buffered text as the final answer.
    for (const delta of round1.textDeltas) {
      yield { type: "delta", text: sanitizeSseData(delta) };
    }
    yield { type: "done" };
  }

  /**
   * Round 1 outcome resolved into a tool execution + round 2 stream.
   *
   * Validates the accumulated tool call, parses its arguments only after the
   * call is complete, executes the tool once, builds the internal assistant
   * tool-call / tool-result messages (budgeting the web result against the
   * context window), and streams round 2 with no tools attached.
   */
  private async *executeToolAndStreamFinal(
    input: ChatOrchestrationInput,
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

    // The search has started: emit tool_start exactly once, immediately before
    // execution. The tool name comes from the tool definition (generic); the
    // query is included only when it is a plain string.
    const query =
      typeof args === "object" && args !== null && typeof (args as { query?: unknown }).query === "string"
        ? (args as { query: string }).query
        : undefined;
    yield query === undefined
      ? { type: "tool_start", name: tool.definition.name }
      : { type: "tool_start", name: tool.definition.name, query };

    // Execute. The same cancellation signal reaches the tool.
    let result: ToolExecutionResult;
    try {
      result = await tool.execute(args, { signal: input.signal });
    } catch (error) {
      // Cancellation during execution: no second round, silent.
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

    // Cancellation after the tool completed but before round 2: do not start it.
    if (input.signal?.aborted) {
      return;
    }

    // Success: emit the tool lifecycle tail before the final answer. The
    // sanitized sources are backend-grounded (only safe http(s) URLs with a
    // numeric id survive) and never carry `content`; `resultCount` equals the
    // number of sources actually emitted, including when that is zero.
    const sanitizedSources = sanitizeSources(result.metadata?.sources);
    yield { type: "tool_end", name: tool.definition.name, resultCount: sanitizedSources.length };
    yield { type: "sources", sources: sanitizedSources };

    const round2Messages = await this.buildRound2Messages(input, call, result);

    yield* this.streamRoundLive({
      providerConfig: input.providerConfig,
      messages: round2Messages,
      signal: input.signal,
    });
  }

  /**
   * Build the round-2 request: the original conversation followed by the two
   * internal orchestration messages. The tool-result content is budgeted
   * against the context window and truncated if needed; the current user
   * message is never displaced.
   */
  private async buildRound2Messages(
    input: ChatOrchestrationInput,
    call: ResolvedToolCall["call"],
    result: ToolExecutionResult,
  ): Promise<ProviderRequestMessage[]> {
    const webContent = result.content;

    // Fixed round-2 content: the original conversation plus the overhead of the
    // two internal messages. The tool-result *body* is deliberately excluded so
    // it is the only thing budgeted/shrunk.
    const conversationText = input.messages.map((message) => message.content).join("\n");
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
      input.contextSizeTokens === undefined
        ? {
            includedWebCharacters: webContent.length,
            originalWebCharacters: webContent.length,
            truncated: false,
          }
        : calculateToolResultBudget({
            maxTokens: input.contextSizeTokens,
            messageTokens,
            webResultCharacters: webContent.length,
          });
    const toolResultContent = budget.truncated
      ? truncateContentPreservingStructure(webContent, budget.includedWebCharacters)
      : webContent;

    const assistantToolCallMessage: ProviderRequestMessage = {
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

    return [...input.messages, assistantToolCallMessage, toolResultMessage];
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
   * Stream a model round live, forwarding deltas and the final `done` to the
   * caller. Used for the no-tools pass-through path and for round 2 (the final
   * visible answer), where no buffering is required.
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
          // This round runs with no tools attached (no-tools pass-through or
          // round 2). Any tool call is a protocol violation — a provider trying
          // to open a second tool round — and is rejected rather than ignored.
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
