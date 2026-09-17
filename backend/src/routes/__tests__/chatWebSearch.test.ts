import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildApp } from "../../app.js";
import { config } from "../../config/env.js";
import type { Tool } from "../../tools/types.js";
import { createWebSearchTool } from "../../tools/webSearchTool.js";
import { TavilySearchProvider } from "../../search/tavily.js";
import { createToolRegistry } from "../../tools/registry.js";

// Capture the native fetch so real-network tests (if any) can still reach the
// test server through it.
const nativeFetch = globalThis.fetch;

/**
 * Turn a list of SSE payloads into a `ReadableStream` the real SSE parser can
 * consume. A payload is either the `[DONE]` marker or an OpenAI-style streaming
 * JSON object.
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
  url: string;
  method?: string;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
}

/** Base SSE headers returned by the streaming provider fakes below. */
function sseResponse(body: ReadableStream<Uint8Array>) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    body,
    headers: new Headers({ "content-type": "text/event-stream" }),
  };
}

/**
 * A fetch fake that drives a full web-search turn:
 *   - round 1 chat completions (with tools) → model requests `web_search`;
 *   - Tavily `/search` → normalized results;
 *   - round 2 chat completions (no tools) → final streamed answer.
 *
 * Every call is recorded so tests can assert on the endpoint, the Bearer key,
 * and that the backend-owned base URL was used.
 */
function createWebSearchFetch(): {
  fetchMock: typeof globalThis.fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];

  const fetchMock = ((url: string, options: RequestInit) => {
    const recorded: RecordedCall = {
      url: String(url),
      method: options.method,
      body: options.body
        ? (JSON.parse(options.body as string) as Record<string, unknown>)
        : undefined,
      headers: (options.headers as Record<string, string>) ?? undefined,
    };
    calls.push(recorded);

    // Tavily Search API — backend-owned endpoint, request cannot override it.
    if (String(url).includes("/search")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            {
              title: "Cats",
              url: "https://example.com/cats",
              content: "Cats are popular pets.",
              score: 0.9,
            },
          ],
        }),
      });
    }

    // Round 1: the request carries tools, so the model requests a tool call.
    if (Array.isArray(recorded.body?.tools) && recorded.body.tools.length > 0) {
      return Promise.resolve(
        sseResponse(
          sseStream([
            {
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_web",
                        type: "function",
                        function: { name: "web_search", arguments: '{"query":"cats"}' },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
            "[DONE]",
          ]),
        ),
      );
    }

    // Round 2: final streamed answer.
    return Promise.resolve(
      sseResponse(
        sseStream([
          { choices: [{ index: 0, delta: { content: "Cats are" }, finish_reason: null }], finish_reason: null },
          { choices: [{ index: 0, delta: { content: " pets." }, finish_reason: null }], finish_reason: null },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          "[DONE]",
        ]),
      ),
    );
  }) as unknown as typeof globalThis.fetch;

  return { fetchMock, calls };
}

describe("web search chat integration", () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    global.fetch = nativeFetch;
  });

  afterEach(async () => {
    global.fetch = nativeFetch;
    if (app) {
      await app.close();
    }
  });

  it("rejects an enabled web search request on the non-streaming endpoint", async () => {
    app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        provider: { baseUrl: "http://127.0.0.1:8080/v1", model: "test-model" },
        messages: [{ role: "user", content: "Hello" }],
        webSearch: { enabled: true, provider: "tavily", apiKey: "tavily-key" },
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("keeps the v1.0.0 behavior on the non-streaming endpoint when web search is disabled", async () => {
    app = buildApp();
    global.fetch = (() => {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          id: "chat-1",
          model: "test-model",
          choices: [
            { index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" },
          ],
        }),
      });
    }) as unknown as typeof globalThis.fetch;

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        provider: { baseUrl: "http://127.0.0.1:8080/v1", model: "test-model" },
        messages: [{ role: "user", content: "Hello" }],
        webSearch: { enabled: false, provider: "tavily" },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.message.content).toBe("Hi");
  });

  it("runs a full web search turn on the streaming endpoint using the backend-owned base URL", async () => {
    app = buildApp();
    const { fetchMock, calls } = createWebSearchFetch();
    global.fetch = fetchMock;

    const response = await app.inject({
      method: "POST",
      url: "/api/chat/stream",
      payload: {
        provider: { baseUrl: "http://127.0.0.1:8080/v1", model: "test-model" },
        messages: [{ role: "user", content: "Tell me about cats" }],
        webSearch: { enabled: true, provider: "tavily", apiKey: "tavily-secret-key" },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.body;

    // Existing SSE contract is preserved.
    expect(body).toContain("event: start");
    expect(body).toContain("event: delta");
    expect(body).toContain("event: done");
    expect(body).not.toContain("event: error");
    // The final answer is streamed across deltas; assert the full content is
    // present across the delta events.
    expect(body).toContain("Cats are");
    expect(body).toContain(" pets.");

    // Tool lifecycle is exposed as structured events in the deterministic order
    // start -> tool_start -> tool_end -> sources -> delta... -> done.
    const pos = (name: string) => body.indexOf(`event: ${name}`);
    expect(pos("tool_start")).toBeGreaterThan(-1);
    expect(pos("tool_start")).toBeLessThan(pos("tool_end"));
    expect(pos("tool_end")).toBeLessThan(pos("sources"));
    expect(pos("sources")).toBeLessThan(pos("delta"));

    // tool_start carries the tool name and the safe query only.
    expect(body).toContain('"name":"web_search"');
    expect(body).toContain('"query":"cats"');

    // Sources are backend-grounded: id + title + url only, no content/score.
    expect(body).toContain("event: sources");
    expect(body).toContain('"id":1');
    expect(body).toContain('"title":"Cats"');
    expect(body).toContain('"url":"https://example.com/cats"');
    expect(body).not.toContain("popular"); // result content is not forwarded
    expect(body).not.toContain("0.9"); // provider-only score is not forwarded

    // The Tavily call targets the backend-configured base URL (request-scoped),
    // never a caller-provided one.
    const tavilyCall = calls.find((call) => call.url.includes("/search"));
    expect(tavilyCall?.url).toBe(`${config.TAVILY_BASE_URL}/search`);
    expect(tavilyCall?.method).toBe("POST");
  });

  it("never leaks the request-scoped API key through SSE events", async () => {
    app = buildApp();
    const { fetchMock } = createWebSearchFetch();
    global.fetch = fetchMock;

    const response = await app.inject({
      method: "POST",
      url: "/api/chat/stream",
      payload: {
        provider: { baseUrl: "http://127.0.0.1:8080/v1", model: "test-model" },
        messages: [{ role: "user", content: "Tell me about cats" }],
        webSearch: { enabled: true, provider: "tavily", apiKey: "tavily-secret-key" },
      },
    });

    expect(response.body).not.toContain("tavily-secret-key");
  });

  it("sends the API key as a Bearer credential to Tavily", async () => {
    app = buildApp();
    const { fetchMock, calls } = createWebSearchFetch();
    global.fetch = fetchMock;

    await app.inject({
      method: "POST",
      url: "/api/chat/stream",
      payload: {
        provider: { baseUrl: "http://127.0.0.1:8080/v1", model: "test-model" },
        messages: [{ role: "user", content: "Tell me about cats" }],
        webSearch: { enabled: true, provider: "tavily", apiKey: "tavily-secret-key" },
      },
    });

    const tavilyCall = calls.find((call) => call.url.includes("/search"));
    expect(tavilyCall?.headers?.authorization).toBe("Bearer tavily-secret-key");
  });

  it("uses the plain streaming path when web search is omitted", async () => {
    app = buildApp();
    let chatCalls = 0;
    global.fetch = ((url: string) => {
      if (String(url).includes("/search")) {
        throw new Error("Tavily must not be called when web search is omitted");
      }
      chatCalls += 1;
      return Promise.resolve(
        sseResponse(
          sseStream([
            { choices: [{ index: 0, delta: { content: "Hello there" }, finish_reason: null }], finish_reason: null },
            { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
            "[DONE]",
          ]),
        ),
      );
    }) as unknown as typeof globalThis.fetch;

    const response = await app.inject({
      method: "POST",
      url: "/api/chat/stream",
      payload: {
        provider: { baseUrl: "http://127.0.0.1:8080/v1", model: "test-model" },
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("event: delta");
    expect(response.body).toContain("Hello there");
    expect(chatCalls).toBe(1);

    // No web search: the plain v1.0.0 path emits no tool lifecycle/source events.
    expect(response.body).not.toContain("event: tool_start");
    expect(response.body).not.toContain("event: tool_end");
    expect(response.body).not.toContain("event: sources");
  });

  describe("buildWebSearchTool under test", () => {
    it("constructs a Tavily-backed web_search tool with backend base URL and request-scoped key", () => {
      const provider = new TavilySearchProvider({
        baseUrl: config.TAVILY_BASE_URL,
        apiKey: "tavily-secret-key",
      });
      const tool: Tool = createWebSearchTool(
        { maxResults: 5, searchDepth: "basic" },
        provider,
      );
      const registry = createToolRegistry();
      registry.register(tool);

      const definitions = registry.listDefinitions();
      expect(definitions).toHaveLength(1);
      expect(definitions[0].name).toBe("web_search");
    });
  });
});
