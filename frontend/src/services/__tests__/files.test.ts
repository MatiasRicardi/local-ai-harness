import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { isSupportedExtension, uploadDocument } from "../files"
import { FrontendApiError } from "../../types/error"

// Mirrors the service default without hard-coding the CI-provided base URL.
const API_BASE = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:3000"

function apiErrorResponse(status: number, errorBody: unknown): Response {
  return {
    ok: false,
    status,
    statusText: "Error",
    json: async () => errorBody,
  } as unknown as Response
}

const successDocument = {
  fileId: "file-123",
  originalFilename: "notes.txt",
  size: 42,
  type: "text/plain",
  extraction: {
    text: "hello world",
    characterCount: 11,
    warnings: [],
    pageCount: undefined,
  },
}

describe("uploadDocument", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("posts the file as multipart/form-data without a manual Content-Type", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, ...successDocument }),
    } as unknown as Response)

    const file = new File(["hello world"], "notes.txt", { type: "text/plain" })
    const doc = await uploadDocument(file)

    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(url).toBe(`${API_BASE}/api/files`)
    expect(init?.method).toBe("POST")
    // The browser sets multipart/* Content-Type automatically; we must not.
    expect(init?.headers).toBeUndefined()
    expect(init?.body).toBeInstanceOf(FormData)
    expect(doc).toEqual({
      fileId: "file-123",
      originalFilename: "notes.txt",
      size: 42,
      type: "text/plain",
      text: "hello world",
      characterCount: 11,
      warnings: [],
      pageCount: undefined,
    })
  })

  it("throws a FrontendApiError carrying the backend error code", async () => {
    vi.mocked(fetch).mockResolvedValue(
      apiErrorResponse(413, {
        error: { code: "FILE_TOO_LARGE", message: "File exceeds the size limit." },
      }),
    )

    const file = new File(["too big"], "big.txt", { type: "text/plain" })

    let error: FrontendApiError | undefined
    try {
      await uploadDocument(file)
    } catch (thrown) {
      error = thrown as FrontendApiError
    }

    expect(error).toBeInstanceOf(FrontendApiError)
    expect(error?.code).toBe("FILE_TOO_LARGE")
    expect(error?.message).toBe("File exceeds the size limit.")
  })

  it("rejects when the network request itself fails", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("network down"))

    const file = new File(["hello"], "notes.txt", { type: "text/plain" })
    await expect(uploadDocument(file)).rejects.toThrow("network down")
  })
})

describe("isSupportedExtension", () => {
  // Exercises the real implementation (not a copied regex) so the UI rejection
  // rules cannot drift from the service rules.
  it.each([
    ["notes.txt", true],
    ["NOTES.TXT", true],
    ["guide.md", true],
    ["report.pdf", true],
    ["report.PDF", true],
    ["readme.markdown", false],
    ["image.png", false],
    ["tool.exe", false],
    ["notes.txt.exe", false],
    ["no-extension", false],
    ["", false],
  ])("supports %s (expected: %s)", (filename, expected) => {
    expect(isSupportedExtension(filename)).toBe(expected)
  })
})
