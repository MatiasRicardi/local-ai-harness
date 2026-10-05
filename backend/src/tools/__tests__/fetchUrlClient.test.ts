import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchUrl,
  FetchUrlClientError,
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
} from "../fetchUrlClient.js";
import {
  validateFetchUrlTarget,
  FetchUrlPolicyError,
} from "../fetchUrlPolicy.js";

// The client delegates destination validation to the Step 47 policy. Tests mock
// it so no real DNS resolution happens and we can drive both allowed and
// blocked destinations deterministically.
vi.mock("../fetchUrlPolicy.js", () => ({
  validateFetchUrlTarget: vi.fn(),
  FetchUrlPolicyError: class FetchUrlPolicyError extends Error {
    constructor(message = "blocked") {
      super(message);
      this.name = "FetchUrlPolicyError";
    }
  },
}));

const mockedValidate = vi.mocked(validateFetchUrlTarget);

/** Encode a string into a Uint8Array of its UTF-8 bytes. */
function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Build a finished `Response` from an optional body and headers. */
function jsonResponse(
  body?: string | ReadableStream<Uint8Array>,
  headers: Record<string, string> = {},
  status = 200,
): Response {
  return new Response(body, { status, headers });
}

/**
 * Install a fetch mock backed by a single response, a list of fixed responses
 * (one per call), or a callback. Honors the abort signal so timeout/
 * cancellation behave like real fetch.
 */
function stubFetch(
  behavior:
    | Response
    | Array<Response | Promise<Response>>
    | ((url: string, init?: { signal?: AbortSignal }) => Response | Promise<Response>),
): ReturnType<typeof vi.fn> {
  const calls: Array<{ url: string; init?: { signal?: AbortSignal } }> = [];
  const fetchMock = vi.fn(
    (url: string, init?: { signal?: AbortSignal }): Promise<Response> => {
      calls.push({ url, init });
      const signal = init?.signal;
      if (signal?.aborted) {
        return Promise.reject(new DOMException("Aborted", "AbortError"));
      }
      const result =
        typeof behavior === "function"
          ? behavior(url, init)
          : Array.isArray(behavior)
            ? behavior[Math.min(calls.length - 1, behavior.length - 1)]
            : behavior;
      if (signal) {
        return new Promise<Response>((resolve, reject) => {
          const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
          signal.addEventListener("abort", onAbort, { once: true });
          Promise.resolve(result).then(
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
      }
      return Promise.resolve(result);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Resolve the initial target; every subsequent validation rejects (blocked). */
function allowThenBlock(): void {
  let first = true;
  mockedValidate.mockImplementation(async (url: string) => {
    if (first) {
      first = false;
      return { url, hostname: new URL(url).hostname, addresses: ["93.184.216.34"] };
    }
    throw new FetchUrlPolicyError("blocked", "NON_PUBLIC_ADDRESS");
  });
}

beforeEach(() => {
  mockedValidate.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchUrl — success and MIME", () => {
  it("downloads a textual 200 and returns the decoded body", async () => {
    mockedValidate.mockResolvedValue({
      url: "https://example.com/page",
      hostname: "example.com",
      addresses: ["93.184.216.34"],
    });
    stubFetch(jsonResponse("hello world", { "content-type": "text/plain" }));

    const res = await fetchUrl("https://example.com/page");

    expect(res).toEqual({
      url: "https://example.com/page",
      status: 200,
      contentType: "text/plain",
      content: "hello world",
    });
  });

  it("accepts application/json and +json variants", async () => {
    mockedValidate.mockResolvedValue({
      url: "https://example.com/data",
      hostname: "example.com",
      addresses: ["93.184.216.34"],
    });
    stubFetch(jsonResponse('{"a":1}', { "content-type": "application/json" }));

    const res = await fetchUrl("https://example.com/data");

    expect(res.contentType).toBe("application/json");
    expect(JSON.parse(res.content)).toEqual({ a: 1 });
  });

  it("accepts a charset parameter and strips it from the media type", async () => {
    mockedValidate.mockResolvedValue({
      url: "https://example.com/page",
      hostname: "example.com",
      addresses: ["93.184.216.34"],
    });
    stubFetch(jsonResponse("x", { "content-type": "text/html; charset=utf-8" }));

    const res = await fetchUrl("https://example.com/page");

    expect(res.contentType).toBe("text/html");
  });

  it("rejects a missing Content-Type (fail closed)", async () => {
    mockedValidate.mockResolvedValue({
      url: "https://example.com/blank",
      hostname: "example.com",
      addresses: ["93.184.216.34"],
    });
    // A null body yields no auto-added Content-Type, so this simulates a
    // server that omits the header entirely.
    stubFetch(jsonResponse(undefined, {}, 200));

    await expect(fetchUrl("https://example.com/blank")).rejects.toMatchObject({
      errorType: FetchUrlClientError.ErrorType.UNSUPPORTED_CONTENT_TYPE,
    });
  });

  it("rejects binary MIME types", async () => {
    for (const type of [
      "application/octet-stream",
      "application/pdf",
      "image/png",
      "audio/mpeg",
      "video/mp4",
    ]) {
      mockedValidate.mockResolvedValue({
        url: "https://example.com/bin",
        hostname: "example.com",
        addresses: ["93.184.216.34"],
      });
      stubFetch(jsonResponse("x", { "content-type": type }));

      await expect(fetchUrl("https://example.com/bin")).rejects.toMatchObject({
        errorType: FetchUrlClientError.ErrorType.UNSUPPORTED_CONTENT_TYPE,
      });
    }
  });
});

describe("fetchUrl — destination policy", () => {
  it("never fetches when the initial destination is blocked", async () => {
    const fetchMock = stubFetch(() => jsonResponse("unreachable"));
    mockedValidate.mockRejectedValue(new FetchUrlPolicyError("blocked", "NON_PUBLIC_ADDRESS"));

    await expect(fetchUrl("http://127.0.0.1/")).rejects.toBeInstanceOf(FetchUrlPolicyError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fetchUrl — redirects", () => {
  it("follows a relative redirect and returns the final URL", async () => {
    mockedValidate.mockResolvedValue({
      url: "https://example.com/final",
      hostname: "example.com",
      addresses: ["93.184.216.34"],
    });
    stubFetch([
      jsonResponse(undefined, { location: "/next" }, 302),
      jsonResponse("done", { "content-type": "text/plain" }, 200),
    ]);

    const res = await fetchUrl("https://example.com/start");

    expect(res.status).toBe(200);
    expect(res.content).toBe("done");
    expect(res.url).toBe("https://example.com/final");
  });

  it("follows up to MAX_REDIRECTS redirects", async () => {
    const hops = Array.from({ length: MAX_REDIRECTS }, () =>
      jsonResponse(undefined, { location: "/h" }, 302),
    );
    hops.push(jsonResponse("final", { "content-type": "text/plain" }, 200));
    mockedValidate.mockResolvedValue({
      url: "https://example.com/final",
      hostname: "example.com",
      addresses: ["93.184.216.34"],
    });
    stubFetch(hops);

    const res = await fetchUrl("https://example.com/start");

    expect(res.content).toBe("final");
  });

  it("rejects a sixth redirect with TOO_MANY_REDIRECTS and makes no sixth request", async () => {
    const fetchMock = stubFetch(
      Array.from({ length: MAX_REDIRECTS + 1 }, () =>
        jsonResponse(undefined, { location: "/h" }, 302),
      ),
    );
    mockedValidate.mockResolvedValue({
      url: "https://example.com/h",
      hostname: "example.com",
      addresses: ["93.184.216.34"],
    });

    await expect(fetchUrl("https://example.com/start")).rejects.toMatchObject({
      errorType: FetchUrlClientError.ErrorType.TOO_MANY_REDIRECTS,
    });

    // Initial request + MAX_REDIRECTS redirects, no sixth connection.
    expect(fetchMock).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
  });

  it("rejects a redirect without a Location with INVALID_REDIRECT", async () => {
    mockedValidate.mockResolvedValue({
      url: "https://example.com/no-loc",
      hostname: "example.com",
      addresses: ["93.184.216.34"],
    });
    stubFetch(jsonResponse(undefined, {}, 302));

    await expect(fetchUrl("https://example.com/no-loc")).rejects.toMatchObject({
      errorType: FetchUrlClientError.ErrorType.INVALID_REDIRECT,
    });
  });

  it("rejects a public URL that redirects to a private one before the second fetch", async () => {
    const fetchMock = stubFetch([
      jsonResponse(undefined, { location: "http://127.0.0.1/secret" }, 302),
      jsonResponse("should not happen"),
    ]);
    // Initial public URL passes; the redirect target is blocked by policy.
    allowThenBlock();

    await expect(fetchUrl("https://example.com/start")).rejects.toBeInstanceOf(
      FetchUrlPolicyError,
    );
    // Only the first request happens: the second is never issued.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("revalidates the destination before every redirect hop", async () => {
    mockedValidate.mockResolvedValue({
      url: "https://example.com/next",
      hostname: "example.com",
      addresses: ["93.184.216.34"],
    });
    const fetchMock = stubFetch([
      jsonResponse(undefined, { location: "https://example.com/next" }, 302),
      jsonResponse("ok", { "content-type": "text/plain" }, 200),
    ]);

    await fetchUrl("https://example.com/start");

    // Initial target + the redirect target, validated before each request.
    expect(mockedValidate).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("fetchUrl — HTTP status", () => {
  it("maps a non-2xx final response to HTTP_ERROR with the status code", async () => {
    mockedValidate.mockResolvedValue({
      url: "https://example.com/missing",
      hostname: "example.com",
      addresses: ["93.184.216.34"],
    });
    stubFetch(jsonResponse("not found body", { "content-type": "text/plain" }, 404));

    await expect(fetchUrl("https://example.com/missing")).rejects.toMatchObject({
      errorType: FetchUrlClientError.ErrorType.HTTP_ERROR,
      statusCode: 404,
    });
  });
});

describe("fetchUrl — response size limit", () => {
  it("rejects before reading the body when Content-Length exceeds the limit", async () => {
    mockedValidate.mockResolvedValue({
      url: "https://example.com/huge",
      hostname: "example.com",
      addresses: ["93.184.216.34"],
    });
    const fetchMock = stubFetch(
      jsonResponse("tiny", { "content-length": String(MAX_RESPONSE_BYTES + 1) }, 200),
    );

    await expect(fetchUrl("https://example.com/huge")).rejects.toMatchObject({
      errorType: FetchUrlClientError.ErrorType.RESPONSE_TOO_LARGE,
    });
    // The header check rejects before any body is consumed.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts and rejects when a streamed body crosses the limit", async () => {
    mockedValidate.mockResolvedValue({
      url: "https://example.com/stream",
      hostname: "example.com",
      addresses: ["93.184.216.34"],
    });
    const chunkSize = Math.floor(MAX_RESPONSE_BYTES / 11) + 1;
    const chunks = Array.from({ length: 11 }, () => bytesOf("a".repeat(chunkSize)));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });
    stubFetch(jsonResponse(stream, { "content-type": "text/plain" }, 200));

    await expect(fetchUrl("https://example.com/stream")).rejects.toMatchObject({
      errorType: FetchUrlClientError.ErrorType.RESPONSE_TOO_LARGE,
    });
  });

  it("accepts a body of exactly the limit", async () => {
    mockedValidate.mockResolvedValue({
      url: "https://example.com/exact",
      hostname: "example.com",
      addresses: ["93.184.216.34"],
    });
    const exactly = "a".repeat(MAX_RESPONSE_BYTES);
    stubFetch(jsonResponse(exactly, { "content-type": "text/plain" }, 200));

    const res = await fetchUrl("https://example.com/exact");

    expect(res.content).toBe(exactly);
    expect(res.content.length).toBe(MAX_RESPONSE_BYTES);
  });
});

describe("fetchUrl — timeout and cancellation", () => {
  it("classifies the global operation timeout as TIMEOUT", async () => {
    mockedValidate.mockResolvedValue({
      url: "https://example.com/slow",
      hostname: "example.com",
      addresses: ["93.184.216.34"],
    });
    // The request hangs; a short real timeout stands in for the 15s ceiling.
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => realTimeout(Math.min(ms, 5)));
    stubFetch(() => new Promise<Response>(() => undefined));

    await expect(fetchUrl("https://example.com/slow")).rejects.toMatchObject({
      errorType: FetchUrlClientError.ErrorType.TIMEOUT,
    });
  });

  it("classifies a caller abort as USER_ABORT", async () => {
    mockedValidate.mockResolvedValue({
      url: "https://example.com/hang",
      hostname: "example.com",
      addresses: ["93.184.216.34"],
    });
    const fetchMock = stubFetch(() => new Promise<Response>(() => undefined));
    const controller = new AbortController();
    const abortPromise = fetchUrl("https://example.com/hang", { signal: controller.signal });
    controller.abort();

    await expect(abortPromise).rejects.toMatchObject({
      errorType: FetchUrlClientError.ErrorType.USER_ABORT,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("fetchUrl — headers", () => {
  it("sends fixed harness headers without credentials", async () => {
    mockedValidate.mockResolvedValue({
      url: "https://example.com/headers",
      hostname: "example.com",
      addresses: ["93.184.216.34"],
    });
    const seen: Array<Record<string, string> | undefined> = [];
    stubFetch((_url, init) => {
      seen.push((init as { headers?: Record<string, string> }).headers);
      return jsonResponse("ok", { "content-type": "text/plain" }, 200);
    });

    await fetchUrl("https://example.com/headers");

    const headers = seen[0] as Record<string, string>;
    expect(headers).toBeDefined();
    expect(headers["User-Agent"]).toMatch(/^Local-AI-Harness\//);
    expect(headers["Accept"]).toContain("text/html");
    expect(headers["authorization"]).toBeUndefined();
    expect(headers["cookie"]).toBeUndefined();
  });
});
