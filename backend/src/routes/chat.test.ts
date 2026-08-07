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
    expect(body.success).toBe(false);
    expect(body.error).toBe("Invalid request payload");
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
    expect(body.success).toBe(false);
    expect(body.error).toBe("Invalid request payload");
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
    expect(body.success).toBe(false);
    expect(body.error).toBe("Invalid request payload");
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
    expect(body.success).toBe(false);
    expect(body.error).toBe("Invalid request payload");
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
    expect(body.success).toBe(false);
    expect(body.error).toBe("Invalid request payload");
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
    expect(body.success).toBe(false);
    expect(body.error).toBe("Invalid request payload");
  });

  it("returns 500 when provider returns empty message content", async () => {
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

    expect(response.statusCode).toBe(500);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Provider returned an empty response");
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
    expect(body.success).toBe(false);
    expect(body.error).toBe("Provider request timed out");
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
    expect(body.success).toBe(false);
    expect(body.error).toBe("Provider connection failed");
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
    expect(body.success).toBe(false);
    expect(body.error).toBe("Provider authentication or authorization failed");
  });

  it("returns 400 when provider returns malformed response", async () => {
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

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Provider returned a malformed response");
  });

  it("returns 413 when request body exceeds 1 MB", async () => {
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
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "OK" },
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
    }) as unknown as typeof globalThis.fetch;

    const largeContent = "x".repeat(1_100_000);
    const payload = JSON.stringify({
      provider: {
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "test-model",
      },
      messages: [
        {
          role: "user",
          content: largeContent,
        },
      ],
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload,
      headers: {
        "content-type": "application/json",
      },
    });

    expect(response.statusCode).toBe(413);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(false);
    expect(body.error).toContain("exceeds maximum size");
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
});
