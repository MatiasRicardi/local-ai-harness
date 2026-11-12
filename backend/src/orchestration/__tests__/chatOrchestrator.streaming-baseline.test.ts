/**
 * Chat orchestrator streaming baseline (Phase 4, Step 56).
 *
 * Characterization tests for the `v1.2.0` orchestrated turn that the speculative
 * streaming steps (60–62) extend. They lock the current event vocabulary, the
 * buffer-then-flush-on-terminal shape, the `[DONE]` vs. transport-EOF split, the
 * round and quota behaviour, and the provider-history message shape — so step 60
 * can only add preview events and step 61 can only move the flush earlier, never
 * change an existing guarantee. The companion specification is
 * `docs/v1.3.0-contract.md`.
 *
 * Deliberate deviation from `chatOrchestratorPolicy.test.ts`: that file builds
 * provider events inline, while this one feeds **raw wire bytes** through the real
 * `SseParser` using the hermetic fake-provider fixtures, and it asserts the event
 * *sequence* per scenario instead of individual fields. Each gap a later step must
 * close is named where it is characterized.
 */

import { describe, it, expect, vi } from "vitest";
import {
  ChatOrchestrator,
  MAX_MODEL_ROUNDS,
  MAX_TOOL_EXECUTIONS_PER_TURN,
} from "../chatOrchestrator.js";
import type { ProviderClient, ProviderRequestMessage, ProviderStream } from "../../provider/types.js";
import type { ProviderConfig } from "../../provider/schemas.js";
import type { ChatToolOptions } from "../../provider/tools.js";
import type { Tool, ToolRegistry } from "../../tools/types.js";
import { AppError } from "../../utils/errorHandler.js";
import {
  answerRound,
  answerRoundWithoutDoneMarker,
  answerRoundWithoutFinishReason,
  contradictoryToolCallsRound,
  contentFrame,
  doneFrame,
  framesToText,
  splitBytes,
  threeToolsThenFinalRounds,
  toolRequestRound,
  truncatedOutputRound,
  type FakeRound,
} from "../../provider/__tests__/fixtures/fakeProviderStream.js";

// ── Test helpers ─────────────────────────────────────────────────────────────

const CONFIG: ProviderConfig = {
  baseUrl: "http://localhost:8080/v1",
  model: "test-model",
  timeoutMs: 10_000,
};

/** One recorded provider call: the messages sent plus the tool options offered. */
interface ProviderCall {
  /**
   * Snapshot taken at call time. `ChatOrchestrator` hands the SAME working array
   * to every round and appends tool history in place, so the live reference
   * would keep growing while the test inspects it; the provider serializes the
   * body when the call starts, so the snapshot is what that round actually saw.
   */
  messages: ProviderRequestMessage[];
  /** The array object passed to this round, for the identity invariant below. */
  messagesRef: ProviderRequestMessage[];
  options?: ChatToolOptions & { signal?: AbortSignal };
}

/**
 * A scripted provider for one turn: each {@link FakeRound} is served as the raw
 * bytes of one chat-completion response, in order. `chunkSize` slices those bytes
 * so the same script can be delivered as one chunk or as many small ones.
 */
function createScriptedClient(
  rounds: FakeRound[],
  options: { chunkSize?: number } = {},
): { client: ProviderClient; calls: ProviderCall[] } {
  const calls: ProviderCall[] = [];
  let round = 0;

  const client = {
    chat: vi.fn(),
    chatStream: vi.fn(
      (_config: ProviderConfig, messages: ProviderRequestMessage[], opts?: ChatToolOptions & { signal?: AbortSignal }) => {
        calls.push({ messages: [...messages], messagesRef: messages, options: opts });
        const payload = framesToText((rounds[round++] ?? answerRound("unscripted round")).frames);
        const chunks = options.chunkSize ? splitBytes(payload, options.chunkSize) : [new TextEncoder().encode(payload)];
        let index = 0;
        return new ReadableStream<Uint8Array>({
          pull(controller) {
            if (index < chunks.length) {
              controller.enqueue(chunks[index++]);
            } else {
              controller.close();
            }
          },
        }) as unknown as ProviderStream;
      },
    ),
  } as unknown as ProviderClient;

  return { client, calls };
}

/** A deterministic fake tool with an optional structured-source payload. */
function createFakeTool(
  name: string,
  result: { content: string; metadata?: Record<string, unknown> } = { content: `${name}-result` },
): Tool {
  return {
    definition: {
      name,
      description: `Test tool ${name}`,
      inputSchema: { type: "object", properties: { expression: { type: "string" } } },
    },
    execute: vi.fn(async () => result),
  };
}

function createRegistry(tools: Tool[]): ToolRegistry {
  const map = new Map<string, Tool>(tools.map((tool) => [tool.definition.name, tool]));
  return {
    register: (tool) => map.set(tool.definition.name, tool),
    get: (name) => map.get(name),
    listDefinitions: () => [...map.values()].map((tool) => tool.definition),
  };
}

type CollectedEvent = { type: string; text?: string; name?: string; sources?: unknown[] };

/** Collect every event the orchestrator yields. */
async function collect(gen: AsyncGenerator<Record<string, unknown>>): Promise<CollectedEvent[]> {
  const events: CollectedEvent[] = [];
  for await (const event of gen) {
    events.push(event as unknown as CollectedEvent);
  }
  return events;
}

/** Collect events until the generator throws, returning whatever it emitted first. */
async function collectUntilError(
  gen: AsyncGenerator<Record<string, unknown>>,
): Promise<{ events: CollectedEvent[]; error: unknown }> {
  const events: CollectedEvent[] = [];
  let error: unknown;
  try {
    for await (const event of gen) {
      events.push(event as unknown as CollectedEvent);
    }
  } catch (caught) {
    error = caught;
  }
  return { events, error };
}

function userMessage(content: string): { role: "user"; content: string } {
  return { role: "user", content };
}

function typesOf(events: CollectedEvent[]): string[] {
  return events.map((event) => event.type);
}

function textOf(events: CollectedEvent[]): string {
  return events.filter((event) => event.type === "delta").map((event) => event.text ?? "").join("");
}

/** Tool names in `tool_start` order. */
function toolNamesOf(events: CollectedEvent[]): string[] {
  return events.filter((event) => event.type === "tool_start").map((event) => event.name ?? "");
}

/**
 * One calculator round that requests a tool call, followed by a plain-text final
 * round. `rounds` is the whole turn script.
 */
function toolThenAnswer(fillers: string[] = ["Working on step 1."]): FakeRound[] {
  return fillers.map((filler, index) =>
    toolRequestRound({
      filler,
      toolName: "calculator",
      callId: `call_${index + 1}`,
      argumentsFragments: [`{"expression":`, `"${index + 1}+1"}`],
    }),
  ).concat([answerRound("The result is correct.")]);
}

// ── Vocabulary: no preview events exist before step 60 ──────────────────────

describe("ChatOrchestrator — baseline event vocabulary", () => {
  it("emits only the v1.2.0 orchestrator events on both paths", async () => {
    const allowed = ["delta", "done", "tool_start", "tool_end", "sources"];

    const plainTurn = await collect(
      new ChatOrchestrator(createScriptedClient([answerRound("A plain answer")]).client).stream({
        providerConfig: CONFIG,
        messages: [userMessage("hi")],
      }),
    );
    const toolTurn = await collect(
      new ChatOrchestrator(createScriptedClient(toolThenAnswer()).client).stream({
        providerConfig: CONFIG,
        messages: [userMessage("calculate")],
        tools: createRegistry([createFakeTool("calculator")]),
      }),
    );

    for (const events of [plainTurn, toolTurn]) {
      for (const type of typesOf(events)) {
        expect(allowed).toContain(type);
      }
      // Steps 60–61 introduce these three names at the orchestrator layer;
      // nothing may emit them before then.
      for (const preview of ["preview_delta", "preview_commit", "preview_discard"]) {
        expect(typesOf(events)).not.toContain(preview);
      }
    }
  });
});

// ── Round 1 with no tools streams progressively ─────────────────────────────

describe("ChatOrchestrator — progressive path (no tools registered)", () => {
  it("forwards one delta per provider chunk, then done", async () => {
    const round: FakeRound = {
      name: "two-chunk-answer",
      frames: [contentFrame("First half. "), contentFrame("Second half."), doneFrame()],
      toolCallCount: 0,
      hasDoneMarker: true,
      finishReason: null,
    };

    const events = await collect(
      new ChatOrchestrator(createScriptedClient([round]).client).stream({
        providerConfig: CONFIG,
        messages: [userMessage("hi")],
      }),
    );

    expect(typesOf(events)).toEqual(["delta", "delta", "done"]);
    expect(events.map((event) => event.text)).toEqual(["First half. ", "Second half.", undefined]);
  });

  it("keeps already streamed text visible when the provider then fails", async () => {
    // v1.2.0 already shows partial text plus a terminal failure on the live path.
    // The contract keeps that shape (`partial text + error` is the only legal
    // truncation presentation) — steps 58 and 62–63 must not regress it.
    const { events, error } = await collectUntilError(
      new ChatOrchestrator(createScriptedClient([answerRoundWithoutDoneMarker("Half an answer")]).client).stream({
        providerConfig: CONFIG,
        messages: [userMessage("hi")],
      }),
    );

    expect(typesOf(events)).toEqual(["delta"]);
    expect(textOf(events)).toBe("Half an answer");
    expect(error).toBeInstanceOf(AppError);
    // A stream that ends without the terminal marker is the existing
    // INVALID_PROVIDER_RESPONSE failure: v1.3.0 keeps that single terminal error.
    expect((error as AppError).code).toBe("INVALID_PROVIDER_RESPONSE");
  });

  it("treats [DONE] without any finish_reason as a normal answer", async () => {
    const events = await collect(
      new ChatOrchestrator(createScriptedClient([answerRoundWithoutFinishReason("Sunny tomorrow.")]).client).stream({
        providerConfig: CONFIG,
        messages: [userMessage("weather?")],
      }),
    );

    expect(typesOf(events)).toEqual(["delta", "done"]);
    expect(textOf(events)).toBe("Sunny tomorrow.");
  });
});

// ── Tool rounds: filler text is buffered and dropped ────────────────────────

describe("ChatOrchestrator — buffered path (tools registered)", () => {
  it("discards a tool round's filler text at the tool boundary", async () => {
    const events = await collect(
      new ChatOrchestrator(createScriptedClient(toolThenAnswer(["SECRET_FILLER"])).client).stream({
        providerConfig: CONFIG,
        messages: [userMessage("calculate")],
        tools: createRegistry([createFakeTool("calculator")]),
      }),
    );

    // The flush that v1.3.0 turns into `preview_discard` happens silently today.
    expect(typesOf(events)).toEqual(["tool_start", "tool_end", "sources", "delta", "done"]);
    expect(textOf(events)).toBe("The result is correct.");
    expect(JSON.stringify(events)).not.toContain("SECRET_FILLER");
  });

  it("keeps every tool event strictly before the answer events", async () => {
    const events = await collect(
      new ChatOrchestrator(createScriptedClient(toolThenAnswer(["a", "b", "c"])).client).stream({
        providerConfig: CONFIG,
        messages: [userMessage("calculate")],
        tools: createRegistry([createFakeTool("calculator")]),
      }),
    );

    const types = typesOf(events);
    const toolEventTypes = ["tool_start", "tool_end", "sources"];
    const lastToolIndex = Math.max(...types.map((type, index) => (toolEventTypes.includes(type) ? index : -1)));
    const firstAnswerIndex = types.indexOf("delta");

    expect(types.filter((type) => type === "tool_start")).toHaveLength(MAX_TOOL_EXECUTIONS_PER_TURN);
    expect(firstAnswerIndex).toBeGreaterThan(lastToolIndex);
    expect(types.slice(-2)).toEqual(["delta", "done"]);
  });

  it("drops a buffered round's text when the provider stream ends without [DONE]", async () => {
    // The round is buffered, so an unterminated stream contributes nothing: the
    // v1.3.0 equivalent is a discardable preview plus one typed error.
    const partial = answerRoundWithoutDoneMarker("Buffered text that never lands");
    const { events, error } = await collectUntilError(
      new ChatOrchestrator(createScriptedClient([partial]).client).stream({
        providerConfig: CONFIG,
        messages: [userMessage("calculate")],
        tools: createRegistry([createFakeTool("calculator")]),
      }),
    );

    expect(events).toEqual([]);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("INVALID_PROVIDER_RESPONSE");
  });
});

// ── Abnormal completions that v1.3.0 must classify ─────────────────────────

describe("ChatOrchestrator — abnormal completions", () => {
  it("treats a contradictory tool_calls completion as a plain answer today", async () => {
    // Contract §7 contradiction row: `finish_reason: "tool_calls"` with no
    // fragments is indistinguishable from a clean answer in v1.2.0. Step 59 owns
    // making this a typed provider error that no preview may commit on.
    const events = await collect(
      new ChatOrchestrator(createScriptedClient([contradictoryToolCallsRound()]).client).stream({
        providerConfig: CONFIG,
        messages: [userMessage("calculate")],
        tools: createRegistry([createFakeTool("calculator")]),
      }),
    );

    expect(typesOf(events)).toEqual(["done"]);
  });

  it("treats a length-truncated round as a clean answer today", async () => {
    // Contract §6 row 2: `finish_reason: "length"` is opaque, so a truncated
    // round currently reaches the browser as if it were complete.
    const events = await collect(
      new ChatOrchestrator(createScriptedClient([truncatedOutputRound("The answer is definitely")]).client).stream({
        providerConfig: CONFIG,
        messages: [userMessage("answer")],
        tools: createRegistry([createFakeTool("calculator")]),
      }),
    );

    expect(typesOf(events)).toEqual(["delta", "done"]);
    expect(textOf(events)).toBe("The answer is definitely");
  });

  it("counts rounds and never exceeds the caps when the model keeps calling tools", async () => {
    // Every round requests another tool. After MAX_TOOL_EXECUTIONS_PER_TURN the
    // last round is forced with no tools, and a stray tool call there is a
    // protocol violation → TOOL_CALL_LIMIT_EXCEEDED, after any already-streamed
    // partial text.
    const script = threeToolsThenFinalRounds().slice(0, MAX_MODEL_ROUNDS);
    script[MAX_MODEL_ROUNDS - 1] = toolRequestRound({ filler: "One more step. ", toolName: "calculator", callId: "call_4" });

    const { client, calls } = createScriptedClient(script);
    const webSearch = createFakeTool("web_search");
    const fetchUrl = createFakeTool("fetch_url");
    const calculator = createFakeTool("calculator");
    const tools = [webSearch, fetchUrl, calculator];
    const { events, error } = await collectUntilError(
      new ChatOrchestrator(client).stream({
        providerConfig: CONFIG,
        messages: [userMessage("chain tools")],
        tools: createRegistry(tools),
      }),
    );

    expect(calls).toHaveLength(MAX_MODEL_ROUNDS);
    // Exactly MAX_TOOL_EXECUTIONS_PER_TURN tools run, in request order, one
    // attempt each. The tool the forced final round asks for is never executed.
    expect(toolNamesOf(events)).toEqual(["web_search", "fetch_url", "calculator"]);
    for (const tool of tools) {
      expect(tool.execute).toHaveBeenCalledTimes(1);
    }
    // The forced final round runs with no tool definitions offered at all.
    expect(calls[MAX_MODEL_ROUNDS - 1].options?.tools).toBeUndefined();
    expect(calls.slice(0, MAX_MODEL_ROUNDS - 1).every((call) => (call.options?.tools ?? []).length > 0)).toBe(true);
    // Partial text from the forced live round is already visible before the error.
    expect(textOf(events)).toBe("One more step. ");
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("TOOL_CALL_LIMIT_EXCEEDED");
  });
});

// ── Provider history shape (prompt-cache invariant steps 61–63 protect) ─────

describe("ChatOrchestrator — provider history across rounds", () => {
  it("appends an object-form assistant tool call and a matching tool result", async () => {
    const { client, calls } = createScriptedClient(toolThenAnswer(["Working on step 1."]));
    await collect(
      new ChatOrchestrator(client).stream({
        providerConfig: CONFIG,
        messages: [userMessage("What is 1+1?")],
        tools: createRegistry([createFakeTool("calculator")]),
      }),
    );

    expect(calls).toHaveLength(2);
    const second = calls[1].messages;

    // The prefix of round 2 is identical to round 1: only the tool-call and
    // tool-result messages are appended. The prompt-cache prefix reuse in steps
    // 61–63 depends on this append-only shape.
    expect(second.slice(0, calls[0].messages.length)).toEqual(calls[0].messages);
    expect(second[0]).toEqual(userMessage("What is 1+1?"));

    const assistant = second.find(
      (message) => typeof message === "object" && message.role === "assistant" && "tool_calls" in message,
    );
    const toolResult = second.find((message) => typeof message === "object" && message.role === "tool");
    if (!assistant || !toolResult) {
      throw new Error("round 2 must carry an assistant tool call and a matching tool result");
    }

    // Object form, never a stringified assistant message, and in v1.2.0 the
    // tool-call message carries NO content: the discarded filler text of a tool
    // round never enters provider history. Phase 4 must keep that — step 61
    // forbids speculative text in `workingMessages` — so this stays absent.
    expect(assistant).toMatchObject({
      role: "assistant",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "calculator", arguments: '{"expression":"1+1"}' } },
      ],
    });
    expect(assistant).not.toHaveProperty("content");

    // The tool-call / tool-result pair is appended after the conversation, in
    // OpenAI order, and closes with the matching `tool_call_id`.
    expect(second.indexOf(assistant)).toBe(calls[0].messages.length);
    expect(second.indexOf(toolResult)).toBe(second.length - 1);
    expect(toolResult).toMatchObject({ role: "tool", tool_call_id: "call_1", content: "calculator-result" });

    // v1.2.0 reuses ONE array for every round and appends history in place. A
    // cache-aware rewrite (steps 61–63) must keep that append-only property; a
    // variant that rebuilds the conversation prefix every round would break the
    // provider prompt-cache prefix and is caught here.
    expect(new Set(calls.map((call) => call.messagesRef)).size).toBe(1);
  });
});

// ── Chunk boundaries never change the visible stream ───────────────────────

describe("ChatOrchestrator — delivery is independent of chunk boundaries", () => {
  it("produces the same events for one big chunk and for 5-byte reads", async () => {
    const script = toolThenAnswer(["Let me work that out. "]);

    const whole = await collect(
      new ChatOrchestrator(createScriptedClient(script).client).stream({
        providerConfig: CONFIG,
        messages: [userMessage("calculate")],
        tools: createRegistry([createFakeTool("calculator")]),
      }),
    );
    const sliced = await collect(
      new ChatOrchestrator(createScriptedClient(script, { chunkSize: 5 }).client).stream({
        providerConfig: CONFIG,
        messages: [userMessage("calculate")],
        tools: createRegistry([createFakeTool("calculator")]),
      }),
    );

    expect(sliced).toEqual(whole);
  });
});
