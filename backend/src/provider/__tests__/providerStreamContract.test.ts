/**
 * Streaming contract baseline tests (Phase 4, Step 56).
 *
 * These are characterization tests for the `v1.2.0` provider-stream contract that
 * the Phase 4 streaming steps (58–67) build on. They lock what the current code
 * provably does — `[DONE]` vs. transport EOF, the opacity of `finish_reason`,
 * contradictory `tool_calls`, and the round/quota shape of the canonical
 * orchestrated turn — so a later step cannot silently change a guarantee. The
 * companion specification is `docs/v1.3.0-contract.md`.
 *
 * Nothing here asserts `v1.3.0` behavior that is not implemented yet, and the
 * fixtures never touch the network: every stream is a fake provider built from
 * deterministic bytes.
 */

import { describe, it, expect } from "vitest";
import {
  MAX_MODEL_ROUNDS,
  MAX_TOOL_EXECUTIONS_PER_TURN,
} from "../../orchestration/chatOrchestrator.js";
import { type SseEvent } from "../sseParser.js";
import {
  answerRound,
  answerRoundWithNullCharacters,
  answerRoundWithoutDoneMarker,
  answerRoundWithoutFinishReason,
  answerRoundWithoutFinishReasonProperty,
  collectEvents,
  contentFrame,
  contentFrameOmittingFinishReason,
  contradictoryToolCallsRound,
  doneFrame,
  framesToText,
  lengthWithStrayToolCallFragmentsRound,
  parseRound,
  readerFromText,
  stopWithStrayToolCallFragmentsRound,
  threeToolsThenFinalRounds,
  toolRequestRound,
  toolRequestRoundWithoutText,
  truncatedMidFrameRound,
  truncatedOutputRound,
} from "./fixtures/fakeProviderStream.js";

/**
 * The only event types the current parser can produce. A `v1.3.0` preview event
 * is a route-level concept (built from orchestrator events), so the parser layer
 * must not gain any of these names by accident.
 */
const PARSER_EVENT_TYPES = ["delta", "tool_calls", "done", "error"] as const;

function typesOf(events: SseEvent[]): string[] {
  return events.map((event) => event.type);
}

function textOf(events: SseEvent[]): string {
  return events
    .filter((event) => event.type === "delta")
    .map((event) => (event.type === "delta" ? event.text : ""))
    .join("");
}

// ── Fixtures are hermetic and deterministic ─────────────────────────────────

describe("Fake-provider fixtures are deterministic", () => {
  it("serializes the same round to identical bytes on every call", () => {
    const first = framesToText(answerRound("4").frames);
    const second = framesToText(answerRound("4").frames);

    expect(first).toBe(second);
    // A frame is always a `data:` line closed by a blank line, so the wire form
    // is exactly what a provider sends and never depends on run timing.
    expect(first).toBe(`data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: "4" }, finish_reason: "stop" }],
    })}\n\n${doneFrame()}`);
  });

  it("parses the same round to the same events twice", async () => {
    const round = toolRequestRound();
    const first = await collectEvents(readerFromText(framesToText(round.frames)));
    const second = await collectEvents(readerFromText(framesToText(round.frames)));

    expect(first).toEqual(second);
  });

  it("produces no event type outside the documented parser vocabulary", async () => {
    const rounds = [
      answerRound(),
      answerRoundWithoutFinishReason(),
      answerRoundWithoutFinishReasonProperty(),
      answerRoundWithNullCharacters(),
      answerRoundWithoutDoneMarker(),
      truncatedMidFrameRound(),
      truncatedOutputRound(),
      contradictoryToolCallsRound(),
      stopWithStrayToolCallFragmentsRound(),
      toolRequestRound(),
      toolRequestRoundWithoutText(),
    ];

    for (const round of rounds) {
      const events = await collectEvents(readerFromText(framesToText(round.frames)));
      for (const type of typesOf(events)) {
        expect(PARSER_EVENT_TYPES).toContain(type);
      }
    }
  });
});

// ── A server `done` is not the same thing as transport EOF ──────────────────

describe("Baseline: [DONE] marker vs transport EOF", () => {
  it("closes a clean round with exactly one done event", async () => {
    const round = answerRound("Two plus two is four.");
    const events = await collectEvents(readerFromText(framesToText(round.frames)));

    expect(typesOf(events)).toEqual(["delta", "done"]);
    expect(textOf(events)).toBe("Two plus two is four.");
    expect(events.filter((event) => event.type === "done")).toHaveLength(1);
    expect(events.filter((event) => event.type === "error")).toHaveLength(0);
  });

  it("reports EOF without [DONE] as an error and never as a done", async () => {
    const round = answerRoundWithoutDoneMarker("Half an answer");
    const events = await collectEvents(readerFromText(framesToText(round.frames)));

    expect(typesOf(events)).toEqual(["delta", "error"]);
    expect(events[events.length - 1]).toEqual({
      type: "error",
      message: "Stream ended without [DONE]",
    });
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  it("never parses a frame cut in half at EOF", async () => {
    const round = truncatedMidFrameRound("Interrupted mid-frame");
    const events = await collectEvents(readerFromText(framesToText(round.frames)));

    // The incomplete event is dropped, so no text reaches the caller, and the
    // missing [DONE] still surfaces as an error: an unterminated stream is not
    // a success at the parser layer (the browser-side tolerance is separate).
    expect(typesOf(events)).toEqual(["error"]);
    expect(textOf(events)).toBe("");
  });

  it("accepts [DONE] with no finish_reason anywhere (compatibility case)", async () => {
    const round = answerRoundWithoutFinishReason("Sunny tomorrow.");
    const events = await collectEvents(readerFromText(framesToText(round.frames)));

    expect(typesOf(events)).toEqual(["delta", "done"]);
    expect(textOf(events)).toBe("Sunny tomorrow.");
  });

  it("accepts [DONE] when the finish_reason property is missing from every chunk", async () => {
    // Distinct from the case above: `contentFrame` always writes the key, so a
    // suite that only ever sent `"finish_reason": null` would never have tested
    // a provider that omits the property at all. This round sends no such key.
    const round = answerRoundWithoutFinishReasonProperty("Sunny tomorrow.");
    const events = await collectEvents(readerFromText(framesToText(round.frames)));

    expect(typesOf(events)).toEqual(["delta", "done"]);
    expect(textOf(events)).toBe("Sunny tomorrow.");
    expect(framesToText(round.frames)).not.toContain("finish_reason");
  });
});

// ── finish_reason is opaque today (gap Step 58 closes) ──────────────────────

describe("Baseline: finish_reason is not surfaced by the parser", () => {
  const text = "A complete-looking answer";
  const reasons = ["stop", "length", "content_filter", "some_server_specific_stop", null];

  it("produces byte-identical events for every finish_reason", async () => {
    const perReason: SseEvent[][] = [];
    for (const reason of reasons) {
      const events = await collectEvents(
        readerFromText(framesToText([contentFrame(text, reason), doneFrame()])),
      );
      perReason.push(events);
    }

    // `length` / `content_filter` / unknown / absent are all indistinguishable
    // from `stop` today, so no caller can yet decide "do not commit this text".
    // Step 58 has to introduce that signal without changing these byte forms.
    for (const events of perReason) {
      expect(events).toEqual(perReason[0]);
    }
    expect(typesOf(perReason[0])).toEqual(["delta", "done"]);
  });

  it("keeps a length-truncated round looking like a normal answer today", async () => {
    const round = truncatedOutputRound("The answer is definitely");
    const events = await collectEvents(readerFromText(framesToText(round.frames)));

    // Documented as a defect the contract forbids in v1.3.0: a truncated round
    // must not be treated as a clean completion once preview events exist.
    expect(round.finishReason).toBe("length");
    expect(typesOf(events)).toEqual(["delta", "done"]);
  });

  it("drops the fragments of a length round and reports ordinary truncated text", async () => {
    // The other contradictory completion shape of contract §6: `length` together
    // with stray tool-call fragments. The parser drops the fragments and ends the
    // round as plain (truncated) text — no tool event, no error. Step 59 turns it
    // into a typed chunk-integrity failure.
    const round = lengthWithStrayToolCallFragmentsRound({ text: "It continues but ran out of" });
    const events = await collectEvents(readerFromText(framesToText(round.frames)));

    expect(round.finishReason).toBe("length");
    expect(round.toolCallCount).toBe(1);
    expect(typesOf(events)).toEqual(["delta", "done"]);
    expect(textOf(events)).toBe("It continues but ran out of");
    expect(events).not.toContainEqual(expect.objectContaining({ type: "tool_calls" }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: "error" }));
  });

  it("parses an omitted finish_reason property exactly like an explicit null one", async () => {
    const text = "Sunny tomorrow.";
    const explicitNull = await collectEvents(
      readerFromText(framesToText([contentFrame(text), doneFrame()])),
    );
    const omitted = await collectEvents(
      readerFromText(framesToText([contentFrameOmittingFinishReason(text), doneFrame()])),
    );

    // The parser never inspects a missing or null reason, so both wire shapes end
    // at `[DONE]` identically. Step 58 may type a missing reason as a gap, but it
    // may not decide the two shapes apart silently at this layer.
    expect(omitted).toEqual(explicitNull);
    expect(typesOf(explicitNull)).toEqual(["delta", "done"]);
  });

  it("sends the two missing-reason shapes as genuinely different bytes", () => {
    // Why this test exists: the previous test would also pass if both fixtures
    // collapsed to the same payload, so the wire difference is asserted here
    // (JSON escaping puts the NUL out of reach of this comparison, not the key).
    const explicit = framesToText(answerRoundWithoutFinishReason("x").frames);
    const omitted = framesToText(answerRoundWithoutFinishReasonProperty("x").frames);

    expect(explicit).toContain('"finish_reason":null');
    expect(omitted).not.toContain("finish_reason");
  });
});

// ── Tool fragments and contradictory rounds ────────────────────────────────

describe("Baseline: tool-call fragments", () => {
  it("accumulates a split tool call and still ends with done", async () => {
    const round = toolRequestRound({ filler: "Let me work that out." });
    const events = await collectEvents(readerFromText(framesToText(round.frames)));

    const toolEvent = events.find((event) => event.type === "tool_calls");
    expect(toolEvent?.type).toBe("tool_calls");
    if (toolEvent?.type !== "tool_calls") {
      throw new Error("expected a tool_calls event");
    }
    expect(toolEvent.toolCalls).toEqual([
      {
        index: 0,
        id: "call_1",
        type: "function",
        function: { name: "calculator", arguments: '{"expression":"1+1"}' },
      },
    ]);
    // The filler text is emitted as a delta before the round is known to be a
    // tool round — exactly the text v1.3.0 sends as a discardable preview.
    expect(textOf(events)).toBe("Let me work that out.");
    expect(typesOf(events)).toEqual(["delta", "tool_calls", "done"]);
  });

  it("silently ignores a tool_calls finish reason with no fragments (contradictory state)", async () => {
    const round = contradictoryToolCallsRound();
    const events = await collectEvents(readerFromText(framesToText(round.frames)));

    // Today this contradictory round parses as a clean completion. The v1.3.0
    // contract forbids committing a preview on it; Step 59 owns the rejection.
    expect(typesOf(events)).toEqual(["done"]);
    expect(events.some((event) => event.type === "tool_calls")).toBe(false);
  });

  it("drops the fragments of a stop round and completes it as a plain answer", async () => {
    const round = stopWithStrayToolCallFragmentsRound({ text: "The answer is 4." });
    const events = await collectEvents(readerFromText(framesToText(round.frames)));

    // The contract §6 "stop + fragments" row: today the contradictory shape is a
    // silent success — the fragments never reach the caller and the text answer
    // completes normally. Step 59 must turn it into a typed integrity failure
    // without ever executing the incomplete call.
    expect(round.toolCallCount).toBe(1);
    expect(round.finishReason).toBe("stop");
    expect(typesOf(events)).toEqual(["delta", "done"]);
    expect(textOf(events)).toBe("The answer is 4.");
    expect(events.some((event) => event.type === "tool_calls")).toBe(false);
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  it("assembles a tool round that streamed no text at all", async () => {
    const round = toolRequestRoundWithoutText();
    const { single, sliced } = await parseRound(round);

    // A textless tool round is legal today and stays legal in v1.3.0: the parse
    // is a `tool_calls` event and a `done`, with no delta of any kind in between.
    expect(typesOf(single)).toEqual(["tool_calls", "done"]);
    expect(textOf(single)).toBe("");
    if (single[0].type !== "tool_calls") {
      throw new Error("expected a tool_calls event");
    }
    expect(single[0].toolCalls).toEqual([
      {
        index: 0,
        id: "call_1",
        type: "function",
        function: { name: "calculator", arguments: '{"expression":"1+1"}' },
      },
    ]);
    expect(sliced).toEqual(single);
  });
});

// ── Null characters: the parser forwards them, the SSE layers must not ──────

describe("Baseline: provider text containing U+0000", () => {
  it("forwards the null character so the layer above owns sanitization", async () => {
    const round = answerRoundWithNullCharacters();
    const events = await collectEvents(readerFromText(framesToText(round.frames)));

    // `JSON.stringify` escapes the NUL, so the fixture bytes contain `\u0000` as
    // six visible characters while the parsed text contains the real one. This
    // test pins where the guarantee lives: the parser is not the sanitizer. The
    // browser-visible guarantee (no NUL may be emitted) is locked at the
    // orchestrator and route layers, where `sanitizeSseData` runs.
    const text = textOf(events);
    expect(text).toContain("\u0000");
    expect(text).toBe("2 + 2 = \u0000 4I am \u0000 sure.");
    expect(typesOf(events)).toEqual(["delta", "delta", "done"]);
  });
});

// ── Chunk boundaries never change the parse ────────────────────────────────

describe("Baseline: chunk boundaries do not change the events", () => {
  it("reassembles a round split into 5-byte pieces, including multibyte text", async () => {
    const round = answerRound("∑ Suma ✓ 2 + 2 = 4 🧮");
    const { single, sliced } = await parseRound(round);

    expect(sliced).toEqual(single);
    expect(textOf(single)).toBe("∑ Suma ✓ 2 + 2 = 4 🧮");
  });

  it("reassembles a split tool-call round identically when sliced", async () => {
    const round = toolRequestRound();
    const { single, sliced } = await parseRound(round);

    expect(sliced).toEqual(single);
  });
});

// ── The canonical orchestrated turn respects the documented caps ───────────

describe("Baseline: three tools then the forced final round", () => {
  const rounds = threeToolsThenFinalRounds();

  it("has exactly MAX_MODEL_ROUNDS rounds and MAX_TOOL_EXECUTIONS_PER_TURN calls", () => {
    expect(rounds).toHaveLength(MAX_MODEL_ROUNDS);
    const totalCalls = rounds.reduce((sum, round) => sum + round.toolCallCount, 0);
    expect(totalCalls).toBe(MAX_TOOL_EXECUTIONS_PER_TURN);

    // Every tool round is a separate upstream request closed by [DONE]; only a
    // server terminal separates rounds, never a transport EOF.
    for (const round of rounds) {
      expect(round.hasDoneMarker).toBe(true);
    }
    expect(rounds.slice(0, MAX_TOOL_EXECUTIONS_PER_TURN).map((round) => round.finishReason))
      .toEqual(Array(MAX_TOOL_EXECUTIONS_PER_TURN).fill("tool_calls"));
    expect(rounds[MAX_MODEL_ROUNDS - 1].toolCallCount).toBe(0);
    expect(rounds[MAX_MODEL_ROUNDS - 1].finishReason).toBe("stop");
  });

  it("parses each tool round to fragments and the final round to plain text", async () => {
    for (const round of rounds) {
      const events = await collectEvents(readerFromText(framesToText(round.frames)));
      const isToolRound = round.toolCallCount > 0;

      expect(typesOf(events)).toEqual(isToolRound ? ["delta", "tool_calls", "done"] : ["delta", "done"]);
      expect(events[events.length - 1]).toEqual({ type: "done" });
      expect(typesOf(events).filter((type) => type === "error")).toHaveLength(0);
    }
  });
});
