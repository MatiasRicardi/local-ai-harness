/**
 * Deterministic, hermetic fake-provider SSE fixtures (Phase 4, Step 56).
 *
 * These builders produce the exact bytes an OpenAI-compatible provider puts on
 * the wire, so a test can drive the real `SseParser` with no network, no clock
 * and no randomness: the same fixture always serializes to identical frames.
 *
 * The canonical round sequences below mirror the transition table in
 * `docs/v1.3.0-contract.md` §7. They describe **provider input only** — nothing
 * here implements server behavior, and no fixture asserts a behavior that the
 * current code does not already have (Steps 58–62 add the rest).
 */

import { SseParser, type SseEvent } from "../../sseParser.js";

/** `finish_reason` values this project reasons about (any string is allowed upstream). */
export type FakeFinishReason = "stop" | "tool_calls" | "length" | "content_filter" | string;

/** One streamed `delta.tool_calls[]` entry, as an OpenAI-compatible server sends it. */
export interface FakeToolCallFragment {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

/** A labelled upstream round: the frames of one chat-completion stream plus its shape. */
export interface FakeRound {
  /** Human-readable label matching the contract table. */
  name: string;
  /** Every SSE frame of this round, in wire order (`[DONE]` last when present). */
  frames: string[];
  /** Tool-call fragments the round streams (counted, not parsed). */
  toolCallCount: number;
  /** Whether the round ends with a `data: [DONE]` marker (vs. transport EOF). */
  hasDoneMarker: boolean;
  /** The last non-null `finish_reason` the round carries, when it carries one. */
  finishReason?: FakeFinishReason | null;
}

/** Serialize one SSE frame exactly as a provider does (`data: <json>\n\n`). */
export function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** The `[DONE]` transport marker, the only non-JSON payload the parser accepts. */
export function doneFrame(): string {
  return "data: [DONE]\n\n";
}

/** A content chunk. `finishReason` defaults to `null` (an ongoing chunk). */
export function contentFrame(
  text: string,
  finishReason: FakeFinishReason | null = null,
): string {
  return sseFrame({
    choices: [{ index: 0, delta: { content: text }, finish_reason: finishReason }],
  });
}

/** A chunk that carries only a `finish_reason` (no content, no tool fragment). */
export function finishFrame(finishReason: FakeFinishReason): string {
  return sseFrame({
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  });
}

/**
 * A content chunk with the `finish_reason` property **absent** rather than present
 * and `null`. Most OpenAI-compatible servers omit the key on intermediate chunks, so
 * this is the shape they actually put on the wire. It is a separate builder because a
 * test that claims to cover a missing `finish_reason` must not be satisfied by a
 * fixture that sends `"finish_reason": null`.
 */
export function contentFrameOmittingFinishReason(text: string): string {
  return sseFrame({ choices: [{ index: 0, delta: { content: text } }] });
}

/** A streamed `delta.tool_calls[]` entry, split the way a real server splits it. */
export function toolCallFrame(
  fragment: FakeToolCallFragment,
  finishReason: FakeFinishReason | null = null,
): string {
  return sseFrame({
    choices: [{ index: 0, delta: { tool_calls: [fragment] }, finish_reason: finishReason }],
  });
}

/** Join frames into one wire payload. */
export function framesToText(frames: string[]): string {
  return frames.join("");
}

/**
 * Split a payload into fixed-size UTF-8 chunks. Used to place a chunk boundary
 * anywhere (inside a frame, inside a JSON string, inside a multibyte character).
 */
export function splitBytes(text: string, size = 7): Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(bytes.slice(offset, offset + size));
  }
  return chunks;
}

/** A reader that delivers the whole payload in one chunk and then ends. */
export function readerFromText(text: string): ReadableStreamDefaultReader<Uint8Array> {
  return readerFromChunks([new TextEncoder().encode(text)]);
}

/** A reader that delivers each byte chunk in order and then ends (transport EOF). */
export function readerFromChunks(chunks: Uint8Array[]): ReadableStreamDefaultReader<Uint8Array> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
  return stream.getReader();
}

/** Parse a round to its terminal event and return every event in order. */
export async function collectEvents(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<SseEvent[]> {
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

/** Parse a round both as one chunk and as small byte chunks (same result expected). */
export async function parseRound(round: FakeRound): Promise<{ single: SseEvent[]; sliced: SseEvent[] }> {
  const text = framesToText(round.frames);
  const single = await collectEvents(readerFromText(text));
  const sliced = await collectEvents(readerFromChunks(splitBytes(text, 5)));
  return { single, sliced };
}

// ── Canonical rounds (contract §7 labels) ────────────────────────────────────

/** A clean text answer: `finish_reason: "stop"` followed by `[DONE]`. */
export function answerRound(text = "Two plus two is four."): FakeRound {
  const frames = [contentFrame(text, "stop"), doneFrame()];
  return { name: "answer", frames, toolCallCount: 0, hasDoneMarker: true, finishReason: "stop" };
}

/**
 * A plain-text answer with **no** `finish_reason` anywhere, but a real `[DONE]`:
 * the documented compatibility case (contract §6).
 */
export function answerRoundWithoutFinishReason(text = "Sunny tomorrow."): FakeRound {
  const frames = [contentFrame(text), doneFrame()];
  return { name: "answer-without-finish-reason", frames, toolCallCount: 0, hasDoneMarker: true };
}

/**
 * The same shape as {@link answerRoundWithoutFinishReason}, but with the
 * `finish_reason` property **missing from every chunk** instead of present and
 * `null` — what most OpenAI-compatible servers actually send. Both metadata
 * records leave `finishReason` unset, meaning "this round never mentioned a
 * finish reason at all".
 */
export function answerRoundWithoutFinishReasonProperty(text = "Sunny tomorrow."): FakeRound {
  const frames = [contentFrameOmittingFinishReason(text), doneFrame()];
  return {
    name: "answer-without-finish-reason-property",
    frames,
    toolCallCount: 0,
    hasDoneMarker: true,
  };
}

/**
 * An answer whose text chunks each carry a `U+0000`. JSON escaping means the NUL
 * is not visible in {@link framesToText} output, so the guarantee has to be
 * asserted on what the layers emit after parsing: the parser forwards the NUL and
 * the SSE layers are the ones that must remove it.
 */
export function answerRoundWithNullCharacters(
  chunks: string[] = ["2 + 2 = \u0000 4", "I am \u0000 sure."],
): FakeRound {
  const frames = chunks.map(
    (chunk, position) =>
      contentFrame(chunk, position === chunks.length - 1 ? "stop" : null),
  );
  frames.push(doneFrame());
  return {
    name: "answer-with-null-characters",
    frames,
    toolCallCount: 0,
    hasDoneMarker: true,
    finishReason: "stop",
  };
}

/** A text answer whose stream ends at transport EOF: no `[DONE]` marker. */
export function answerRoundWithoutDoneMarker(text = "Half an answer"): FakeRound {
  return {
    name: "answer-without-done",
    frames: [contentFrame(text, "stop")],
    toolCallCount: 0,
    hasDoneMarker: false,
    finishReason: "stop",
  };
}

/** A stream cut in the middle of a frame: still transport EOF, no `[DONE]`. */
export function truncatedMidFrameRound(text = "Interrupted"): FakeRound {
  const partial = contentFrame(text, "stop").slice(0, -"\n\n".length);
  return {
    name: "truncated-mid-frame",
    frames: [partial],
    toolCallCount: 0,
    hasDoneMarker: false,
    finishReason: "stop",
  };
}

/**
 * A tool-enabled round that streams filler text and then a tool call, split the
 * way a real server splits `delta.tool_calls`: id + name first, then argument
 * fragments, then the `tool_calls` finish reason and `[DONE]`.
 */
export function toolRequestRound(options: {
  filler?: string;
  toolName?: string;
  argumentsFragments?: string[];
  callId?: string;
  index?: number;
} = {}): FakeRound {
  const {
    filler = "Let me work that out.",
    toolName = "calculator",
    argumentsFragments = ['{"expression":', '"1+1"}'],
    callId = "call_1",
    index = 0,
  } = options;

  const frames = [contentFrame(filler)];
  frames.push(
    toolCallFrame({ index, id: callId, type: "function", function: { name: toolName, arguments: "" } }),
  );
  for (const fragment of argumentsFragments) {
    frames.push(toolCallFrame({ index, function: { arguments: fragment } }));
  }
  frames.push(finishFrame("tool_calls"), doneFrame());

  return {
    name: "tool-request",
    frames,
    toolCallCount: 1,
    hasDoneMarker: true,
    finishReason: "tool_calls",
  };
}

/**
 * A contradictory round: `finish_reason: "tool_calls"` but no tool fragment and
 * no content — the state Step 59 must reject and no preview may commit on.
 */
export function contradictoryToolCallsRound(): FakeRound {
  const frames = [finishFrame("tool_calls"), doneFrame()];
  return {
    name: "contradictory-tool-calls",
    frames,
    toolCallCount: 0,
    hasDoneMarker: true,
    finishReason: "tool_calls",
  };
}

/**
 * A tool round that streams **no text at all**: only `delta.tool_calls` fragments,
 * then `finish_reason: "tool_calls"`. Several strict/JSON-style servers emit this
 * shape, and it is why a preview event cannot be assumed to precede every tool
 * round (contract §7): there is no provisional text to preview, commit or discard.
 * `v1.2.0` already executes such a round.
 */
export function toolRequestRoundWithoutText(options: {
  toolName?: string;
  argumentsFragments?: string[];
  callId?: string;
  index?: number;
} = {}): FakeRound {
  const {
    toolName = "calculator",
    argumentsFragments = ['{"expression":', '"1+1"}'],
    callId = "call_1",
    index = 0,
  } = options;

  const frames: string[] = [];
  frames.push(
    toolCallFrame({ index, id: callId, type: "function", function: { name: toolName, arguments: "" } }),
  );
  for (const fragment of argumentsFragments) {
    frames.push(toolCallFrame({ index, function: { arguments: fragment } }));
  }
  frames.push(finishFrame("tool_calls"), doneFrame());

  return {
    name: "tool-request-without-text",
    frames,
    toolCallCount: 1,
    hasDoneMarker: true,
    finishReason: "tool_calls",
  };
}

/**
 * `finish_reason: "stop"` on a round that **also** carried tool-call fragments —
 * the contradictory "`stop` + fragments" row of contract §6. `toolCallCount` counts
 * the fragments that are on the wire even though today's parser drops them, which
 * is exactly the silent success Step 59 turns into a typed integrity failure.
 */
export function stopWithStrayToolCallFragmentsRound(options: {
  text?: string;
  toolName?: string;
  argumentsFragments?: string[];
  callId?: string;
} = {}): FakeRound {
  const {
    text = "The answer is 4.",
    toolName = "calculator",
    argumentsFragments = ['{"expression":', '"1+1"}'],
    callId = "call_1",
  } = options;

  const frames: string[] = [contentFrame(text)];
  frames.push(
    toolCallFrame({ index: 0, id: callId, type: "function", function: { name: toolName, arguments: "" } }),
  );
  for (const fragment of argumentsFragments) {
    frames.push(toolCallFrame({ index: 0, function: { arguments: fragment } }));
  }
  frames.push(finishFrame("stop"), doneFrame());

  return {
    name: "stop-with-tool-call-fragments",
    frames,
    toolCallCount: 1,
    hasDoneMarker: true,
    finishReason: "stop",
  };
}

/** A round whose only text arrives while `finish_reason` is `length` (truncated). */
export function truncatedOutputRound(text = "The answer is definitely"): FakeRound {
  const frames = [contentFrame(text, "length"), doneFrame()];
  return { name: "length", frames, toolCallCount: 0, hasDoneMarker: true, finishReason: "length" };
}

/**
 * `finish_reason: "length"` on a round that also carried tool-call fragments —
 * the other contradictory completion shape of contract §6 (`length` or
 * `content_filter` with fragments). Same silent success as the `stop` variant: the fragments are on
 * the wire, today's parser drops them, and the round reads as ordinary truncated
 * text. Step 59 owns the typed rejection.
 */
export function lengthWithStrayToolCallFragmentsRound(options: {
  text?: string;
  toolName?: string;
  argumentsFragments?: string[];
  callId?: string;
} = {}): FakeRound {
  const {
    text = "It continues but ran out of",
    toolName = "fetch_url",
    argumentsFragments = ['{"url":', '"https://example.com"}'],
    callId = "call_truncated",
  } = options;

  const frames: string[] = [contentFrame(text)];
  frames.push(
    toolCallFrame({ index: 0, id: callId, type: "function", function: { name: toolName, arguments: "" } }),
  );
  for (const fragment of argumentsFragments) {
    frames.push(toolCallFrame({ index: 0, function: { arguments: fragment } }));
  }
  frames.push(finishFrame("length"), doneFrame());

  return {
    name: "length-with-tool-call-fragments",
    frames,
    toolCallCount: 1,
    hasDoneMarker: true,
    finishReason: "length",
  };
}

/**
 * The longest legal orchestrated turn: three tool-request rounds followed by the
 * forced no-tools final round (contract §7). Each array entry is one separate
 * upstream request, exactly as the orchestrator issues them today.
 */
export function threeToolsThenFinalRounds(
  toolNames: string[] = ["web_search", "fetch_url", "calculator"],
): FakeRound[] {
  return toolNames.map((toolName, position) =>
    toolRequestRound({
      filler: `Working on step ${position + 1}.`,
      toolName,
      callId: `call_${position + 1}`,
    }),
  ).concat([answerRound("Here is the final answer, based on the tool results.")]);
}
