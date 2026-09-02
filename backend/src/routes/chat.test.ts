import { describe, it, expect, afterEach } from "vitest";
import { buildApp } from "../app.js";

function mockFetchSuccess(response: unknown) {
  return ((url: string, options: RequestInit) => {
    expect(url).toContain("/chat/completions");
    expect(options.method).toBe("POST");
    const contentType = options.headers as Record<string, string> | undefined;
    expect(contentType?.["Content-Type"]).toBe("application/json");
    return response;
  }) as unknown as typeof globalThis.fetch;
}

function mockFetchTimeout() {
  return ((url: string, options: RequestInit) => {
    expect(url).toContain("/chat/completions");
    expect(options.method).toBe("POST");
    const contentType = options.headers as Record<string, string> | undefined;
    expect(contentType?.["Content-Type"]).toBe("application/json");
    throw new DOMException("The operation timed out", "TimeoutError");
  }) as unknown as typeof globalThis.fetch;
}

function mockFetchNetworkError() {
  return (() => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof globalThis.fetch;
}

describe("chat endpoint", () => {
  let app: ReturnType<typeof buildApp>;

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it("returns 200 with normalized assistant message when provider responds correctly", async () => {
    app = buildApp();

    const mockResponse = {
      ok: true,
      json: async () => ({
        id: "chat-123",
        object: "chat.completion",
        created: Date.now(),
        model: "test-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Hello! How can I help you?" },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 15,
          total_tokens: 25,
        },
      }),
    };

    global.fetch = mockFetchSuccess(mockResponse);

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        provider: {
          baseUrl: "http://127.0.0.1:8080/v1",
          model: "test-model",
        },
        messages: [
          {
            role: "user",
            content: "Hello, respond with a short greeting.",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.message.role).toBe("assistant");
    expect(body.message.content).toBe("Hello! How can I help you?");
    expect(body.model).toBe("test-model");
    expect(body.finishReason).toBe("stop");
  });

  it("returns 400 when required fields are missing", async () => {
    app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("The request contains invalid fields.");
  });

  it("returns 400 when provider config is invalid", async () => {
    app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        provider: {
          baseUrl: "not-a-valid-url",
          model: "test-model",
        },
        messages: [
          {
            role: "user",
            content: "Hello",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("The request contains invalid fields.");
  });

  it("returns 400 when messages array is empty", async () => {
    app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        provider: {
          baseUrl: "http://127.0.0.1:8080/v1",
          model: "test-model",
        },
        messages: [],
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("The request contains invalid fields.");
  });

  it("returns 400 when message content is empty", async () => {
    app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        provider: {
          baseUrl: "http://127.0.0.1:8080/v1",
          model: "test-model",
        },
        messages: [
          {
            role: "user",
            content: "",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("The request contains invalid fields.");
  });

  it("returns 400 when message role is invalid", async () => {
    app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        provider: {
          baseUrl: "http://127.0.0.1:8080/v1",
          model: "test-model",
        },
        messages: [
          {
            role: "invalid",
            content: "Hello",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("The request contains invalid fields.");
  });

  it("returns 400 when model exceeds 200 characters", async () => {
    app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        provider: {
          baseUrl: "http://127.0.0.1:8080/v1",
          model: "a".repeat(201),
        },
        messages: [
          {
            role: "user",
            content: "Hello",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("The request contains invalid fields.");
  });

  it("returns 502 when provider returns empty message content", async () => {
    app = buildApp();

    global.fetch = ((url: string, options: RequestInit) => {
      expect(url).toContain("/chat/completions");
      expect(options.method).toBe("POST");
      return {
        ok: true,
        json: async () => ({
          id: "chat-123",
          object: "chat.completion",
          created: Date.now(),
          model: "test-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "" },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 0,
            total_tokens: 10,
          },
        }),
      };
    }) as unknown as typeof globalThis.fetch;

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        provider: {
          baseUrl: "http://127.0.0.1:8080/v1",
          model: "test-model",
        },
        messages: [
          {
            role: "user",
            content: "Hello",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(502);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("INVALID_PROVIDER_RESPONSE");
    expect(body.error.message).toBe("The provider returned an invalid response.");
  });

  it("returns 504 when provider request times out", async () => {
    app = buildApp();

    global.fetch = mockFetchTimeout();

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        provider: {
          baseUrl: "http://127.0.0.1:8080/v1",
          model: "test-model",
          timeoutMs: 100, // Very short timeout to trigger timeout quickly
        },
        messages: [
          {
            role: "user",
            content: "Hello",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(504);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("PROVIDER_TIMEOUT");
    expect(body.error.message).toBe("The configured provider did not respond in time.");
  });

  it("returns 502 when provider is unreachable", async () => {
    app = buildApp();

    global.fetch = mockFetchNetworkError();

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        provider: {
          baseUrl: "http://127.0.0.1:8080/v1",
          model: "test-model",
        },
        messages: [
          {
            role: "user",
            content: "Hello",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(502);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("PROVIDER_UNREACHABLE");
    expect(body.error.message).toBe("Unable to connect to the configured provider.");
  });

  it("returns 401 when provider returns unauthorized error", async () => {
    app = buildApp();

    global.fetch = ((url: string, _: RequestInit) => {
      expect(url).toContain("/chat/completions");
      return {
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        json: async () => ({}),
      };
    }) as unknown as typeof globalThis.fetch;

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        provider: {
          baseUrl: "http://127.0.0.1:8080/v1",
          model: "test-model",
        },
        messages: [
          {
            role: "user",
            content: "Hello",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("PROVIDER_UNAUTHORIZED");
    expect(body.error.message).toBe("The provider rejected the configured credentials.");
  });

  it("returns 502 when provider returns malformed response", async () => {
    app = buildApp();

    global.fetch = ((url: string, _: RequestInit) => {
      expect(url).toContain("/chat/completions");
      return {
        ok: true,
        json: async () => ({
          id: "chat-123",
          object: "chat.completion",
          created: Date.now(),
          model: "test-model",
          choices: [],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 0,
            total_tokens: 10,
          },
        }),
      };
    }) as unknown as typeof globalThis.fetch;

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        provider: {
          baseUrl: "http://127.0.0.1:8080/v1",
          model: "test-model",
        },
        messages: [
          {
            role: "user",
            content: "Hello",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(502);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("INVALID_PROVIDER_RESPONSE");
    expect(body.error.message).toBe("The provider returned an invalid response.");
  });

  it("uses custom timeout when provided without error", async () => {
    app = buildApp();

    let fetchCalled = false;

    global.fetch = ((url: string, options: RequestInit) => {
      fetchCalled = true;
      expect(url).toContain("/chat/completions");
      expect(options.method).toBe("POST");
      const contentType = options.headers as Record<string, string> | undefined;
      expect(contentType?.["Content-Type"]).toBe("application/json");
      return {
        ok: true,
        json: async () => ({
          id: "chat-123",
          object: "chat.completion",
          created: Date.now(),
          model: "test-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Test response" },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
        }),
      };
    }) as unknown as typeof globalThis.fetch;

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        provider: {
          baseUrl: "http://127.0.0.1:8080/v1",
          model: "test-model",
          timeoutMs: 60000,
        },
        messages: [
          {
            role: "user",
            content: "Hello",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchCalled).toBe(true);
  });

  it("returns 200 when provider returns different model name", async () => {
    app = buildApp();

    global.fetch = ((url: string, _: RequestInit) => {
      expect(url).toContain("/chat/completions");
      return {
        ok: true,
        json: async () => ({
          id: "chat-123",
          object: "chat.completion",
          created: Date.now(),
          model: "llama3-8b",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "I'm a different model!" },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 5,
            completion_tokens: 10,
            total_tokens: 15,
          },
        }),
      };
    }) as unknown as typeof globalThis.fetch;

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        provider: {
          baseUrl: "http://127.0.0.1:8080/v1",
          model: "test-model",
        },
        messages: [
          {
            role: "user",
            content: "Hello",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.model).toBe("llama3-8b");
    expect(body.message.content).toBe("I'm a different model!");
  });

  describe("document context integration", () => {
    it("includes document context in request when document is provided", async () => {
      app = buildApp();

      let capturedBody: Record<string, unknown> | null = null;
      const mockResponse = {
        ok: true,
        json: async () => ({
          id: "chat-123",
          object: "chat.completion",
          created: Date.now(),
          model: "test-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Response" },
              finish_reason: "stop",
            },
          ],
        }),
      };

      global.fetch = ((_: string, options: RequestInit) => {
        capturedBody = JSON.parse(options.body as string) as Record<string, unknown>;
        return mockResponse;
      }) as unknown as typeof globalThis.fetch;

      const response = await app.inject({
        method: "POST",
        url: "/api/chat",
        payload: {
          provider: {
            baseUrl: "http://127.0.0.1:8080/v1",
            model: "test-model",
          },
          messages: [
            {
              role: "user",
              content: "What is the main conclusion?",
            },
          ],
          document: {
            fileId: "uuid-123",
            filename: "report.pdf",
            text: "Quarterly Report: Revenue increased by 20%.",
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(capturedBody).not.toBeNull();

      const body = capturedBody!;
      const messages = body.messages as Array<{ role: string; content: string }>;

      expect(messages.length).toBe(3);
      // [0] = system policy (no document text)
      expect(messages[0].role).toBe("system");
      expect(messages[0].content).toContain("report.pdf");
      expect(messages[0].content).toContain("untrusted reference material");
      expect(messages[0].content).not.toContain("Quarterly Report");
      // [1] = user message with document content
      expect(messages[1].role).toBe("user");
      expect(messages[1].content).toContain("Quarterly Report: Revenue increased by 20%");
      expect(messages[1].content).toContain("<document>");
      // [2] = actual user message
      expect(messages[2].role).toBe("user");
      expect(messages[2].content).toBe("What is the main conclusion?");
    });

    it("does not include document context when document is omitted", async () => {
      app = buildApp();

      let capturedBody: Record<string, unknown> | null = null;
      const mockResponse = {
        ok: true,
        json: async () => ({
          id: "chat-123",
          object: "chat.completion",
          created: Date.now(),
          model: "test-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Response" },
              finish_reason: "stop",
            },
          ],
        }),
      };

      global.fetch = ((_: string, options: RequestInit) => {
        capturedBody = JSON.parse(options.body as string) as Record<string, unknown>;
        return mockResponse;
      }) as unknown as typeof globalThis.fetch;

      const response = await app.inject({
        method: "POST",
        url: "/api/chat",
        payload: {
          provider: {
            baseUrl: "http://127.0.0.1:8080/v1",
            model: "test-model",
          },
          messages: [
            {
              role: "user",
              content: "Hello",
            },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(capturedBody).not.toBeNull();

      const body = capturedBody!;
      const messages = body.messages as Array<{ role: string; content: string }>;

      expect(messages.length).toBe(1);
      expect(messages[0].role).toBe("user");
    });

    it("rejects request with invalid document schema", async () => {
      app = buildApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/chat",
        payload: {
          provider: {
            baseUrl: "http://127.0.0.1:8080/v1",
            model: "test-model",
          },
          messages: [
            {
              role: "user",
              content: "Hello",
            },
          ],
          document: "invalid",
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("The request contains invalid fields.");
    });
  });
});

// ── Streaming endpoint tests ─────────────────────────────────────────────────

describe("chat/stream endpoint", () => {
  let app: ReturnType<typeof buildApp>;

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it("returns 400 when required fields are missing", async () => {
    app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/chat/stream",
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("The request contains invalid fields.");
  });

  it("returns 400 when provider config is invalid", async () => {
    app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/chat/stream",
      payload: {
        provider: {
          baseUrl: "not-a-valid-url",
          model: "test-model",
        },
        messages: [
          {
            role: "user",
            content: "Hello",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("The request contains invalid fields.");
  });

  it("returns 400 when messages array is empty", async () => {
    app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/chat/stream",
      payload: {
        provider: {
          baseUrl: "http://127.0.0.1:8080/v1",
          model: "test-model",
        },
        messages: [],
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("The request contains invalid fields.");
  });

  it("returns 400 when message content is empty", async () => {
    app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/chat/stream",
      payload: {
        provider: {
          baseUrl: "http://127.0.0.1:8080/v1",
          model: "test-model",
        },
        messages: [
          {
            role: "user",
            content: "",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("The request contains invalid fields.");
  });

  it("returns 400 when message role is invalid", async () => {
    app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/chat/stream",
      payload: {
        provider: {
          baseUrl: "http://127.0.0.1:8080/v1",
          model: "test-model",
        },
        messages: [
          {
            role: "invalid",
            content: "Hello",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("The request contains invalid fields.");
  });

  it("returns 200 with error SSE event when provider is unreachable", async () => {
    app = buildApp();

    global.fetch = ((url: string, options: RequestInit) => {
      expect(url).toContain("/chat/completions");
      expect(options.method).toBe("POST");
      const body = JSON.parse(options.body as string);
      expect(body.stream).toBe(true);
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;

    const response = await app.inject({
      method: "POST",
      url: "/api/chat/stream",
      payload: {
        provider: {
          baseUrl: "http://127.0.0.1:8080/v1",
          model: "test-model",
        },
        messages: [
          {
            role: "user",
            content: "Hello",
          },
        ],
      },
    });

    // SSE endpoint always returns 200, errors are in SSE events
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/event-stream");
    expect(response.body).toContain("event: error");
    expect(response.body).toContain("Unable to connect to the configured provider");
  });

  it("returns 200 with error SSE event when provider request times out", async () => {
    app = buildApp();

    global.fetch = ((url: string, options: RequestInit) => {
      expect(url).toContain("/chat/completions");
      expect(options.method).toBe("POST");
      throw new DOMException("The operation timed out", "TimeoutError");
    }) as unknown as typeof globalThis.fetch;

    const response = await app.inject({
      method: "POST",
      url: "/api/chat/stream",
      payload: {
        provider: {
          baseUrl: "http://127.0.0.1:8080/v1",
          model: "test-model",
          timeoutMs: 100,
        },
        messages: [
          {
            role: "user",
            content: "Hello",
          },
        ],
      },
    });

    // SSE endpoint always returns 200, errors are in SSE events
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/event-stream");
    expect(response.body).toContain("event: error");
    expect(response.body).toContain("The configured provider did not respond in time");
  });

  it("returns 200 with error SSE event when provider returns unauthorized", async () => {
    app = buildApp();

    global.fetch = ((url: string, _: RequestInit) => {
      expect(url).toContain("/chat/completions");
      return {
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        body: null,
        headers: new Headers(),
      };
    }) as unknown as typeof globalThis.fetch;

    const response = await app.inject({
      method: "POST",
      url: "/api/chat/stream",
      payload: {
        provider: {
          baseUrl: "http://127.0.0.1:8080/v1",
          model: "test-model",
        },
        messages: [
          {
            role: "user",
            content: "Hello",
          },
        ],
      },
    });

    // SSE endpoint always returns 200, errors are in SSE events
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/event-stream");
    expect(response.body).toContain("event: error");
    expect(response.body).toContain("The provider rejected the configured credentials");
  });

  it("sends SSE headers when provider returns a stream", async () => {
    app = buildApp();

    // Create a mock ReadableStream that returns SSE events
    const mockStream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        
        // First event: delta
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'));
        
        // Second event: delta
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":" World"}}]}\n\n'));
        
        // Third event: done
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        
        controller.close();
      },
    });

    global.fetch = ((url: string, options: RequestInit) => {
      expect(url).toContain("/chat/completions");
      expect(options.method).toBe("POST");
      const body = JSON.parse(options.body as string);
      expect(body.stream).toBe(true);
      
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        body: mockStream,
        headers: new Headers({
          "content-type": "text/event-stream",
        }),
      };
    }) as unknown as typeof globalThis.fetch;

    const response = await app.inject({
      method: "POST",
      url: "/api/chat/stream",
      payload: {
        provider: {
          baseUrl: "http://127.0.0.1:8080/v1",
          model: "test-model",
        },
        messages: [
          {
            role: "user",
            content: "Hello",
          },
        ],
      },
    });

    // Fastify's inject may buffer the response, so we check headers
    expect(response.headers["content-type"]).toBe("text/event-stream");
    expect(response.headers["cache-control"]).toBe("no-cache");
    expect(response.headers["connection"]).toBe("keep-alive");
  });

  it("sends start event with model name", async () => {
    app = buildApp();

    const mockStream = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });

    global.fetch = ((_url: string, options: RequestInit) => {
      const body = JSON.parse(options.body as string);
      expect(body.stream).toBe(true);
      
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        body: mockStream,
        headers: new Headers({
          "content-type": "text/event-stream",
        }),
      };
    }) as unknown as typeof globalThis.fetch;

    const response = await app.inject({
      method: "POST",
      url: "/api/chat/stream",
      payload: {
        provider: {
          baseUrl: "http://127.0.0.1:8080/v1",
          model: "llama3-8b",
        },
        messages: [
          {
            role: "user",
            content: "Hello",
          },
        ],
      },
    });

    // The response body should contain the start event
    const body = response.body;
    expect(body).toContain('event: start');
    expect(body).toContain('"model":"llama3-8b"');
  });

  it("streams deltas from provider", async () => {
    app = buildApp();

    const mockStream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        
        // Delta events
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n'));
        
        // Done event
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        
        controller.close();
      },
    });

    global.fetch = ((_url: string, _options: RequestInit) => {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        body: mockStream,
        headers: new Headers({
          "content-type": "text/event-stream",
        }),
      };
    }) as unknown as typeof globalThis.fetch;

    const response = await app.inject({
      method: "POST",
      url: "/api/chat/stream",
      payload: {
        provider: {
          baseUrl: "http://127.0.0.1:8080/v1",
          model: "test-model",
        },
        messages: [
          {
            role: "user",
            content: "Hello",
          },
        ],
      },
    });

    const body = response.body;
    expect(body).toContain('event: delta');
    expect(body).toContain('"text":"Hel"');
    expect(body).toContain('"text":"lo"');
    expect(body).toContain('event: done');
  });

  it("sends error event when stream ends without [DONE]", async () => {
    app = buildApp();

    const mockStream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        
        // Delta event
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'));
        
        // Stream ends without [DONE]
        controller.close();
      },
    });

    global.fetch = ((_url: string, _options: RequestInit) => {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        body: mockStream,
        headers: new Headers({
          "content-type": "text/event-stream",
        }),
      };
    }) as unknown as typeof globalThis.fetch;

    const response = await app.inject({
      method: "POST",
      url: "/api/chat/stream",
      payload: {
        provider: {
          baseUrl: "http://127.0.0.1:8080/v1",
          model: "test-model",
        },
        messages: [
          {
            role: "user",
            content: "Hello",
          },
        ],
      },
    });

    const body = response.body;
    expect(body).toContain('event: delta');
    expect(body).toContain('"text":"Hello"');
    expect(body).toContain('event: error');
    expect(body).toContain('Stream ended without [DONE]');
  });
});
