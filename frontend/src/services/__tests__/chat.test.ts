import { describe, it, expect, vi } from "vitest"
import type { Mock } from "vitest"
import { streamChat } from "../chat"
import type {
  ChatProviderConfig,
  ContextTruncationMetadata,
  StreamCallbacks,
} from "../chat"
import { FrontendApiError } from "../../types/error"

type MockCallbacks = {
  onStart: Mock
  onDelta: Mock
  onDone: Mock
  onStopped: Mock
  onError: Mock
}

const provider: ChatProviderConfig = {
  baseUrl: "http://localhost:8080/v1",
  model: "m",
  timeoutMs: 30000,
}

function sseStream(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(event))
      }
      controller.close()
    },
  })
}

/**
 * A minimal `Response`-like object. `streamChat` only reads `ok`, `status`,
 * `json()` (for errors) and `body.getReader()` (for the stream).
 */
function okResponse(body: ReadableStream<Uint8Array>): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    body,
    json: async () => ({}),
  } as unknown as Response
}

function apiErrorResponse(status: number, errorBody: unknown): Response {
  return {
    ok: false,
    status,
    statusText: "Error",
    json: async () => errorBody,
  } as unknown as Response
}

function noopCallbacks(): MockCallbacks {
  return {
    onStart: vi.fn(),
    onDelta: vi.fn(),
    onDone: vi.fn(),
    onStopped: vi.fn(),
    onError: vi.fn(),
  }
}

/**
 * Streams `chunks` as separate ReadableStream chunks, i.e. one physical network
 * chunk each, so tests can place a chunk boundary anywhere inside an event.
 */
async function streamChunked(chunks: string[]): Promise<MockCallbacks> {
  const callbacks = noopCallbacks()
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(sseStream(chunks))))
  await streamChat([], provider, callbacks as unknown as StreamCallbacks)
  return callbacks
}

describe("streamChat", () => {
  it("dispatches start, deltas and done from the SSE stream", async () => {
    const callbacks = noopCallbacks()
    const sse = [
      "event: start\ndata: {\"model\":\"local-model\"}\n\n",
      "event: delta\ndata: {\"text\":\"Hel\"}\n\n",
      "event: delta\ndata: {\"text\":\"lo\"}\n\n",
      "event: done\ndata: {}\n\n",
    ].join("")
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(sseStream([sse]))))

    await streamChat([], provider, callbacks as unknown as StreamCallbacks)

    expect(callbacks.onStart).toHaveBeenCalledTimes(1)
    expect(callbacks.onStart).toHaveBeenCalledWith("local-model", undefined)
    expect(callbacks.onDelta).toHaveBeenNthCalledWith(1, "Hel")
    expect(callbacks.onDelta).toHaveBeenNthCalledWith(2, "lo")
    // A `done` event is followed by stream EOF, so the service is idempotent
    // about completion — the consumer only needs to know it happened once.
    expect(callbacks.onDone).toHaveBeenCalled()
    expect(callbacks.onError).not.toHaveBeenCalled()
    expect(callbacks.onStopped).not.toHaveBeenCalled()
  })

  it("buffers an SSE event cut in half across chunk boundaries", async () => {
    const callbacks = noopCallbacks()
    // A two-event stream sliced in the middle of the second event's `event:` line:
    // the first read ends with the incomplete fragment "event: del", which must be
    // held back (and not dispatched or dropped) until the next chunk completes it.
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          okResponse(
            sseStream([
              'event: start\ndata: {"model":"m"}\n\nevent: del',
              'ta\ndata: {"text":"hello"}\n\n',
            ]),
          ),
        ),
    )

    await streamChat([], provider, callbacks as unknown as StreamCallbacks)

    // The event that was already complete in the first chunk is dispatched once.
    expect(callbacks.onStart).toHaveBeenCalledTimes(1)
    expect(callbacks.onStart).toHaveBeenCalledWith("m", undefined)

    // The split event is recovered from the buffered fragment exactly once, with
    // the rejoined bytes — the "event: del" prefix produced no extra event.
    expect(callbacks.onDelta).toHaveBeenCalledTimes(1)
    expect(callbacks.onDelta).toHaveBeenCalledWith("hello")
    expect(callbacks.onError).not.toHaveBeenCalled()
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
  })

  it("dispatches an event whose data line arrives in the next chunk", async () => {
    // Regression: the event type used to be reset on every read(), so an `event:`
    // line completed in one chunk lost its event type and the `data:` line that
    // followed it was dropped silently.
    const callbacks = await streamChunked([
      "event: delta\n",
      'data: {"text":"hello"}\n\n',
    ])

    expect(callbacks.onDelta).toHaveBeenCalledTimes(1)
    expect(callbacks.onDelta).toHaveBeenCalledWith("hello")
    expect(callbacks.onError).not.toHaveBeenCalled()
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
  })

  it("dispatches an event whose JSON payload is split across chunks", async () => {
    const callbacks = await streamChunked([
      'event: delta\ndata: {"te',
      'xt":"hello"}\n\n',
    ])

    expect(callbacks.onDelta).toHaveBeenCalledTimes(1)
    expect(callbacks.onDelta).toHaveBeenCalledWith("hello")
    expect(callbacks.onError).not.toHaveBeenCalled()
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
  })

  it("forwards start.context into the onStart metadata argument", async () => {
    const callbacks = noopCallbacks()
    // Step 19: the backend only adds `context` when the document was truncated.
    const context: ContextTruncationMetadata = {
      documentTruncated: true,
      originalDocumentCharacters: 5000,
      includedDocumentCharacters: 1200,
      estimatedOriginalDocumentTokens: 2500,
      estimatedIncludedDocumentTokens: 600,
    }
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          okResponse(
            sseStream([
              `event: start\ndata: ${JSON.stringify({ model: "llama-3", context })}\n\n`,
            ]),
          ),
        ),
    )

    await streamChat([], provider, callbacks as unknown as StreamCallbacks)

    expect(callbacks.onStart).toHaveBeenCalledTimes(1)
    const [model, startContext] = callbacks.onStart.mock.calls[0] as [
      string,
      ContextTruncationMetadata | undefined,
    ]
    expect(model).toBe("llama-3")
    expect(startContext).toEqual(context)
    expect(callbacks.onError).not.toHaveBeenCalled()
  })

  it("routes a stream error event to onError with a FrontendApiError", async () => {
    const callbacks = noopCallbacks()
    // A known stable backend code is preserved end to end.
    const sse = "event: error\ndata: {\"code\":\"PROVIDER_TIMEOUT\",\"message\":\"slow down\"}\n\n"
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(sseStream([sse]))))

    await streamChat([], provider, callbacks as unknown as StreamCallbacks)

    expect(callbacks.onError).toHaveBeenCalledTimes(1)
    const error = callbacks.onError.mock.calls[0][0] as FrontendApiError
    expect(error).toBeInstanceOf(FrontendApiError)
    expect(error.code).toBe("PROVIDER_TIMEOUT")
    expect(error.message).toBe("slow down")
  })

  it("calls onError (not throw) for an HTTP error response before the stream starts", async () => {
    const callbacks = noopCallbacks()
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      apiErrorResponse(422, {
        error: { code: "CONTEXT_TOO_LARGE", message: "too large" },
      }),
    ))

    await streamChat([], provider, callbacks as unknown as StreamCallbacks)

    expect(callbacks.onError).toHaveBeenCalledTimes(1)
    expect((callbacks.onError.mock.calls[0][0] as FrontendApiError).code).toBe(
      "CONTEXT_TOO_LARGE",
    )
    expect(callbacks.onDone).not.toHaveBeenCalled()
  })

  it("calls onError with UNKNOWN_ERROR for a malformed HTTP error response", async () => {
    const callbacks = noopCallbacks()
    const response = {
      ok: false,
      status: 500,
      statusText: "Server Error",
      json: async () => {
        throw new SyntaxError("bad json")
      },
    }
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response as unknown as Response))

    await streamChat([], provider, callbacks as unknown as StreamCallbacks)

    expect(callbacks.onError).toHaveBeenCalledTimes(1)
    expect((callbacks.onError.mock.calls[0][0] as FrontendApiError).code).toBe(
      "UNKNOWN_ERROR",
    )
  })

  it("calls onStopped when the fetch rejects with an AbortError", async () => {
    const callbacks = noopCallbacks()
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(
      new DOMException("The operation was aborted.", "AbortError"),
    ))

    await streamChat(
      [],
      provider,
      callbacks as unknown as StreamCallbacks,
      { signal: new AbortController().signal },
    )

    expect(callbacks.onStopped).toHaveBeenCalledTimes(1)
    expect(callbacks.onError).not.toHaveBeenCalled()
  })
})
