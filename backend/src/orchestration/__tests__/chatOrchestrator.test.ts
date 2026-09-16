import { describe, it, expect, vi } from "vitest";
import { ChatOrchestrator } from "../chatOrchestrator.js";
import type { ProviderClient } from "../../provider/types.js";
import type { ProviderConfig } from "../../provider/schemas.js";
import type { Tool, ToolRegistry } from "../../tools/types.js";
import { OpenAICompatibleClient, ProviderClientError } from "../../provider/client.js";

// ── Test helpers ─────────────────────────────────────────────────────────────

/**
 * Turn a list of SSE payloads into a `ReadableStream` of UTF-8 bytes that the
 * real SSE parser can consume. A payload is either the `[DONE]` marker string
 * or an OpenAI-style streaming JSON object.
 */
function sseStream(events: Array<string | Record<string, unknown>>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        const line = typeof event === "string" ? event : JSON.stringify(event);
        controller.enqueue(encoder.encode(`data: ${line}\n\n`));
      }
      controller.close();
    },
  });
}

interface RecordedCall {
  config: ProviderConfig;
  messages: unknown;
  options?: unknown;
}

/**
 * A recording fake provider client. `chatStream` returns the next SSE stream
 * per call, splitting the flat event list at each `[DONE]` marker so round 1
 * and round 2 each get exactly their own events (as a real provider would).
 * Records every call (config, messages, options) so tests can assert on the
 * round-1 / round-2 request shape.
 */
function createRecordingClient(sse: Array<string | Record<string, unknown>>): {
  client: ProviderClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];

  const rounds: Array<Array<string | Record<string, unknown>>> = [];
  let current: Array<string | Record<string, unknown>> = [];
  for (const event of sse) {
    current.push(event);
    if (event === "[DONE]") {
      rounds.push(current);
      current = [];
    }
  }
  if (current.length > 0) {
    rounds.push(current);
  }

  let round = 0;
  const client = {
    chat: vi.fn(),
    chatStream: vi.fn((_config: ProviderConfig, _messages: unknown, _options?: unknown) => {
      calls.push({ config: _config, messages: _messages, options: _options });
      return sseStream(rounds[round++] ?? []);
    }),
  } as unknown as ProviderClient;

  return { client, calls };
}

/** A registry that resolves a single (or none) tool by name. */
function createRegistry(tool?: Tool): ToolRegistry {
  const map = new Map<string, Tool>();
  if (tool) {
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

/** A simple in-memory tool whose result is fixed and whose execute is spyable. */
function createTool(
  name: string,
  resultContent: string,
  executeImpl?: (args: unknown, context: { signal?: AbortSignal }) => Promise<{ content: string }>,
): Tool {
  return {
    definition: {
      name,
      description: "A test tool",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
    },
    execute: vi.fn(executeImpl ?? (async () => ({ content: resultContent }))),
  };
}

/** Collect every event an orchestrator generator yields. */
async function collect(
  gen: AsyncGenerator<{ type: string; text?: string }>,
): Promise<Array<{ type: string; text?: string }>> {
  const events: Array<{ type: string; text?: string }> = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

const CONFIG: ProviderConfig = {
  baseUrl: "http://localhost:8080/v1",
  model: "test-model",
  timeoutMs: 10_000,
};

function userMessage(content: string) {
  return { role: "user" as const, content };
}

// ── No tools (pass-through equivalence) ───────────────────────────────────────

describe("ChatOrchestrator — no tools", () => {
  it("streams text live and emits done, without buffering", async () => {
    const { client, calls } = createRecordingClient([
      { choices: [{ delta: { content: "Hel" } }] },
      { choices: [{ delta: { content: "lo" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      "[DONE]",
    ]);
    const events = await collect(
      new ChatOrchestrator(client).stream({
        providerConfig: CONFIG,
        messages: [userMessage("hi")],
      }),
    );

    expect(events).toEqual([
      { type: "delta", text: "Hel" },
      { type: "delta", text: "lo" },
      { type: "done" },
    ]);
    // No tools attached on the single (pass-through) round.
    expect((calls[0].options as { tools?: unknown }).tools).toBeUndefined();
  });

  it("treats an empty registry like no tools", async () => {
    const { client } = createRecordingClient([
      { choices: [{ delta: { content: "hi" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      "[DONE]",
    ]);
    const events = await collect(
      new ChatOrchestrator(client).stream({
        providerConfig: CONFIG,
        messages: [userMessage("hi")],
        tools: createRegistry(),
      }),
    );

    expect(events).toEqual([
      { type: "delta", text: "hi" },
      { type: "done" },
    ]);
  });
});

// ── Round 1 with tools, no tool call ──────────────────────────────────────────

describe("ChatOrchestrator — tools available, model does not call", () => {
  it("flushes the buffered first-round text as the final answer", async () => {
    const { client, calls } = createRecordingClient([
      { choices: [{ delta: { content: "Let me answer directly." } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      "[DONE]",
    ]);
    const events = await collect(
      new ChatOrchestrator(client).stream({
        providerConfig: CONFIG,
        messages: [userMessage("hi")],
        tools: createRegistry(createTool("web_search", "result")),
      }),
    );

    expect(events).toEqual([
      { type: "delta", text: "Let me answer directly." },
      { type: "done" },
    ]);

    // Round 1 attached the tool definitions; the model never called it.
    expect(calls.length).toBe(1);
    expect((calls[0].options as { tools?: unknown }).tools).toHaveLength(1);
  });
});

// ── Round 1 with tools, valid tool call ───────────────────────────────────────

const TOOL_CALL_EVENTS = [
  { choices: [{ delta: { content: "Searching..." } }] },
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "web_search", arguments: '{"query":"weather"}' },
              },
            ],
          },
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    "[DONE]",
];

describe("ChatOrchestrator — valid single tool call", () => {
  it("executes the tool once, then streams round 2 with no tools", async () => {
    const tool = createTool("web_search", "Search results: ...");
    const { client, calls } = createRecordingClient([
      ...TOOL_CALL_EVENTS,
      // Round 2: the final answer.
      { choices: [{ delta: { content: "The weather is sunny." } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      "[DONE]",
    ]);

    const events = await collect(
      new ChatOrchestrator(client).stream({
        providerConfig: CONFIG,
        messages: [userMessage("what is the weather")],
        tools: createRegistry(tool),
      }),
    );

    // The pre-tool filler text is discarded; only round 2 text is visible.
    expect(events).toEqual([
      { type: "delta", text: "The weather is sunny." },
      { type: "done" },
    ]);

    // Tool executed exactly once with parsed args.
    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(tool.execute).toHaveBeenCalledWith({ query: "weather" }, { signal: undefined });

    // Round 1 attached tools; round 2 omitted them.
    expect(calls.length).toBe(2);
    expect((calls[0].options as { tools?: unknown }).tools).toHaveLength(1);
    expect((calls[1].options as { tools?: unknown }).tools).toBeUndefined();

    // Round-2 request carries the internal assistant tool-call + tool-result
    // messages after the original user message.
    const round2 = calls[1].messages as Array<{ role: string; [key: string]: unknown }>;
    expect(round2).toHaveLength(3);
    expect(round2[0]).toMatchObject({ role: "user", content: "what is the weather" });
    expect(round2[1]).toMatchObject({
      role: "assistant",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "web_search" } }],
    });
    expect(round2[2]).toMatchObject({ role: "tool", tool_call_id: "call_1" });
    expect(round2[2].content).toBe("Search results: ...");
  });

  it("passes the cancellation signal through to the tool", async () => {
    const tool = createTool("web_search", "result");
    const { client } = createRecordingClient([...TOOL_CALL_EVENTS, ...DONE_ANSWER()]);
    const controller = new AbortController();

    await collect(
      new ChatOrchestrator(client).stream({
        providerConfig: CONFIG,
        messages: [userMessage("x")],
        tools: createRegistry(tool),
        signal: controller.signal,
      }),
    );

    expect(tool.execute).toHaveBeenCalledWith(expect.anything(), { signal: controller.signal });
  });
});

function DONE_ANSWER(): Array<string | Record<string, unknown>> {
  return [
    { choices: [{ delta: { content: "final" } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }], },
    "[DONE]",
  ];
}

// ── Invalid tool calls ────────────────────────────────────────────────────────

describe("ChatOrchestrator — invalid tool calls", () => {
  function toolCallEvents(delta: Record<string, unknown>): Array<string | Record<string, unknown>> {
    return [
      { choices: [{ delta }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      "[DONE]",
    ];
  }

  it("throws TOOL_NOT_FOUND for an unknown tool name", async () => {
    const { client } = createRecordingClient(
      toolCallEvents({
        tool_calls: [
          { index: 0, id: "call_1", type: "function", function: { name: "unknown_tool", arguments: "{}" } },
        ],
      }),
    );

    await expect(
      collect(
        new ChatOrchestrator(client).stream({
          providerConfig: CONFIG,
          messages: [userMessage("x")],
          tools: createRegistry(createTool("web_search", "result")),
        }),
      ),
    ).rejects.toMatchObject({ code: "TOOL_NOT_FOUND", statusCode: 502 });
  });

  it("throws TOOL_INVALID_ARGUMENTS for malformed JSON arguments", async () => {
    const { client } = createRecordingClient(
      toolCallEvents({
        tool_calls: [
          { index: 0, id: "call_1", type: "function", function: { name: "web_search", arguments: "{not json}" } },
        ],
      }),
    );

    await expect(
      collect(
        new ChatOrchestrator(client).stream({
          providerConfig: CONFIG,
          messages: [userMessage("x")],
          tools: createRegistry(createTool("web_search", "result")),
        }),
      ),
    ).rejects.toMatchObject({ code: "TOOL_INVALID_ARGUMENTS", statusCode: 502 });
  });

  it("throws TOOL_INVALID_ARGUMENTS when the tool call has no id", async () => {
    const { client } = createRecordingClient(
      toolCallEvents({
        tool_calls: [
          { index: 0, type: "function", function: { name: "web_search", arguments: "{}" } },
        ],
      }),
    );

    await expect(
      collect(
        new ChatOrchestrator(client).stream({
          providerConfig: CONFIG,
          messages: [userMessage("x")],
          tools: createRegistry(createTool("web_search", "result")),
        }),
      ),
    ).rejects.toMatchObject({ code: "TOOL_INVALID_ARGUMENTS", statusCode: 502 });
  });

  it("throws TOOL_CALL_LIMIT_EXCEEDED for more than one tool call", async () => {
    const { client } = createRecordingClient(
      toolCallEvents({
        tool_calls: [
          { index: 0, id: "call_1", type: "function", function: { name: "web_search", arguments: "{}" } },
          { index: 1, id: "call_2", type: "function", function: { name: "web_search", arguments: "{}" } },
        ],
      }),
    );

    await expect(
      collect(
        new ChatOrchestrator(client).stream({
          providerConfig: CONFIG,
          messages: [userMessage("x")],
          tools: createRegistry(createTool("web_search", "result")),
        }),
      ),
    ).rejects.toMatchObject({ code: "TOOL_CALL_LIMIT_EXCEEDED", statusCode: 502 });
  });

  it("rejects a second tool request from round 2 with TOOL_CALL_LIMIT_EXCEEDED", async () => {
    const { client } = createRecordingClient([
      ...TOOL_CALL_EVENTS,
      // Round 2: model tries to call the tool again (should not be allowed).
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_2", type: "function", function: { name: "web_search", arguments: "{}" } },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      "[DONE]",
    ]);

    await expect(
      collect(
        new ChatOrchestrator(client).stream({
          providerConfig: CONFIG,
          messages: [userMessage("x")],
          tools: createRegistry(createTool("web_search", "result")),
        }),
      ),
    ).rejects.toMatchObject({ code: "TOOL_CALL_LIMIT_EXCEEDED", statusCode: 502 });
  });
});

// ── Tool execution errors ─────────────────────────────────────────────────────

describe("ChatOrchestrator — tool execution errors", () => {
  it("maps an unexpected failure to TOOL_EXECUTION_FAILED", async () => {
    const tool = createTool("web_search", "result", async () => {
      throw new Error("boom");
    });
    const { client } = createRecordingClient([...TOOL_CALL_EVENTS]);

    await expect(
      collect(
        new ChatOrchestrator(client).stream({
          providerConfig: CONFIG,
          messages: [userMessage("x")],
          tools: createRegistry(tool),
        }),
      ),
    ).rejects.toMatchObject({ code: "TOOL_EXECUTION_FAILED", statusCode: 502 });
  });

  it("preserves a provider error mapping instead of masking it", async () => {
    const tool = createTool("web_search", "result", async () => {
      throw new ProviderClientError(OpenAICompatibleClient.ErrorType.TIMEOUT, "provider timed out");
    });
    const { client } = createRecordingClient([...TOOL_CALL_EVENTS]);

    await expect(
      collect(
        new ChatOrchestrator(client).stream({
          providerConfig: CONFIG,
          messages: [userMessage("x")],
          tools: createRegistry(tool),
        }),
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT", statusCode: 504 });
  });
});

// ── Cancellation ──────────────────────────────────────────────────────────────

describe("ChatOrchestrator — cancellation", () => {
  it("returns silently when aborted during round 1", async () => {
    const client = {
      chat: vi.fn(),
      chatStream: vi.fn(() => sseStream([])),
    } as unknown as ProviderClient;
    const orchestrator = new ChatOrchestrator(client);
    const controller = new AbortController();
    controller.abort();

    const events = await collect(
      orchestrator.stream({
        providerConfig: CONFIG,
        messages: [userMessage("x")],
        tools: createRegistry(createTool("web_search", "result")),
        signal: controller.signal,
      }),
    );

    expect(events).toEqual([]);
    expect(client.chatStream).toHaveBeenCalledTimes(1);
  });

  it("does not start round 2 when aborted after round 1", async () => {
    // Abort inside the tool execution: round 1 completes, the tool runs, but
    // the post-tool guard must prevent round 2 from starting.
    const controller = new AbortController();
    const tool = createTool("web_search", "result", async () => {
      controller.abort();
      return { content: "result" };
    });
    const { client, calls } = createRecordingClient([...TOOL_CALL_EVENTS, ...DONE_ANSWER()]);

    const events = await collect(
      new ChatOrchestrator(client).stream({
        providerConfig: CONFIG,
        messages: [userMessage("x")],
        tools: createRegistry(tool),
        signal: controller.signal,
      }),
    );

    expect(events).toEqual([]);
    expect(tool.execute).toHaveBeenCalledTimes(1);
    // Only round 1 was issued; no round-2 request.
    expect(calls.length).toBe(1);
  });
});

// ── Context budget for the tool result ────────────────────────────────────────

describe("ChatOrchestrator — tool-result context budget", () => {
  it("truncates a large web result to fit the context window", async () => {
    const huge = `Untrusted content header.\n\n${"a".repeat(40_000)}`;
    const tool = createTool("web_search", huge);
    const { client, calls } = createRecordingClient([...TOOL_CALL_EVENTS, ...DONE_ANSWER()]);

    await collect(
      new ChatOrchestrator(client).stream({
        providerConfig: CONFIG,
        messages: [userMessage("x")],
        tools: createRegistry(tool),
        contextSizeTokens: 1024,
      }),
    );

    const round2 = calls[1].messages as Array<{ role: string; content: string }>;
    const toolResult = round2[2];
    // Truncated, and the untrusted-content header is preserved verbatim.
    expect(toolResult.content).not.toBe(huge);
    expect(toolResult.content.startsWith("Untrusted content header.")).toBe(true);
    expect(toolResult.content.length).toBeLessThan(huge.length);
  });

  it("does not truncate a small web result", async () => {
    const tool = createTool("web_search", "small result");
    const { client, calls } = createRecordingClient([...TOOL_CALL_EVENTS, ...DONE_ANSWER()]);

    await collect(
      new ChatOrchestrator(client).stream({
        providerConfig: CONFIG,
        messages: [userMessage("x")],
        tools: createRegistry(tool),
        contextSizeTokens: 1_000_000,
      }),
    );

    const round2 = calls[1].messages as Array<{ content: string }>;
    expect(round2[2].content).toBe("small result");
  });
});

// ── Internal message visibility ───────────────────────────────────────────────

describe("ChatOrchestrator — internal messages", () => {
  it("never surfaces tool-call or tool-result text as visible deltas", async () => {
    const tool = createTool("web_search", "SECRET_RESULT");
    const { client } = createRecordingClient([...TOOL_CALL_EVENTS, ...DONE_ANSWER()]);

    const events = await collect(
      new ChatOrchestrator(client).stream({
        providerConfig: CONFIG,
        messages: [userMessage("x")],
        tools: createRegistry(tool),
      }),
    );

    const visibleText = events.map((e) => e.text).join("");
    expect(visibleText).toBe("final");
    expect(visibleText).not.toContain("SECRET_RESULT");
  });
});

// ── Provider parse error ──────────────────────────────────────────────────────

describe("ChatOrchestrator — provider parse error", () => {
  it("normalizes a malformed round-1 stream into INVALID_PROVIDER_RESPONSE", async () => {
    const client = {
      chat: vi.fn(),
      // EOF without [DONE] → parser yields an error event.
      chatStream: vi.fn(() => sseStream([{ choices: [{ delta: { content: "partial" } }] }])),
    } as unknown as ProviderClient;

    await expect(
      collect(
        new ChatOrchestrator(client).stream({
          providerConfig: CONFIG,
          messages: [userMessage("x")],
          tools: createRegistry(createTool("web_search", "result")),
        }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_PROVIDER_RESPONSE" });
  });
});
