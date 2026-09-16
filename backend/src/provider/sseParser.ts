/**
 * SSE (Server-Sent Events) parser for OpenAI-compatible streaming responses.
 *
 * Reads raw bytes from the upstream provider and emits structured events:
 *   - `delta` — a text chunk extracted from a `data:` field
 *   - `done`  — the `[DONE]` marker was received
 *   - `error` — malformed input or EOF without `[DONE]`
 *
 * Handles:
 *   - Arbitrary chunk boundaries (an SSE event may span multiple chunks)
 *   - Comment lines (`: ...`) are silently ignored
 *   - Multiple SSE events in a single chunk
 *   - Malformed events (logged, skipped)
 *   - EOF without `[DONE]` → `error` event
 *
 * The parser is intentionally independent of the provider client so it can
 * be unit-tested with synthetic, fragmented, or malformed input.
 */

// ── Event types ──────────────────────────────────────────────────────────────

/** A text delta extracted from a `data:` SSE field. */
export interface SseDelta {
  type: "delta";
  text: string;
}

/** The `[DONE]` marker was received. Stream is complete. */
export interface SseDone {
  type: "done";
}

/**
 * A model tool call accumulated from streamed `delta.tool_calls` fragments.
 *
 * `function.arguments` is the raw concatenated JSON text: the parser never
 * parses it (parsing happens in a later orchestration step). `name` is the
 * concatenated function name; `id` is set once when the provider sends it.
 */
export interface AccumulatedToolCall {
  index: number;
  id?: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * A completed set of model tool calls, emitted when the stream reports
 * `finish_reason: "tool_calls"`. This is distinct from a normal text
 * completion so callers can tell tool requests apart from assistant text.
 */
export interface SseToolCalls {
  type: "tool_calls";
  toolCalls: AccumulatedToolCall[];
}

/** An error encountered during parsing. */
export interface SseError {
  type: "error";
  message: string;
}

/** Union of all events emitted by the parser. */
export type SseEvent = SseDelta | SseDone | SseToolCalls | SseError;

// ── Parsed SSE payload (lenient) ────────────────────────────────────────────

/**
 * Lenient shape of a parsed OpenAI streaming JSON chunk. Only the fields the
 * parser reads are declared; everything else is ignored.
 */
interface ParsedSseData {
  choices?: Array<{
    delta?: {
      content?: unknown;
      tool_calls?: Array<unknown>;
    };
    // finish_reason lives at the choice level in the OpenAI contract (the final
    // delta carries it alongside an empty delta object).
    finish_reason?: unknown;
  }>;
}

// ── Parser configuration ────────────────────────────────────────────────────

export interface SseParserOptions {
  /**
   * Called when the parser encounters a malformed SSE event.
   * Defaults to a no-op. Set to a logger for debugging.
   */
  onWarning?: (message: string) => void;

  /**
   * Optional abort signal to cancel parsing.
   * When aborted, the parser yields an error event and stops.
   */
  signal?: AbortSignal;
}

// ── Parser class ─────────────────────────────────────────────────────────────

/**
 * Incremental SSE parser that converts a byte stream into structured events.
 *
 * Usage:
 *   const parser = new SseParser();
 *   for await (const event of parser.parse(reader)) {
 *     if (event.type === "delta") console.log(event.text);
 *   }
 */
export class SseParser {
  /** Accumulates bytes across reads until a complete SSE event is available. */
  private buffer = "";

  /**
   * Single streaming {@link TextDecoder} for the whole byte stream. Keeping one
   * instance and decoding each chunk with `{ stream: true }` lets multibyte
   * UTF-8 sequences that straddle read boundaries reassemble correctly;
   * decoding every chunk with a fresh decoder would insert replacement
   * characters at split boundaries and corrupt the accumulated value.
   */
  private readonly decoder = new TextDecoder();

  /** Tracks whether [DONE] marker was received (stream completed successfully). */
  private receivedDone = false;

  /**
   * Accumulates tool calls by their `index` as `delta.tool_calls` fragments
   * arrive across chunks. Kept instance-scoped for the lifetime of one stream.
   */
  private readonly toolCalls = new Map<number, AccumulatedToolCall>();

  private readonly options: Required<SseParserOptions>;

  constructor(options: SseParserOptions = {}) {
    this.options = {
      onWarning: options.onWarning ?? (() => {}),
      signal: options.signal ?? ({} as AbortSignal),
    };
  }

  /**
   * Feed raw bytes into the parser and yield events as they become available.
   *
   * The returned async generator completes when:
   *   - `[DONE]` is received → yields `SseDone` then closes
   *   - EOF is reached → yields `SseError` (unless `[DONE]` was already seen)
   *   - An unrecoverable parse error occurs → yields `SseError`
   *   - Abort signal is triggered → yields `SseError` and stops
   */
  async *parse(
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): AsyncGenerator<SseEvent, void, undefined> {
    while (true) {
      // Check abort signal before each read
      if (this.options.signal?.aborted) {
        yield {
          type: "error",
          message: "Stream aborted",
        };
        return;
      }

      const { value, done } = await reader.read();

      if (done) {
        // Flush any bytes still buffered in the streaming decoder (a trailing
        // incomplete multibyte sequence at EOF; normally empty for a well-formed
        // stream) before parsing the remaining buffer.
        const trailing = this.decoder.decode();
        if (trailing.length > 0) {
          this.buffer += trailing;
        }

        // Stream ended. If we have buffered data, flush it first.
        if (this.buffer.length > 0) {
          const events = this.flushBuffer();
          for (const event of events) {
            yield event;
            if (event.type === "done" || event.type === "error") {
              return;
            }
          }
        }

        // EOF without [DONE] → error (per project rules)
        if (!this.receivedDone) {
          yield {
            type: "error",
            message: "Stream ended without [DONE]",
          };
        }
        return;
      }

      if (value) {
        // Decode bytes to string and append to buffer. Streaming mode keeps
        // incomplete multibyte sequences buffered internally across reads.
        const text = this.decoder.decode(value, { stream: true });
        this.buffer += text;

        // Parse and yield all complete events from the buffer
        const events = this.flushBuffer();
        for (const event of events) {
          yield event;
          if (event.type === "done" || event.type === "error") {
            return;
          }
        }
      }
    }
  }

  /**
   * Process the buffer and extract all complete SSE events.
   * Any incomplete event at the end is kept in the buffer for the next call.
   */
  private flushBuffer(): SseEvent[] {
    const events: SseEvent[] = [];
    const lines = this.buffer.split("\n");

    // SSE events are separated by double newlines (\n\n)
    // We accumulate lines until we see an empty line, which marks the end of an event
    let currentEventLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line === "") {
        // Empty line → end of current SSE event
        if (currentEventLines.length > 0) {
          const event = this.parseSseEvent(currentEventLines);
          if (event) {
            events.push(event);
          }
          currentEventLines = [];
        }
      } else {
        currentEventLines.push(line);
      }
    }

    // If there are remaining lines, they form an incomplete event.
    // Keep them in the buffer for the next read.
    if (currentEventLines.length > 0) {
      this.buffer = currentEventLines.join("\n");
    } else {
      // All events were complete; clear the buffer
      this.buffer = "";
    }

    return events;
  }

  /**
   * Parse a single SSE event from its constituent lines.
   * Returns null if the event is malformed or should be ignored.
   */
  private parseSseEvent(lines: string[]): SseEvent | null {
    let data = "";

    for (const line of lines) {
      // Comment line — ignore
      if (line.startsWith(":")) {
        continue;
      }

      // Parse field: value
      const colonIndex = line.indexOf(":");
      if (colonIndex === -1) {
        this.options.onWarning(`Malformed SSE line (no colon): "${line}"`);
        continue;
      }

      const field = line.substring(0, colonIndex).trim();
      const value = line.substring(colonIndex + 1).trimStart();

      switch (field) {
        case "data":
          data += value;
          break;
        case "event":
        case "id":
          // We don't use event IDs or custom event types, but we parse them to be spec-compliant
          break;
        default:
          // Unknown field — ignore per spec
          break;
      }
    }

    // Handle [DONE] marker
    if (data === "[DONE]") {
      this.receivedDone = true;
      return { type: "done" };
    }

    // If we have data, try to extract text delta or tool calls
    if (data.length > 0) {
      let parsed: ParsedSseData;
      try {
        parsed = JSON.parse(data) as ParsedSseData;
      } catch {
        // Not valid JSON — treat the raw data as the delta text. Raw text
        // streams cannot carry tool calls, so no accumulation happens here.
        return { type: "delta", text: data };
      }

      const choices = Array.isArray(parsed.choices) ? parsed.choices : [];

      // Accumulate streamed tool calls by index before deciding the event.
      let toolCallsFinishReason = false;
      for (const choice of choices) {
        const delta = choice?.delta;
        const toolCallFragments = Array.isArray(delta?.tool_calls)
          ? delta.tool_calls
          : [];
        for (const fragment of toolCallFragments) {
          this.accumulateToolCall(fragment);
        }
        if (choice?.finish_reason === "tool_calls") {
          toolCallsFinishReason = true;
        }
      }

      // A tool_calls finish reason is a completed tool request, not a normal
      // text completion. Emit it distinctly and reset accumulation so a stray
      // repeated finish reason cannot re-emit an empty result.
      if (toolCallsFinishReason && this.toolCalls.size > 0) {
        const toolCalls = Array.from(this.toolCalls.values()).sort((a, b) =>
          a.index - b.index,
        );
        this.toolCalls.clear();
        return { type: "tool_calls", toolCalls };
      }

      // Existing normal-text path (choices[0].delta.content). Content is a
      // string in the OpenAI contract; non-string values are ignored.
      const content = choices[0]?.delta?.content;
      if (typeof content === "string") {
        return { type: "delta", text: content };
      }

      // If JSON parsing succeeded but neither content nor tool calls were
      // found, ignore the event (e.g., role or finish_reason deltas).
      return null;
    }

    // No data — event without content, ignore
    return null;
  }

  /**
   * Accumulate a single `delta.tool_calls` fragment into the per-index
   * accumulator. `name` and `arguments` are concatenated (they may be split
   * across chunks); `id` is set once when first seen. Malformed fragments are
   * ignored rather than propagating arbitrary values.
   */
  private accumulateToolCall(fragment: unknown): void {
    // A `delta.tool_calls` array may carry invalid entries (null, strings,
    // numbers, arrays, ...). Accessing a property on null throws, and any
    // primitive is an invalid fragment, so ignore everything that is not a
    // non-null object before the structured checks below.
    if (fragment === null || typeof fragment !== "object") {
      return;
    }

    const entry = fragment as {
      index?: unknown;
      id?: unknown;
      type?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };

    if (typeof entry.index !== "number" || !Number.isInteger(entry.index)) {
      return;
    }

    // A fragment without any meaningful field (function/id/type) is ignored
    // rather than creating an empty accumulator that would emit a garbage tool
    // call when the finish reason arrives.
    const hasMeaningfulData =
      entry.function != null || entry.id != null || entry.type != null;
    if (!hasMeaningfulData) {
      return;
    }

    let call = this.toolCalls.get(entry.index);
    if (!call) {
      call = { index: entry.index, type: "function", function: { name: "", arguments: "" } };
      this.toolCalls.set(entry.index, call);
    }

    if (typeof entry.id === "string" && entry.id.length > 0 && call.id === undefined) {
      call.id = entry.id;
    }

    const fn = entry.function;
    if (!fn) {
      return;
    }

    if (typeof fn.name === "string" && fn.name.length > 0) {
      call.function.name += fn.name;
    }
    if (typeof fn.arguments === "string") {
      call.function.arguments += fn.arguments;
    }
  }
}

// ── Convenience function ────────────────────────────────────────────────────

/**
 * Parse an entire stream at once, returning all events in order.
 * Useful for testing and non-streaming contexts.
 */
export async function parseSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options: SseParserOptions = {},
): Promise<SseEvent[]> {
  const parser = new SseParser(options);
  const events: SseEvent[] = [];
  for await (const event of parser.parse(reader)) {
    events.push(event);
    if (event.type === "error") {
      break;
    }
  }
  return events;
}
