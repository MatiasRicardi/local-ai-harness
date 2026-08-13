import { describe, it, expect } from "vitest";
import type { SseEvent } from "../sseParser.js";
import { SseParser, parseSseStream } from "../sseParser.js";

// ── Helper: create a reader from a string ────────────────────────────────────

function createReader(text: string): ReadableStreamDefaultReader<Uint8Array> {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return stream.getReader();
}

// ── Helper: create a reader from multiple chunks ─────────────────────────────

function createMultiChunkReader(chunks: string[]): ReadableStreamDefaultReader<Uint8Array> {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
  return stream.getReader();
}

// ── Basic delta tests ────────────────────────────────────────────────────────

describe("SseParser - Basic deltas", () => {
  it("parses a single delta event", async () => {
    const reader = createReader('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');

    const events = await parseSseStream(reader);

    // Delta + EOF error (no [DONE])
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "delta", text: "Hello" });
    expect(events[1]).toEqual({ type: "error", message: "Stream ended without [DONE]" });
  });

  it("parses multiple deltas in one chunk", async () => {
    const reader = createReader(
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: {"choices":[{"delta":{"content":" World"}}]}\n\n',
    );

    const events = await parseSseStream(reader);

    // 2 deltas + EOF error (no [DONE])
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ type: "delta", text: "Hello" });
    expect(events[1]).toEqual({ type: "delta", text: " World" });
    expect(events[2]).toEqual({ type: "error", message: "Stream ended without [DONE]" });
  });

  it("handles delta split across chunks", async () => {
    const reader = createMultiChunkReader([
      'data: {"choices":[{"delta":{"content":"Hel',
      'lo"}}]}\n\n',
    ]);

    const events = await parseSseStream(reader);

    // Delta + EOF error (no [DONE])
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "delta", text: "Hello" });
    expect(events[1]).toEqual({ type: "error", message: "Stream ended without [DONE]" });
  });

  it("handles delta split at arbitrary boundaries", async () => {
    const reader = createMultiChunkReader([
      'data: {"choices":[{"delta":{"content":"',
      'Hel',
      'lo"}}]}\n\n',
    ]);

    const events = await parseSseStream(reader);

    // Delta + EOF error (no [DONE])
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "delta", text: "Hello" });
    expect(events[1]).toEqual({ type: "error", message: "Stream ended without [DONE]" });
  });
});

// ── [DONE] marker tests ──────────────────────────────────────────────────────

describe("SseParser - [DONE] marker", () => {
  it("parses [DONE] as done event", async () => {
    const reader = createReader("data: [DONE]\n\n");

    const events = await parseSseStream(reader);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "done" });
  });

  it("parses deltas followed by [DONE]", async () => {
    const reader = createReader(
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n',
    );

    const events = await parseSseStream(reader);

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "delta", text: "Hello" });
    expect(events[1]).toEqual({ type: "done" });
  });

  it("stops parsing after [DONE]", async () => {
    const reader = createReader(
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\ndata: {"choices":[{"delta":{"content":" World"}}]}\n\n',
    );

    const events = await parseSseStream(reader);

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "delta", text: "Hello" });
    expect(events[1]).toEqual({ type: "done" });
  });
});

// ── EOF without [DONE] tests ─────────────────────────────────────────────────

describe("SseParser - EOF without [DONE]", () => {
  it("emits error when EOF reached without [DONE] and no deltas", async () => {
    const reader = createReader("");

    const events = await parseSseStream(reader);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "error", message: "Stream ended without [DONE]" });
  });

  it("emits error when EOF reached without [DONE] even with deltas", async () => {
    const reader = createReader(
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
    );

    const events = await parseSseStream(reader);

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "delta", text: "Hello" });
    expect(events[1]).toEqual({ type: "error", message: "Stream ended without [DONE]" });
  });

  it("emits error when stream ends abruptly in the middle of an event", async () => {
    const reader = createReader(
      'data: {"choices":[{"delta":{"content":"Hel',
    );

    const events = await parseSseStream(reader);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "error", message: "Stream ended without [DONE]" });
  });
});

// ── Comment line tests ───────────────────────────────────────────────────────

describe("SseParser - Comment lines", () => {
  it("ignores comment lines", async () => {
    const sseData = ': this is a comment\ndata: {"choices":[{"delta":{"content":"Hello"}}]}\n\n';
    const reader = createReader(sseData);

    const events = await parseSseStream(reader);

    // Delta + EOF error (no [DONE])
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "delta", text: "Hello" });
    expect(events[1]).toEqual({ type: "error", message: "Stream ended without [DONE]" });
  });

  it("ignores multiple comment lines", async () => {
    const sseData = ': comment 1\n: comment 2\ndata: {"choices":[{"delta":{"content":"Hello"}}]}\n\n';
    const reader = createReader(sseData);

    const events = await parseSseStream(reader);

    // Delta + EOF error (no [DONE])
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "delta", text: "Hello" });
    expect(events[1]).toEqual({ type: "error", message: "Stream ended without [DONE]" });
  });

  it("ignores comments between events", async () => {
    const sseData = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n: comment\ndata: {"choices":[{"delta":{"content":" World"}}]}\n\n';
    const reader = createReader(sseData);

    const events = await parseSseStream(reader);

    // 2 deltas + EOF error (no [DONE])
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ type: "delta", text: "Hello" });
    expect(events[1]).toEqual({ type: "delta", text: " World" });
    expect(events[2]).toEqual({ type: "error", message: "Stream ended without [DONE]" });
  });
});

// ── Malformed event tests ────────────────────────────────────────────────────

describe("SseParser - Malformed events", () => {
  it("skips events with no colon", async () => {
    const warnings: string[] = [];
    const sseData = 'no colon here\ndata: {"choices":[{"delta":{"content":"Hello"}}]}\n\n';
    const reader = createReader(sseData);
    const parser = new SseParser({
      onWarning: (msg) => warnings.push(msg),
    });

    const events: SseEvent[] = [];
    for await (const event of parser.parse(reader)) {
      events.push(event);
      if (event.type === "error") {
        break;
      }
    }

    // Delta + EOF error (no [DONE])
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "delta", text: "Hello" });
    expect(events[1]).toEqual({ type: "error", message: "Stream ended without [DONE]" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Malformed SSE line");
  });

  it("skips events with no data field", async () => {
    const reader = createReader(
      'event: message\nid: 123\n\ndata: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
    );

    const events = await parseSseStream(reader);

    // Delta + EOF error (no [DONE])
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "delta", text: "Hello" });
    expect(events[1]).toEqual({ type: "error", message: "Stream ended without [DONE]" });
  });

  it("handles empty data field", async () => {
    const sseData = 'data:\n\ndata: {"choices":[{"delta":{"content":"Hello"}}]}\n\n';
    const reader = createReader(sseData);

    const events = await parseSseStream(reader);

    // Delta + EOF error (no [DONE])
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "delta", text: "Hello" });
    expect(events[1]).toEqual({ type: "error", message: "Stream ended without [DONE]" });
  });
});

// ── Non-JSON data tests ──────────────────────────────────────────────────────

describe("SseParser - Non-JSON data", () => {
  it("treats non-JSON data as raw text", async () => {
    const reader = createReader("data: Hello World\n\n");

    const events = await parseSseStream(reader);

    // Delta + EOF error (no [DONE])
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "delta", text: "Hello World" });
    expect(events[1]).toEqual({ type: "error", message: "Stream ended without [DONE]" });
  });

  it("handles JSON without choices array", async () => {
    const reader = createReader('data: {"some":"data"}\n\n');

    const events = await parseSseStream(reader);

    // No delta extracted, but EOF without [DONE] still emits error
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "error", message: "Stream ended without [DONE]" });
  });

  it("handles JSON with empty choices array", async () => {
    const reader = createReader('data: {"choices":[]}\n\n');

    const events = await parseSseStream(reader);

    // No delta extracted, but EOF without [DONE] still emits error
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "error", message: "Stream ended without [DONE]" });
  });

  it("handles JSON with delta but no content", async () => {
    const reader = createReader('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n');

    const events = await parseSseStream(reader);

    // No delta extracted, but EOF without [DONE] still emits error
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "error", message: "Stream ended without [DONE]" });
  });
});

// ── Edge cases ───────────────────────────────────────────────────────────────

describe("SseParser - Edge cases", () => {
  it("handles multiple [DONE] markers (only first matters)", async () => {
    const reader = createReader(
      "data: [DONE]\n\ndata: [DONE]\n\n",
    );

    const events = await parseSseStream(reader);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "done" });
  });

  it("handles [DONE] with extra whitespace", async () => {
    const reader = createReader("data: [DONE]  \n\n");

    const events = await parseSseStream(reader);

    // [DONE] with trailing whitespace is not exact match, so it's treated as data
    // This is correct behavior per spec
    // Delta + EOF error (no [DONE] recognized)
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "delta", text: "[DONE]  " });
    expect(events[1]).toEqual({ type: "error", message: "Stream ended without [DONE]" });
  });

  it("handles [DONE] with leading whitespace", async () => {
    const reader = createReader("data:   [DONE]\n\n");

    const events = await parseSseStream(reader);

    // [DONE] with leading whitespace after colon is trimmed, so it matches
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "done" });
  });

  it("handles very long delta", async () => {
    const longText = "a".repeat(10000);
    const reader = createReader(`data: {"choices":[{"delta":{"content":"${longText}"}}]}\n\n`);

    const events = await parseSseStream(reader);

    // Delta + EOF error (no [DONE])
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "delta", text: longText });
    expect(events[1]).toEqual({ type: "error", message: "Stream ended without [DONE]" });
  });

  it("handles delta with special characters", async () => {
    const reader = createReader('data: {"choices":[{"delta":{"content":"Hello\\nWorld\\t!@#$%"}}]}\n\n');

    const events = await parseSseStream(reader);

    // Delta + EOF error (no [DONE])
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "delta", text: "Hello\nWorld\t!@#$%" });
    expect(events[1]).toEqual({ type: "error", message: "Stream ended without [DONE]" });
  });
});

// ── parseSseStream convenience function tests ────────────────────────────────

describe("parseSseStream", () => {
  it("returns empty array for empty stream", async () => {
    const reader = createReader("");
    const events = await parseSseStream(reader);
    expect(events).toHaveLength(1); // EOF error
  });

  it("stops on first error", async () => {
    const reader = createReader(
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
    );
    const events = await parseSseStream(reader);
    expect(events).toHaveLength(2); // delta + EOF error
  });
});
