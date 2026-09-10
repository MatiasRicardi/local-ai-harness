import { describe, it, expect } from "vitest"
import {
  parseApiError,
  parseStreamErrorData,
  toNetworkError,
  toUnknownError,
} from "../parseApiError"
import { FrontendApiError } from "../../types/error"

function fakeApiErrorResponse(
  status: number,
  errorBody: unknown,
): Response {
  return {
    ok: false,
    status,
    statusText: "Bad Request",
    json: async () => errorBody,
  } as unknown as Response
}

describe("parseApiError", () => {
  it("maps a well-formed api error response to its code, message and detail", async () => {
    const response = fakeApiErrorResponse(422, {
      error: {
        code: "CONTEXT_TOO_LARGE",
        message: "Prompt tokens exceed the limit.",
        detail: "Max 2000 tokens.",
      },
    })

    const error = await parseApiError(response)

    expect(error).toBeInstanceOf(FrontendApiError)
    expect(error.code).toBe("CONTEXT_TOO_LARGE")
    expect(error.message).toBe("Prompt tokens exceed the limit.")
    expect(error.detail).toBe("Max 2000 tokens.")
  })

  it("falls back to UNKNOWN_ERROR when the body is not valid JSON", async () => {
    const response = fakeApiErrorResponse(500, {
      error: { code: "INTERNAL_ERROR", message: "boom" },
    })
    // Force JSON parsing to throw (malformed body, e.g. an HTML gateway page).
    response.json = async () => {
      throw new SyntaxError("Unexpected token < in JSON")
    }

    const error = await parseApiError(response)

    expect(error.code).toBe("UNKNOWN_ERROR")
    expect(error.message).toBe("Something went wrong. Please try again.")
    expect(error.detail).toBeUndefined()
  })

  it("falls back to UNKNOWN_ERROR when no code is present", async () => {
    const response = fakeApiErrorResponse(500, {
      error: { message: "Something went wrong" },
    })

    const error = await parseApiError(response)

    expect(error.code).toBe("UNKNOWN_ERROR")
    expect(error.message).toBe("Something went wrong. Please try again.")
  })

  it("maps an unknown error code to UNKNOWN_ERROR without echoing server text", async () => {
    const response = fakeApiErrorResponse(418, {
      error: { code: "TEAPOT", message: "I am a teapot" },
    })

    const error = await parseApiError(response)

    expect(error.code).toBe("UNKNOWN_ERROR")
    expect(error.message).toBe("Something went wrong. Please try again.")
  })
})

describe("parseStreamErrorData", () => {
  it("builds an api error from a stream error payload with a known code", () => {
    const error = parseStreamErrorData({
      code: "PROVIDER_TIMEOUT",
      message: "The model took too long",
      detail: "Retry later",
    })

    expect(error).toBeInstanceOf(FrontendApiError)
    expect(error.code).toBe("PROVIDER_TIMEOUT")
    expect(error.message).toBe("The model took too long")
    expect(error.detail).toBe("Retry later")
  })

  it("maps an unknown stream error code to UNKNOWN_ERROR", () => {
    const error = parseStreamErrorData({ code: "WEIRD", message: "weird" })
    expect(error.code).toBe("UNKNOWN_ERROR")
    expect(error.message).toBe("Something went wrong. Please try again.")
  })
})

describe("toNetworkError / toUnknownError", () => {
  it("toNetworkError always yields NETWORK_ERROR with the safe message", () => {
    const error = toNetworkError()
    expect(error.code).toBe("NETWORK_ERROR")
    expect(error.message).toBe(
      "Unable to reach the local backend. Check that it is running and try again.",
    )
    expect(error).toBeInstanceOf(FrontendApiError)
  })

  it("toUnknownError yields UNKNOWN_ERROR", () => {
    const error = toUnknownError()
    expect(error.code).toBe("UNKNOWN_ERROR")
    expect(error.message).toBe("Something went wrong. Please try again.")
  })
})

describe("FrontendApiError", () => {
  it("exposes the standard Error surface plus structured fields", () => {
    const error = new FrontendApiError({
      code: "CONTEXT_TOO_LARGE",
      message: "too big",
      detail: "detail",
    })

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe("FrontendApiError")
    expect(error.message).toBe("too big")
    expect(error.code).toBe("CONTEXT_TOO_LARGE")
    expect(error.detail).toBe("detail")
  })
})
