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

function mockFetchHttpError(status: number) {
  return ((url: string, _: RequestInit) => {
    expect(url).toContain("/chat/completions");
    return {
      ok: false,
      status,
      statusText: status === 401 ? "Unauthorized" : "Internal Server Error",
      json: async () => ({}),
    };
  }) as unknown as typeof globalThis.fetch;
}

function mockFetchMalformed() {
  return ((url: string, _: RequestInit) => {
    expect(url).toContain("/chat/completions");
    return {
      ok: true,
      json: async () => ({
        id: "test-id",
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
}

describe("provider test endpoint", () => {
  let app: ReturnType<typeof buildApp>;

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it("returns 200 with success when provider responds correctly", async () => {
    app = buildApp();

    const mockResponse = {
      ok: true,
      json: async () => ({
        id: "test-id",
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
      url: "/api/provider/test",
      payload: {
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "test-model",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.model).toBe("test-model");
    expect(body.text).toBe("Hello! How can I help you?");
  });

  it("returns 400 when required fields are missing", async () => {
    app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/provider/test",
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("The request contains invalid fields.");
  });

  it("returns 400 when baseUrl is invalid", async () => {
    app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/provider/test",
      payload: {
        baseUrl: "not-a-valid-url",
        model: "test-model",
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("The request contains invalid fields.");
  });

  it("returns 400 when model is too long", async () => {
    app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/provider/test",
      payload: {
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "a".repeat(201),
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("The request contains invalid fields.");
  });

  it("returns 400 when timeout is negative", async () => {
    app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/provider/test",
      payload: {
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "test-model",
        timeout: -1,
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("The request contains invalid fields.");
  });

  it("returns 504 when provider request times out", async () => {
    app = buildApp();

    global.fetch = mockFetchTimeout();

    const response = await app.inject({
      method: "POST",
      url: "/api/provider/test",
      payload: {
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "test-model",
        timeout: 100,
      },
    });

    expect(response.statusCode).toBe(504);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("PROVIDER_TIMEOUT");
    expect(body.error.message).toBe("The configured provider did not respond in time.");
  });

  it("returns 502 when provider returns an invalid response", async () => {
    app = buildApp();

    global.fetch = mockFetchHttpError(500);

    const response = await app.inject({
      method: "POST",
      url: "/api/provider/test",
      payload: {
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "test-model",
      },
    });

    expect(response.statusCode).toBe(502);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("INVALID_PROVIDER_RESPONSE");
    expect(body.error.message).toBe("The provider returned an invalid response.");
  });

  it("returns 401 when provider returns unauthorized error", async () => {
    app = buildApp();

    global.fetch = mockFetchHttpError(401);

    const response = await app.inject({
      method: "POST",
      url: "/api/provider/test",
      payload: {
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "test-model",
      },
    });

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("PROVIDER_UNAUTHORIZED");
    expect(body.error.message).toBe("The provider rejected the configured credentials.");
  });

  it("returns 502 when provider returns malformed response", async () => {
    app = buildApp();

    global.fetch = mockFetchMalformed();

    const response = await app.inject({
      method: "POST",
      url: "/api/provider/test",
      payload: {
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "test-model",
      },
    });

    expect(response.statusCode).toBe(502);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("INVALID_PROVIDER_RESPONSE");
    expect(body.error.message).toBe("The provider returned an invalid response.");
  });

  it("returns 502 when provider is unreachable", async () => {
    app = buildApp();

    global.fetch = mockFetchNetworkError();

    const response = await app.inject({
      method: "POST",
      url: "/api/provider/test",
      payload: {
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "test-model",
      },
    });

    expect(response.statusCode).toBe(502);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("PROVIDER_UNREACHABLE");
    expect(body.error.message).toBe("Unable to connect to the configured provider.");
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
          id: "test-id",
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
      url: "/api/provider/test",
      payload: {
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "test-model",
        timeout: 60000,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchCalled).toBe(true);
  });
});
