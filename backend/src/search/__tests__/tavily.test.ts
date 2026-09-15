import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  TavilySearchProvider,
  TAVILY_DEFAULT_TIMEOUT_MS,
} from "../tavily.js";
import { normalizeSearchBaseUrl, WEB_SEARCH_MAX_QUERY } from "../types.js";

const API_KEY = "tavily-test-api-key";
const CUSTOM_BASE_URL = "https://custom.tavily.example";

type FetchMock = ReturnType<typeof vi.fn>;

/**
 * Build a fetch mock that also rejects with an AbortError when its signal
 * aborts, so timeout/cancellation behave like real fetch.
 */
function mockFetch(behavior: () => Promise<Response> | Response): FetchMock {
  const fetchMock = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
    const signal = init?.signal;
    if (!signal) {
      return behavior();
    }
    if (signal.aborted) {
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    }
    // Reject on abort and settle from behavior(), so timeout/cancellation
    // behave like a real fetch honoring its signal.
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(behavior()).then(
        (res) => {
          signal.removeEventListener("abort", onAbort);
          resolve(res);
        },
        (err) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      );
    });
  });
  return fetchMock;
}

function stubFetch(fetchMock: FetchMock): void {
  vi.stubGlobal("fetch", fetchMock);
}

describe("normalizeSearchBaseUrl", () => {
  it("trims whitespace and strips a trailing slash", () => {
    expect(normalizeSearchBaseUrl("  https://api.tavily.com/ ")).toBe(
      "https://api.tavily.com",
    );
  });

  it("collapses accidental double slashes in the path", () => {
    expect(normalizeSearchBaseUrl("https://api.tavily.com//search")).toBe(
      "https://api.tavily.com/search",
    );
  });

  it("leaves a valid base URL unchanged", () => {
    expect(normalizeSearchBaseUrl("https://api.tavily.com")).toBe(
      "https://api.tavily.com",
    );
  });

  it("throws on an empty base URL", () => {
    expect(() => normalizeSearchBaseUrl("   ")).toThrow(/required/i);
    expect(() => normalizeSearchBaseUrl(undefined)).toThrow(/required/i);
  });

  it("throws on a non-http/https URL", () => {
    expect(() => normalizeSearchBaseUrl("ftp://api.tavily.com")).toThrow(
      /http|https/i,
    );
  });

  it("throws on a malformed URL", () => {
    expect(() => normalizeSearchBaseUrl("not a url")).toThrow(/valid URL/i);
  });
});

describe("TavilySearchProvider constructor", () => {
  it("throws when no API key is provided", () => {
    expect(
      () => new TavilySearchProvider({ baseUrl: "https://api.tavily.com", apiKey: "" }),
    ).toThrow(/API key/i);
  });
});

describe("TavilySearchProvider.search", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = mockFetch(() =>
      Promise.resolve(new Response(JSON.stringify({ results: [] }), { status: 200 })),
    );
    stubFetch(fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends the request to the injected base URL + /search", async () => {
    const provider = new TavilySearchProvider({
      baseUrl: CUSTOM_BASE_URL,
      apiKey: API_KEY,
    });

    await provider.search({ query: "cats", maxResults: 3, searchDepth: "basic" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(`${CUSTOM_BASE_URL}/search`);
  });

  it("honors a trailing-slash base URL without double slashes", async () => {
    const provider = new TavilySearchProvider({
      baseUrl: "https://custom.tavily.example/",
      apiKey: API_KEY,
    });

    await provider.search({ query: "cats", maxResults: 3, searchDepth: "basic" });

    expect(fetchMock.mock.calls[0][0]).toBe("https://custom.tavily.example/search");
  });

  it("uses the default base URL from backend config", async () => {
    const provider = new TavilySearchProvider({
      baseUrl: "https://api.tavily.com",
      apiKey: API_KEY,
    });

    await provider.search({ query: "cats", maxResults: 3, searchDepth: "basic" });

    expect(fetchMock.mock.calls[0][0]).toBe("https://api.tavily.com/search");
  });

  it("sends the API key as a Bearer authorization header", async () => {
    const provider = new TavilySearchProvider({
      baseUrl: "https://api.tavily.com",
      apiKey: API_KEY,
    });

    await provider.search({ query: "cats", maxResults: 3, searchDepth: "basic" });

    const [_url, init] = fetchMock.mock.calls[0];
    expect(init.headers.authorization).toBe(`Bearer ${API_KEY}`);
  });

  it("sends the MVP body with defaults when only the query is provided", async () => {
    const provider = new TavilySearchProvider({
      baseUrl: "https://api.tavily.com",
      apiKey: API_KEY,
    });

    await provider.search({ query: "cats", maxResults: 3, searchDepth: "basic" });

    const [_url, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      query: "cats",
      search_depth: "basic",
      max_results: 3,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
    });
  });

  it("applies request defaults (maxResults=5, searchDepth=basic)", async () => {
    const provider = new TavilySearchProvider({
      baseUrl: "https://api.tavily.com",
      apiKey: API_KEY,
    });

    await provider.search({ query: "cats" } as never);

    const [_url, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.max_results).toBe(5);
    expect(body.search_depth).toBe("basic");
  });

  it("forwards the advanced search depth", async () => {
    const provider = new TavilySearchProvider({
      baseUrl: "https://api.tavily.com",
      apiKey: API_KEY,
    });

    await provider.search({ query: "cats", maxResults: 2, searchDepth: "advanced" });

    const [_url, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body).search_depth).toBe("advanced");
  });

  it("normalizes successful results", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            { title: "T1", url: "https://a.example", content: "C1", score: 0.9 },
            { title: "T2", url: "https://b.example", content: "C2" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const provider = new TavilySearchProvider({
      baseUrl: "https://api.tavily.com",
      apiKey: API_KEY,
    });

    const results = await provider.search({ query: "cats", maxResults: 5, searchDepth: "basic" });

    expect(results).toEqual([
      { title: "T1", url: "https://a.example", content: "C1", score: 0.9 },
      { title: "T2", url: "https://b.example", content: "C2", score: undefined },
    ]);
  });

  it("rejects maxResults above the limit", async () => {
    const provider = new TavilySearchProvider({
      baseUrl: "https://api.tavily.com",
      apiKey: API_KEY,
    });

    // Validation failures surface as a ZodError, which the error handler maps
    // to VALIDATION_ERROR (400).
    await expect(
      provider.search({ query: "cats", maxResults: 11, searchDepth: "basic" }),
    ).rejects.toThrow();
  });

  it("rejects maxResults below the limit", async () => {
    const provider = new TavilySearchProvider({
      baseUrl: "https://api.tavily.com",
      apiKey: API_KEY,
    });

    await expect(
      provider.search({ query: "cats", maxResults: 0, searchDepth: "basic" }),
    ).rejects.toThrow();
  });

  it("rejects an empty query", async () => {
    const provider = new TavilySearchProvider({
      baseUrl: "https://api.tavily.com",
      apiKey: API_KEY,
    });

    await expect(
      provider.search({ query: "   ", maxResults: 1, searchDepth: "basic" }),
    ).rejects.toThrow();
  });

  it("rejects an oversized query", async () => {
    const provider = new TavilySearchProvider({
      baseUrl: "https://api.tavily.com",
      apiKey: API_KEY,
    });

    await expect(
      provider.search({
        query: "x".repeat(WEB_SEARCH_MAX_QUERY + 1),
        maxResults: 1,
        searchDepth: "basic",
      }),
    ).rejects.toThrow();
  });

  it("cancels when the signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const provider = new TavilySearchProvider({
      baseUrl: "https://api.tavily.com",
      apiKey: API_KEY,
    });

    await expect(
      provider.search({ query: "cats", maxResults: 1, searchDepth: "basic" }, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ errorType: "user_abort" });
  });

  it("times out and reports a timeout error", async () => {
    // Rejects after a real delay (via setTimeout) so the event loop stays
    // alive and the timeout signal can fire, mirroring real fetch, which
    // keeps a live handle open. A bare never-resolving promise would starve
    // the timeout timer in this environment.
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((_resolve, reject) => {
          setTimeout(() => reject(new Error("late response")), 50);
        }),
    );

    const provider = new TavilySearchProvider({
      baseUrl: "https://api.tavily.com",
      apiKey: API_KEY,
      timeoutMs: 10,
    });

    await expect(
      provider.search({ query: "cats", maxResults: 1, searchDepth: "basic" }),
    ).rejects.toMatchObject({ errorType: "timeout" });
  });

  it("maps HTTP 401 to an unauthorized error", async () => {
    fetchMock.mockResolvedValue(new Response("unauthorized", { status: 401 }));

    const provider = new TavilySearchProvider({
      baseUrl: "https://api.tavily.com",
      apiKey: API_KEY,
    });

    await expect(
      provider.search({ query: "cats", maxResults: 1, searchDepth: "basic" }),
    ).rejects.toMatchObject({ errorType: "http_error", statusCode: 401 });
  });

  it("maps HTTP 403 to an unauthorized error", async () => {
    fetchMock.mockResolvedValue(new Response("forbidden", { status: 403 }));

    const provider = new TavilySearchProvider({
      baseUrl: "https://api.tavily.com",
      apiKey: API_KEY,
    });

    await expect(
      provider.search({ query: "cats", maxResults: 1, searchDepth: "basic" }),
    ).rejects.toMatchObject({ errorType: "http_error", statusCode: 403 });
  });

  it("maps HTTP 429 to a rate limit error", async () => {
    fetchMock.mockResolvedValue(new Response("rate limited", { status: 429 }));

    const provider = new TavilySearchProvider({
      baseUrl: "https://api.tavily.com",
      apiKey: API_KEY,
    });

    await expect(
      provider.search({ query: "cats", maxResults: 1, searchDepth: "basic" }),
    ).rejects.toMatchObject({ errorType: "http_error", statusCode: 429 });
  });

  it("maps HTTP 500 to an invalid provider response error", async () => {
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));

    const provider = new TavilySearchProvider({
      baseUrl: "https://api.tavily.com",
      apiKey: API_KEY,
    });

    await expect(
      provider.search({ query: "cats", maxResults: 1, searchDepth: "basic" }),
    ).rejects.toMatchObject({ errorType: "http_error", statusCode: 500 });
  });

  it("maps malformed JSON to a malformed response error", async () => {
    fetchMock.mockResolvedValue(new Response("not json", { status: 200 }));

    const provider = new TavilySearchProvider({
      baseUrl: "https://api.tavily.com",
      apiKey: API_KEY,
    });

    await expect(
      provider.search({ query: "cats", maxResults: 1, searchDepth: "basic" }),
    ).rejects.toMatchObject({ errorType: "malformed_response" });
  });

  it("maps a missing results array to a malformed response error", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    const provider = new TavilySearchProvider({
      baseUrl: "https://api.tavily.com",
      apiKey: API_KEY,
    });

    await expect(
      provider.search({ query: "cats", maxResults: 1, searchDepth: "basic" }),
    ).rejects.toMatchObject({ errorType: "malformed_response" });
  });

  it("rejects result entries without a URL", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ results: [{ title: "no url", content: "c" }] }),
        { status: 200 },
      ),
    );

    const provider = new TavilySearchProvider({
      baseUrl: "https://api.tavily.com",
      apiKey: API_KEY,
    });

    await expect(
      provider.search({ query: "cats", maxResults: 1, searchDepth: "basic" }),
    ).rejects.toMatchObject({ errorType: "malformed_response" });
  });

  it("never exposes the API key in the thrown error", async () => {
    fetchMock.mockResolvedValue(new Response("forbidden", { status: 403 }));

    const provider = new TavilySearchProvider({
      baseUrl: "https://api.tavily.com",
      apiKey: API_KEY,
    });

    await expect(
      provider.search({ query: "cats", maxResults: 1, searchDepth: "basic" }),
    ).rejects.not.toMatchObject({ message: expect.stringContaining(API_KEY) });
  });

  it("uses the default timeout when none is supplied", () => {
    expect(TAVILY_DEFAULT_TIMEOUT_MS).toBe(10_000);
  });
});
