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

/** An error encountered during parsing. */
export interface SseError {
  type: "error";
  message: string;
}

/** Union of all events emitted by the parser. */
export type SseEvent = SseDelta | SseDone | SseError;

// ── Parser configuration ────────────────────────────────────────────────────

export interface SseParserOptions {
  /**
   * Called when the parser encounters a malformed SSE event.
   * Defaults to a no-op. Set to a logger for debugging.
   */
  onWarning?: (message: string) => void;
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

  /** Tracks whether [DONE] marker was received (stream completed successfully). */
  private receivedDone = false;

  private readonly options: Required<SseParserOptions>;

  constructor(options: SseParserOptions = {}) {
    this.options = {
      onWarning: options.onWarning ?? (() => {}),
    };
  }

  /**
   * Feed raw bytes into the parser and yield events as they become available.
   *
   * The returned async generator completes when:
   *   - `[DONE]` is received → yields `SseDone` then closes
   *   - EOF is reached → yields `SseError` (unless `[DONE]` was already seen)
   *   - An unrecoverable parse error occurs → yields `SseError`
   */
  async *parse(
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): AsyncGenerator<SseEvent, void, undefined> {
    while (true) {
      const { value, done } = await reader.read();

      if (done) {
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
        // Decode bytes to string and append to buffer
        const text = new TextDecoder().decode(value);
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

    // If we have data, try to extract text delta
    if (data.length > 0) {

      // Try to parse as JSON (OpenAI format: {"choices":[{"delta":{"content":"..."}}]})
      try {
        const parsed = JSON.parse(data) as {
          choices?: Array<{
            delta?: { content?: string };
          }>;
        };

        if (parsed.choices && parsed.choices.length > 0) {
          const content = parsed.choices[0].delta?.content;
          if (content !== undefined && content !== null) {
            return { type: "delta", text: content };
          }
        }
      } catch {
        // Not valid JSON — treat the raw data as the delta text
        return { type: "delta", text: data };
      }

      // If JSON parsing succeeded but no content was found, ignore the event
      // (e.g., role or finish_reason deltas without content)
      return null;
    }

    // No data — event without content, ignore
    return null;
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
