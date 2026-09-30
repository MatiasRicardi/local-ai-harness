import { describe, it, expect, vi } from "vitest";
import { ChatOrchestrator } from "../chatOrchestrator.js";
import type { ProviderClient } from "../../provider/types.js";
import type { ProviderConfig } from "../../provider/schemas.js";
import type { Tool, ToolRegistry } from "../../tools/types.js";
import { AppError } from "../../utils/errorHandler.js";

// ── Test helpers ─────────────────────────────────────────────────────────────

/** Turn a list of SSE payloads into a `ReadableStream` of UTF-8 bytes. */
function sseLine(event: string | Record<string, unknown>): Uint8Array {
  const encoder = new TextEncoder();
  const line = typeof event === "string" ? event : JSON.stringify(event);
  return encoder.encode(`data: ${line}\n\n`);
}

/** Split a flat SSE event list into per-round streams at each `[DONE]`. */
function splitRounds(
  events: Array<string | Record<string, unknown>>,
): Array<Array<string | Record<string, unknown>>> {
  const rounds: Array<Array<string | Record<string, unknown>>> = [];
  let current: Array<string | Record<string, unknown>> = [];
  for (const event of events) {
    current.push(event);
    if (event === "[DONE]") {
      rounds.push(current);
      current = [];
    }
  }
  if (current.length > 0) {
    rounds.push(current);
  }
  return rounds;
}

/** A pull-based recording client. The stream for `abortRound` (1-indexed)
 * aborts `controller` as soon as its first chunk is delivered, so the model
 * round is cancelled before any tool it might request is ever executed. */
function createPullRecordingClient(
  events: Array<string | Record<string, unknown>>,
  opts: { abortRound?: number; controller: AbortController },
): { client: ProviderClient; calls: Array<{ options?: unknown }> } {
  const rounds = splitRounds(events);
  const calls: Array<{ options?: unknown }> = [];
  let round = 0;

  const client = {
    chat: vi.fn(),
    chatStream: vi.fn((_config: ProviderConfig, _messages: unknown, _options?: unknown) => {
      const eventsForRound = rounds[round++] ?? [];
      calls.push({ options: _options });

      if (opts.abortRound && round === opts.abortRound) {
        let i = 0;
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(sseLine(eventsForRound[i++]));
            // Abort as the round's first bytes are exposed: the model round is
            // cancelled before any tool it requests can execute.
            opts.controller.abort();
          },
          pull(controller) {
            if (i < eventsForRound.length) {
              controller.enqueue(sseLine(eventsForRound[i++]));
            } else {
              controller.close();
            }
          },
        });
      }

      return new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of eventsForRound) {
            controller.enqueue(sseLine(event));
          }
          controller.close();
        },
      });
    }),
  } as unknown as ProviderClient;

  return { client, calls };
}

/** A recording client that hands each round the next prebuilt stream. The
 * passed event list is split at each `[DONE]` marker, so each chunk gets its
 * own round exactly as a real provider would. */
function createRecordingClient(
  events: Array<string | Record<string, unknown>>,
): { client: ProviderClient; calls: Array<{ options?: unknown; messages?: unknown }> } {
  const rounds = splitRounds(events);
  const calls: Array<{ options?: unknown; messages?: unknown }> = [];
  let round = 0;

  const client = {
    chat: vi.fn(),
    chatStream: vi.fn((_config: ProviderConfig, _messages: unknown, _options?: unknown) => {
      const eventsForRound = rounds[round++] ?? [];
      calls.push({ options: _options, messages: _messages });
      return new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of eventsForRound) {
            controller.enqueue(sseLine(event));
          }
          controller.close();
        },
      });
    }),
  } as unknown as ProviderClient;

  return { client, calls };
}

/**
 * A deterministic fake tool. `execute` is spyable and its per-turn execution
 * policy is configurable, so tests can model `web_search` (max 1 per turn).
 */
function createPolicyTool(
  name: string,
  maxExecutionsPerTurn: number,
  executeImpl?: (args: unknown, context: { signal?: AbortSignal }) => Promise<{ content: string }>,
): Tool {
  return {
    definition: {
      name,
      description: "A test tool",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
    },
    executionPolicy: { maxExecutionsPerTurn },
    execute: vi.fn(executeImpl ?? (async () => ({ content: `${name}-result` }))),
  };
}

/** A registry that resolves tools by name. */
function createRegistry(tools: Tool[]): ToolRegistry {
  const map = new Map<string, Tool>();
  for (const tool of tools) {
    map.set(tool.definition.name, tool);
  }
  return {
    register(t: Tool) {
      map.set(t.definition.name, t);
    },
    get(name: string) {
      return map.get(name);
    },
    listDefinitions() {
      return [...map.values()].map((t) => t.definition);
    },
  };
}

/** Collect every event an orchestrator generator yields. */
async function collect(
  gen: AsyncGenerator<{ type: string; text?: string; name?: string }>,
): Promise<Array<{ type: string; text?: string; name?: string }>> {
  const events: Array<{ type: string; text?: string; name?: string }> = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

/** Collect events until the generator throws, returning whatever preceded it. */
async function collectUntilError(
  gen: AsyncGenerator<{ type: string; name?: string }>,
): Promise<{ events: Array<{ type: string; name?: string }>; error: unknown }> {
  const events: Array<{ type: string; name?: string }> = [];
  let error: unknown;
  try {
    for await (const event of gen) {
      events.push(event);
    }
  } catch (e) {
    error = e;
  }
  return { events, error };
}

const CONFIG: ProviderConfig = {
  baseUrl: "http://localhost:8080/v1",
  model: "test-model",
  timeoutMs: 10_000,
};

function userMessage(content: string) {
  return { role: "user" as const, content };
}

/** One model round that requests a single tool call. */
function toolCallRound(name: string, id: string, args: string): Array<string | Record<string, unknown>> {
  return [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id, type: "function", function: { name, arguments: args } },
            ],
          },
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    "[DONE]",
  ];
}

/** One model round that returns plain assistant text. */
function answerRound(text: string): Array<string | Record<string, unknown>> {
  return [
    { choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    "[DONE]",
  ];
}

/** One model round that requests two distinct tool calls at once. */
function multiCallRound(): Array<string | Record<string, unknown>> {
  return [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "call_1", type: "function", function: { name: "web_search", arguments: "{}" } },
              { index: 1, id: "call_2", type: "function", function: { name: "web_search", arguments: "{}" } },
            ],
          },
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    "[DONE]",
  ];
}

/** The synthetic harness result emitted when a tool is blocked by policy. */
const SYNTHETIC_LIMIT_MESSAGE = "per-turn execution limit";

// ── 1. Per-tool execution policy (maxExecutionsPerTurn) ───────────────────────

describe("ChatOrchestrator — per-tool execution policy", () => {
  it("does not execute a second web_search in the same turn and closes it with a synthetic result", async () => {
    const webSearch = createPolicyTool("web_search", 1);
    const { client, calls } = createRecordingClient([
      ...toolCallRound("web_search", "call_1", "{}"),
      ...toolCallRound("web_search", "call_2", "{}"),
      ...answerRound("final answer"),
    ]);

    const events = await collect(
      new ChatOrchestrator(client).stream({
        providerConfig: CONFIG,
        messages: [userMessage("x")],
        tools: createRegistry([webSearch]),
      }),
    );

    // Only the first web_search executed; the second request was blocked.
    expect(webSearch.execute).toHaveBeenCalledTimes(1);

    // No second tool_start: the blocked call emitted no lifecycle events.
    expect(events.filter((e) => e.type === "tool_start")).toHaveLength(1);
    expect(events).toContainEqual({ type: "tool_start", name: "web_search" });
    expect(events).toContainEqual({ type: "tool_end", name: "web_search" });

    // Round 1 and round 2 offered tools; the forced final round did not.
    expect(calls.length).toBe(3);
    expect((calls[0].options as { tools?: unknown }).tools).toHaveLength(1);
    expect((calls[1].options as { tools?: unknown }).tools).toHaveLength(1);
    expect((calls[2].options as { tools?: unknown }).tools).toBeUndefined();

    // The blocked call is closed with a synthetic role:tool message so the
    // OpenAI-compatible history stays valid, and the assistant tool-call is
    // preserved with its original id.
    const finalMessages = (calls[2].messages as Array<{
      role: string;
      id?: string;
      tool_call_id?: string;
      content?: string;
      tool_calls?: Array<{ id: string }>;
    }>) ?? [];
    const closedTool = finalMessages.find((m) => m.role === "tool" && m.tool_call_id === "call_2");
    expect(closedTool?.content).toContain(SYNTHETIC_LIMIT_MESSAGE);
    const assistantCall = finalMessages.find(
      (m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls[0]?.id === "call_2",
    );
    expect(assistantCall).toBeDefined();

    // One final streamed answer and exactly one done.
    const finalDeltas = events.filter((e) => e.type === "delta").map((e) => e.text);
    expect(finalDeltas).toEqual(["final answer"]);
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
  });
});

// ── 2. Global execution cap ───────────────────────────────────────────────────

describe("ChatOrchestrator — global execution cap", () => {
  it("never executes a fourth tool in one turn", async () => {
    const toolA = createPolicyTool("toolA", 3);
    const toolB = createPolicyTool("toolB", 3);
    const toolC = createPolicyTool("toolC", 3);
    const { client, calls } = createRecordingClient([
      ...toolCallRound("toolA", "c1", "{}"),
      ...toolCallRound("toolB", "c2", "{}"),
      ...toolCallRound("toolC", "c3", "{}"),
      ...answerRound("after three"),
    ]);

    await collect(
      new ChatOrchestrator(client).stream({
        providerConfig: CONFIG,
        messages: [userMessage("x")],
        tools: createRegistry([toolA, toolB, toolC]),
      }),
    );

    expect(toolA.execute).toHaveBeenCalledTimes(1);
    expect(toolB.execute).toHaveBeenCalledTimes(1);
    expect(toolC.execute).toHaveBeenCalledTimes(1);
    // Three tools executed; the fourth model round ran without tools.
    expect(calls.length).toBe(4);
    expect((calls[3].options as { tools?: unknown }).tools).toBeUndefined();
  });
});

// ── 3-5. Stable invalid-call behavior ─────────────────────────────────────────

describe("ChatOrchestrator — invalid calls stay rejected", () => {
  it("rejects a multi-call round with TOOL_CALL_LIMIT_EXCEEDED", async () => {
    const { client } = createRecordingClient(multiCallRound());

    await expect(
      collect(
        new ChatOrchestrator(client).stream({
          providerConfig: CONFIG,
          messages: [userMessage("x")],
          tools: createRegistry([createPolicyTool("web_search", 1)]),
        }),
      ),
    ).rejects.toMatchObject({ code: "TOOL_CALL_LIMIT_EXCEEDED", statusCode: 502 });
  });

  it("rejects malformed JSON arguments with TOOL_INVALID_ARGUMENTS", async () => {
    const { client } = createRecordingClient([
      ...toolCallRound("web_search", "call_1", "{not json"),
    ]);

    await expect(
      collect(
        new ChatOrchestrator(client).stream({
          providerConfig: CONFIG,
          messages: [userMessage("x")],
          tools: createRegistry([createPolicyTool("web_search", 1)]),
        }),
      ),
    ).rejects.toMatchObject({ code: "TOOL_INVALID_ARGUMENTS", statusCode: 502 });
  });

  it("rejects an unknown tool with TOOL_NOT_FOUND", async () => {
    const { client } = createRecordingClient([
      ...toolCallRound("nope", "call_1", "{}"),
    ]);

    await expect(
      collect(
        new ChatOrchestrator(client).stream({
          providerConfig: CONFIG,
          messages: [userMessage("x")],
          tools: createRegistry([createPolicyTool("web_search", 1)]),
        }),
      ),
    ).rejects.toMatchObject({ code: "TOOL_NOT_FOUND", statusCode: 502 });
  });
});

// ── 6. Abort before tool execution ────────────────────────────────────────────

describe("ChatOrchestrator — abort before tool execution", () => {
  it("does not invoke the tool when the request is aborted during the model round", async () => {
    const webSearch = createPolicyTool("web_search", 1);
    const controller = new AbortController();
    const { client } = createPullRecordingClient([
      ...toolCallRound("web_search", "call_1", "{}"),
      ...answerRound("unreachable"),
    ], { abortRound: 1, controller });

    const events = await collect(
      new ChatOrchestrator(client).stream({
        providerConfig: CONFIG,
        messages: [userMessage("x")],
        tools: createRegistry([webSearch]),
        signal: controller.signal,
      }),
    );

    expect(webSearch.execute).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});

// ── 7. Abort during tool execution ────────────────────────────────────────────

describe("ChatOrchestrator — abort during tool execution", () => {
  it("passes the signal to the tool and starts no later model round", async () => {
    const controller = new AbortController();
    const webSearch = createPolicyTool("web_search", 1, async (_args) => {
      controller.abort();
      return { content: "result" };
    });
    const { client, calls } = createRecordingClient([
      ...toolCallRound("web_search", "call_1", "{}"),
      ...answerRound("unreachable"),
    ]);

    const events = await collect(
      new ChatOrchestrator(client).stream({
        providerConfig: CONFIG,
        messages: [userMessage("x")],
        tools: createRegistry([webSearch]),
        signal: controller.signal,
      }),
    );

    expect(webSearch.execute).toHaveBeenCalledTimes(1);
    expect(webSearch.execute).toHaveBeenCalledWith({}, { signal: controller.signal });
    // tool_start was emitted (the search began), but the post-tool guard stops
    // the next round, so there is no tool_end, no sources, no answer.
    expect(events).toEqual([{ type: "tool_start", name: "web_search" }]);
    expect(calls.length).toBe(1);
  });
});

// ── 8. Abort between tools ────────────────────────────────────────────────────

describe("ChatOrchestrator — abort between tools", () => {
  it("does not invoke the next tool after the previous one completed", async () => {
    const toolA = createPolicyTool("toolA", 3);
    const toolB = createPolicyTool("toolB", 3);
    const controller = new AbortController();
    const { client, calls } = createPullRecordingClient(
      [
        ...toolCallRound("toolA", "c1", "{}"),
        ...toolCallRound("toolB", "c2", "{}"),
        ...answerRound("unreachable"),
      ],
      { abortRound: 2, controller },
    );

    const events = await collect(
      new ChatOrchestrator(client).stream({
        providerConfig: CONFIG,
        messages: [userMessage("x")],
        tools: createRegistry([toolA, toolB]),
        signal: controller.signal,
      }),
    );

    expect(toolA.execute).toHaveBeenCalledTimes(1);
    expect(toolB.execute).not.toHaveBeenCalled();
    // toolA completed normally (start + end + sources), then the abort stops
    // before toolB's round.
    expect(events).toEqual([
      { type: "tool_start", name: "toolA" },
      { type: "tool_end", name: "toolA" },
      { type: "sources", sources: [] },
    ]);
    expect(calls.length).toBe(2);
  });
});

// ── 9. Tool execution failure ─────────────────────────────────────────────────

describe("ChatOrchestrator — tool execution failure", () => {
  it("produces exactly one safe terminal error with no competing done", async () => {
    const webSearch = createPolicyTool("web_search", 1, async () => {
      throw new AppError({ code: "INTERNAL_ERROR", statusCode: 500, message: "boom internals" });
    });
    const { client } = createRecordingClient([
      ...toolCallRound("web_search", "call_1", "{}"),
      ...answerRound("unreachable"),
    ]);

    const { events, error } = await collectUntilError(
      new ChatOrchestrator(client).stream({
        providerConfig: CONFIG,
        messages: [userMessage("x")],
        tools: createRegistry([webSearch]),
      }),
    );

    // tool_start was emitted, but the failure never reached tool_end/done.
    expect(events).toEqual([{ type: "tool_start", name: "web_search" }]);
    expect((error as AppError).code).toBe("TOOL_EXECUTION_FAILED");
    // The user-facing message must not leak the internal detail.
    expect((error as AppError).message).not.toContain("boom internals");
    expect((error as AppError).message).not.toContain("SOMETHING_WEIRD");
  });
});

// ── 10. Request-local counters ────────────────────────────────────────────────

describe("ChatOrchestrator — request-local counters", () => {
  it("resets per-tool execution counts for the next user turn", async () => {
    const webSearch = createPolicyTool("web_search", 1);
    const { client } = createRecordingClient([
      // Turn 1: a web_search that executes, then a plain-text final answer.
      ...toolCallRound("web_search", "call_1", "{}"),
      ...answerRound("turn one"),
      // Turn 2: another web_search, then a plain-text final answer.
      ...toolCallRound("web_search", "call_2", "{}"),
      ...answerRound("turn two"),
    ]);
    const orchestrator = new ChatOrchestrator(client);

    // First turn: web_search executes exactly once.
    await collect(
      orchestrator.stream({
        providerConfig: CONFIG,
        messages: [userMessage("x")],
        tools: createRegistry([webSearch]),
      }),
    );
    expect(webSearch.execute).toHaveBeenCalledTimes(1);

    // Second turn on the same instance: the counter is local to each turn, so
    // web_search runs again. A stale counter would block it and the count
    // would stay at 1.
    await collect(
      orchestrator.stream({
        providerConfig: CONFIG,
        messages: [userMessage("x")],
        tools: createRegistry([webSearch]),
      }),
    );
    expect(webSearch.execute).toHaveBeenCalledTimes(2);
  });
});
