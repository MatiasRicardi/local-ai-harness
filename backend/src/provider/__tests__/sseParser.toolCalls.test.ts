import { describe, it, expect } from "vitest";
import type { SseEvent } from "../sseParser.js";
import { SseParser } from "../sseParser.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build one SSE event frame for a chat completion delta. `finishReason`
 * defaults to null (an ongoing chunk) and is used to signal the end of a
 * tool-call sequence with the string "tool_calls".
 */
function toolFrame(delta: unknown, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function createReader(text: string): ReadableStreamDefaultReader<Uint8Array> {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return stream.getReader();
}

/**
 * A reader that stays open until `end()` is called, so the byte-split test can
 * feed chunks incrementally.
 */
function createControllableReader() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream({
    start(c) {
      controller = c;
    },
  });
  return {
    reader: stream.getReader(),
    push(text: string): void {
      controller.enqueue(new TextEncoder().encode(text));
    },
    pushBytes(bytes: Uint8Array): void {
      controller.enqueue(bytes);
    },
    end(): void {
      controller.close();
    },
  };
}

/** Collect events until a terminal (done/error) event is emitted. */
async function collect(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<SseEvent[]> {
  const parser = new SseParser();
  const events: SseEvent[] = [];
  for await (const event of parser.parse(reader)) {
    events.push(event);
    if (event.type === "done" || event.type === "error") {
      break;
    }
  }
  return events;
}

// ── Tool call accumulation ───────────────────────────────────────────────────

describe("SseParser tool calls", () => {
  it("accumulates a complete tool call from a single frame", async () => {
    const reader = createReader(
      toolFrame({
        tool_calls: [
          {
            index: 0,
            id: "call_123",
            type: "function",
            function: { name: "web_search", arguments: '{"query":"hello"}' },
          },
        ],
      }, "tool_calls") + toolFrame({}) + "data: [DONE]\n\n",
    );

    const events = await collect(reader);
    const toolEvent = events.find((e) => e.type === "tool_calls");
    expect(toolEvent).toBeDefined();
    if (toolEvent?.type !== "tool_calls") {
      throw new Error("expected tool_calls event");
    }
    expect(toolEvent.toolCalls).toEqual([
      {
        index: 0,
        id: "call_123",
        type: "function",
        function: { name: "web_search", arguments: '{"query":"hello"}' },
      },
    ]);
    // finish_reason tool_calls still ends the stream with a normal done.
    expect(events[events.length - 1]).toEqual({ type: "done" });
  });

  it("does not JSON.parse arguments: the raw JSON text is preserved", async () => {
    // The argument JSON is streamed in fragments across separate tool_call
    // deltas. The parser must concatenate the raw text verbatim (no parsing).
    const argFragment1 = '{"qu';
    const argFragment2 = 'ery":"x" }';
    const reader = createReader(
      toolFrame({
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "web_search", arguments: argFragment1 },
          },
        ],
      }) +
        toolFrame({ tool_calls: [{ index: 0, function: { arguments: argFragment2 } }] }) +
        toolFrame({ tool_calls: [{ index: 0, function: { arguments: "" } }] }) +
        toolFrame({ finish_reason: "tool_calls" }, "tool_calls") +
        "data: [DONE]\n\n",
    );

    const events = await collect(reader);
    const toolEvent = events.find((e) => e.type === "tool_calls");
    expect(toolEvent?.type === "tool_calls").toBe(true);
    if (toolEvent?.type !== "tool_calls") {
      throw new Error("expected tool_calls event");
    }
    // Arguments arrive as several fragments and are concatenated verbatim.
    expect(toolEvent.toolCalls[0].function.arguments).toBe(argFragment1 + argFragment2);
  });

  it("accumulates a split function name across frames", async () => {
    const reader = createReader(
      toolFrame({ tool_calls: [{ index: 0, id: "c1", function: { name: "web", arguments: "" } }] }) +
        toolFrame({ tool_calls: [{ index: 0, function: { name: "_search", arguments: "" } }] }) +
        toolFrame({ finish_reason: "tool_calls" }, "tool_calls") +
        "data: [DONE]\n\n",
    );

    const events = await collect(reader);
    const toolEvent = events.find((e) => e.type === "tool_calls");
    expect(toolEvent?.type === "tool_calls").toBe(true);
    if (toolEvent?.type !== "tool_calls") {
      throw new Error("expected tool_calls event");
    }
    expect(toolEvent.toolCalls[0].function.name).toBe("web_search");
  });

  it("keeps multibyte UTF-8 intact when a read splits a character mid-sequence", async () => {
    // A function name and arguments containing multibyte characters (\u00f1 = 2
    // bytes, \U0001F600 = 4 bytes). A fresh decoder per read would insert
    // replacement characters at every split boundary; a single streaming
    // decoder reassembles them. The 1-byte pushes guarantee every multibyte
    // sequence straddles at least one read boundary.
    const frame = toolFrame(
      {
        tool_calls: [
          {
            index: 0,
            id: "call_\u00f1",
            type: "function",
            function: { name: "re_\U0001F600_cher", arguments: '{"q":"caf\u00e9"}' },
          },
        ],
      },
      "tool_calls",
    );
    const bytes = new TextEncoder().encode(frame);

    const control = createControllableReader();
    const parser = new SseParser();
    const iter = parser.parse(control.reader);
    const events: SseEvent[] = [];

    for (let i = 0; i < bytes.length; i += 1) {
      control.pushBytes(bytes.slice(i, i + 1));
    }
    control.pushBytes(new TextEncoder().encode("data: [DONE]\n\n"));
    control.end();

    for await (const event of iter) {
      events.push(event);
      if (event.type === "done" || event.type === "error") break;
    }

    const toolEvent = events.find((e) => e.type === "tool_calls");
    expect(toolEvent?.type === "tool_calls").toBe(true);
    if (toolEvent?.type !== "tool_calls") {
      throw new Error("expected tool_calls event");
    }
    // Reassembled verbatim: no replacement characters, valid argument JSON.
    expect(toolEvent.toolCalls[0].function.name).toBe("re_\U0001F600_cher");
    expect(toolEvent.toolCalls[0].function.arguments).toBe('{"q":"caf\u00e9"}');
  });

  it("accumulates multiple tool calls by index", async () => {
    const reader = createReader(
      toolFrame({
        tool_calls: [
          { index: 0, id: "a", function: { name: "web_search", arguments: '{"q":"1"}' } },
          { index: 1, id: "b", function: { name: "calc", arguments: '{"q":"2"}' } },
        ],
      }) +
        toolFrame({ finish_reason: "tool_calls" }, "tool_calls") +
        "data: [DONE]\n\n",
    );

    const events = await collect(reader);
    const toolEvent = events.find((e) => e.type === "tool_calls");
    expect(toolEvent?.type === "tool_calls").toBe(true);
    if (toolEvent?.type !== "tool_calls") {
      throw new Error("expected tool_calls event");
    }
    expect(toolEvent.toolCalls.map((t) => t.index)).toEqual([0, 1]);
    expect(toolEvent.toolCalls[1].function.name).toBe("calc");
  });

  it("emits the tool_calls result only when finish_reason tool_calls arrives", async () => {
    // The tool call delta arrives in an earlier frame; the finish reason in a
    // later one. No tool_calls event should be produced until the finish reason.
    const reader = createReader(
      toolFrame({ tool_calls: [{ index: 0, id: "c", function: { name: "web_search", arguments: "" } }] }) +
        toolFrame({ finish_reason: "tool_calls" }, "tool_calls") +
        "data: [DONE]\n\n",
    );

    const events = await collect(reader);
    expect(events.filter((e) => e.type === "tool_calls")).toHaveLength(1);
    expect(events[events.length - 1]).toEqual({ type: "done" });
  });

  it("ignores malformed tool_calls fragments (missing index)", async () => {
    const reader = createReader(
      toolFrame({
        tool_calls: [
          { function: { name: "web_search", arguments: "" } }, // no index
          { index: "not-a-number" }, // index not a number
        ],
      }) +
        toolFrame({ finish_reason: "tool_calls" }, "tool_calls") +
        "data: [DONE]\n\n",
    );

    const events = await collect(reader);
    // No valid tool call was accumulated, so no tool_calls result is emitted.
    expect(events.find((e) => e.type === "tool_calls")).toBeUndefined();
    expect(events[events.length - 1]).toEqual({ type: "done" });
  });

  it("ignores null and primitive tool_calls fragments without throwing", async () => {
    // A provider may emit invalid entries (null, string, number, array) alongside
    // a valid object. The parser must skip every non-object fragment instead of
    // throwing on `null.index`, and still accumulate the one valid call.
    const reader = createReader(
      toolFrame({
        tool_calls: [
          null,
          "x",
          5,
          ["a"],
          { index: 0, function: { name: "web_search", arguments: "" } },
        ],
      }) +
        toolFrame({ finish_reason: "tool_calls" }, "tool_calls") +
        "data: [DONE]\n\n",
    );

    const events = await collect(reader);
    const toolEvent = events.find((e) => e.type === "tool_calls");
    expect(toolEvent?.type === "tool_calls").toBe(true);
    if (toolEvent?.type !== "tool_calls") {
      throw new Error("expected tool_calls event");
    }
    expect(toolEvent.toolCalls).toEqual([
      { index: 0, type: "function", function: { name: "web_search", arguments: "" } },
    ]);
    expect(events[events.length - 1]).toEqual({ type: "done" });
  });

  it("does not emit tool_calls when finish_reason is tool_calls but nothing accumulated", async () => {
    const reader = createReader(
      toolFrame({ finish_reason: "tool_calls" }, "tool_calls") + "data: [DONE]\n\n",
    );
    const events = await collect(reader);
    expect(events.find((e) => e.type === "tool_calls")).toBeUndefined();
    expect(events[events.length - 1]).toEqual({ type: "done" });
  });

  it("regression: a normal text stream still yields only deltas and done", async () => {
    const reader = createReader(
      toolFrame({ content: "Hel" }) +
        toolFrame({ content: "lo" }) +
        toolFrame({ finish_reason: "stop" }, "stop") +
        "data: [DONE]\n\n",
    );

    const events = await collect(reader);
    const deltas = events.filter((e) => e.type === "delta");
    expect(deltas.map((e) => (e.type === "delta" ? e.text : ""))).toEqual(["Hel", "lo"]);
    expect(events[events.length - 1]).toEqual({ type: "done" });
    expect(events.find((e) => e.type === "tool_calls")).toBeUndefined();
  });

  it("regression: aborting yields an error event and stops", async () => {
    const control = createControllableReader();
    const controller = new AbortController();
    const parser = new SseParser({ signal: controller.signal });
    const iter = parser.parse(control.reader);

    controller.abort();

    const events: SseEvent[] = [];
    for await (const event of iter) {
      events.push(event);
      if (event.type === "error") break;
    }
    expect(events[0]).toEqual({ type: "error", message: "Stream aborted" });
  });
});
