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
  answerRoundWithoutDoneMarker,
  answerRoundWithoutFinishReason,
  collectEvents,
  contentFrame,
  contradictoryToolCallsRound,
  doneFrame,
  framesToText,
  parseRound,
  readerFromText,
  threeToolsThenFinalRounds,
  toolRequestRound,
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
      answerRoundWithoutDoneMarker(),
      truncatedMidFrameRound(),
      truncatedOutputRound(),
      contradictoryToolCallsRound(),
      toolRequestRound(),
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
