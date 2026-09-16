import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenAICompatibleClient } from "../client.js";
import type { ToolDefinition } from "../../tools/types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

// Internal generic tool definition (the shape the tool layer produces). The
// client converts this to the OpenAI wire shape before sending.
const TOOL_DEFINITION: ToolDefinition = {
  name: "web_search",
  description: "Search the web",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

// The OpenAI Chat Completions wire shape the client serializes each definition
// into (`{ type: "function", function: { name, description, parameters } }`).
const WIRE_TOOL = {
  type: "function" as const,
  function: {
    name: "web_search",
    description: "Search the web",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function capturedBody(fetchMock: { mock: { calls: unknown[] } }): Record<string, unknown> {
  const call = fetchMock.mock.calls[0] as [string, { body: string }];
  return JSON.parse(call[1].body) as Record<string, unknown>;
}

const CONFIG = { baseUrl: "http://localhost:8080/v1", model: "m", timeoutMs: 120_000 };
const MESSAGES = [{ role: "user", content: "hi" }] satisfies Array<{
  role: "system" | "user" | "assistant";
  content: string;
}>;

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Non-streaming chat() tool support ────────────────────────────────────────

describe("chat() tool options", () => {
  it("omits tools and tool_choice when no tools are provided", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(
      jsonResponse({
        choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      }),
    );

    const client = new OpenAICompatibleClient("http://localhost:8080/v1");
    await client.chat(CONFIG, MESSAGES);

    const body = capturedBody(fetchMock);
    // Identical to v1.0.0: no tools/tool_choice and no stream key.
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body).not.toHaveProperty("stream");
  });

  it("omits tools and tool_choice when the tools array is empty", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(
      jsonResponse({ choices: [{ message: { role: "assistant", content: "hi" } }] }),
    );

    const client = new OpenAICompatibleClient("http://localhost:8080/v1");
    await client.chat(CONFIG, MESSAGES, { tools: [] });

    const body = capturedBody(fetchMock);
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
  });

  it("sends tools and defaults tool_choice to auto", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(
      jsonResponse({ choices: [{ message: { role: "assistant", content: "hi" } }] }),
    );

    const client = new OpenAICompatibleClient("http://localhost:8080/v1");
    await client.chat(CONFIG, MESSAGES, { tools: [TOOL_DEFINITION] });

    const body = capturedBody(fetchMock);
    // The internal definition is converted to the OpenAI wire shape.
    expect(body.tools).toEqual([WIRE_TOOL]);
    expect(body.tool_choice).toBe("auto");
  });

  it("honors an explicit tool_choice of none", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(
      jsonResponse({ choices: [{ message: { role: "assistant", content: "hi" } }] }),
    );

    const client = new OpenAICompatibleClient("http://localhost:8080/v1");
    await client.chat(CONFIG, MESSAGES, { tools: [TOOL_DEFINITION], toolChoice: "none" });

    const body = capturedBody(fetchMock);
    expect(body.tools).toEqual([WIRE_TOOL]);
    expect(body.tool_choice).toBe("none");
  });

  it("represents a non-streaming tool-call response (content null + tool_calls)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(
      jsonResponse({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_123",
                  type: "function",
                  function: { name: "web_search", arguments: '{"query":"x"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );

    const client = new OpenAICompatibleClient("http://localhost:8080/v1");
    const response = await client.chat(CONFIG, MESSAGES);

    const message = response.choices[0].message;
    expect(message.content).toBeNull();
    expect(message.tool_calls).toEqual([
      {
        id: "call_123",
        type: "function",
        function: { name: "web_search", arguments: '{"query":"x"}' },
      },
    ]);
  });
});

// ── Streaming chatStream() tool support ──────────────────────────────────────

describe("chatStream() tool options", () => {
  function stubStreamFetch(): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const response = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "text/event-stream" : null,
      },
      body: stream,
    } as unknown as Response;
    fetchMock.mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("omits tools and tool_choice when no tools are provided", async () => {
    const fetchMock = stubStreamFetch();
    const client = new OpenAICompatibleClient("http://localhost:8080/v1");

    const stream = await client.chatStream(CONFIG, MESSAGES);
    expect(stream.getReader()).toBeDefined();

    const body = capturedBody(fetchMock);
    expect(body.stream).toBe(true);
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
  });

  it("sends tools and defaults tool_choice to auto", async () => {
    const fetchMock = stubStreamFetch();
    const client = new OpenAICompatibleClient("http://localhost:8080/v1");

    await client.chatStream(CONFIG, MESSAGES, { tools: [TOOL_DEFINITION] });

    const body = capturedBody(fetchMock);
    expect(body.stream).toBe(true);
    expect(body.tools).toEqual([WIRE_TOOL]);
    expect(body.tool_choice).toBe("auto");
  });

  it("honors an explicit tool_choice of none", async () => {
    const fetchMock = stubStreamFetch();
    const client = new OpenAICompatibleClient("http://localhost:8080/v1");

    await client.chatStream(CONFIG, MESSAGES, {
      tools: [TOOL_DEFINITION],
      toolChoice: "none",
    });

    const body = capturedBody(fetchMock);
    expect(body.tool_choice).toBe("none");
  });
});
