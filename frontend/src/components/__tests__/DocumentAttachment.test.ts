import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mount, type VueWrapper } from "@vue/test-utils"
import DocumentAttachment from "../DocumentAttachment.vue"
import { uploadDocument } from "../../services/files"
import { FrontendApiError } from "../../types/error"
import type { AttachedDocument } from "../../services/files"
import { flushPromises, selectFile, stubFileInputValueSetter } from "../../__tests__/test-utils"

function replaceButton(wrapper: VueWrapper): HTMLButtonElement {
  return wrapper
    .find("button[aria-label='Replace document']")
    .element as HTMLButtonElement
}

function removeButton(wrapper: VueWrapper): HTMLButtonElement {
  return wrapper.find(".document-attachment-remove").element as HTMLButtonElement
}

// Only the network call is stubbed; the real extension rules are reused so the
// mocks cannot drift from `isSupportedExtension`.
vi.mock("../../services/files", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/files")>()
  return { ...actual, uploadDocument: vi.fn() }
})

const attached: AttachedDocument = {
  fileId: "file-1",
  originalFilename: "notes.txt",
  size: 20,
  type: "text/plain",
  text: "hello world",
  characterCount: 11,
  warnings: [],
  pageCount: undefined,
}

function supportedFile(name = "notes.txt"): File {
  return new File(["hello world"], name, { type: "text/plain" })
}

describe("DocumentAttachment", () => {
  let wrapper: VueWrapper
  // Captured so tests can assert `resetInput()` actually assigns "", rather than
  // relying on the file input's `.value` — which stays "" anyway because
  // `selectFile` never assigns `.value`, making that check vacuous.
  let valueSetter: ReturnType<typeof stubFileInputValueSetter>

  beforeEach(() => {
    vi.mocked(uploadDocument).mockReset()
    valueSetter = stubFileInputValueSetter()
  })

  afterEach(() => {
    wrapper?.unmount()
    vi.restoreAllMocks()
  })

  it("shows only the attach button when there is no attachment", () => {
    wrapper = mount(DocumentAttachment, {
      props: {
        attachedDocument: null,
        uploading: false,
        onAttach: vi.fn(),
        onRemove: vi.fn(),
        onError: vi.fn(),
      },
    })

    expect(wrapper.text()).toContain("Attach document")
    expect(wrapper.find(".document-attachment-remove").exists()).toBe(false)
    expect(wrapper.find(".document-attachment-meta").exists()).toBe(false)
  })

  it("shows the attached document metadata and a remove button", () => {
    wrapper = mount(DocumentAttachment, {
      props: {
        attachedDocument: attached,
        uploading: false,
        onAttach: vi.fn(),
        onRemove: vi.fn(),
        onError: vi.fn(),
      },
    })

    expect(wrapper.find(".document-attachment-filename").text()).toBe(
      "notes.txt",
    )
    expect(wrapper.text()).toContain("11 characters")
    expect(wrapper.find(".document-attachment-remove").exists()).toBe(true)
    expect(
      wrapper.find("button[aria-label='Replace document']").text(),
    ).toBe("Replace")
  })

  it("shows the uploading state and disables the actions", () => {
    wrapper = mount(DocumentAttachment, {
      props: {
        attachedDocument: attached,
        uploading: true,
        onAttach: vi.fn(),
        onRemove: vi.fn(),
        onError: vi.fn(),
      },
    })

    expect(wrapper.text()).toContain("Uploading document...")
    expect(
      replaceButton(wrapper).disabled,
    ).toBe(true)
    expect(
      removeButton(wrapper).disabled,
    ).toBe(true)
  })

  it("renders extraction warnings", () => {
    const withWarning: AttachedDocument = {
      ...attached,
      warnings: ["Some content skipped"],
    }
    wrapper = mount(DocumentAttachment, {
      props: {
        attachedDocument: withWarning,
        uploading: false,
        onAttach: vi.fn(),
        onRemove: vi.fn(),
        onError: vi.fn(),
      },
    })

    expect(wrapper.find(".document-attachment-warning").text()).toContain(
      "Warning: Some content skipped",
    )
  })

  it("emits remove and resets the input", async () => {
    const onRemove = vi.fn()
    wrapper = mount(DocumentAttachment, {
      props: {
        attachedDocument: attached,
        uploading: false,
        onAttach: vi.fn(),
        onRemove,
        onError: vi.fn(),
      },
    })

    await wrapper.find(".document-attachment-remove").trigger("click")
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(valueSetter).toHaveBeenCalledWith("")
  })

  it("rejects an unsupported file with UNSUPPORTED_FILE", async () => {
    const onError = vi.fn()
    wrapper = mount(DocumentAttachment, {
      props: {
        attachedDocument: null,
        uploading: false,
        onAttach: vi.fn(),
        onRemove: vi.fn(),
        onError,
      },
    })

    selectFile(wrapper, new File(["x"], "notes.exe", { type: "application/octet-stream" }))
    await Promise.resolve()

    expect(wrapper.emitted("attempt")).toHaveLength(1)
    expect(onError).toHaveBeenCalledTimes(1)
    const error = onError.mock.calls[0][0] as FrontendApiError
    expect(error.code).toBe("UNSUPPORTED_FILE")
    expect(valueSetter).toHaveBeenCalledWith("")
  })

  it("attaches the document when a supported file is selected", async () => {
    const onAttach = vi.fn()
    vi.mocked(uploadDocument).mockResolvedValue(attached)
    wrapper = mount(DocumentAttachment, {
      props: {
        attachedDocument: null,
        uploading: false,
        onAttach,
        onRemove: vi.fn(),
        onError: vi.fn(),
      },
    })

    selectFile(wrapper, supportedFile())
    await Promise.resolve()

    expect(uploadDocument).toHaveBeenCalledWith(expect.any(File))
    expect(onAttach).toHaveBeenCalledWith(attached)
  })

  it("reports a FILE_UPLOAD_ERROR when the upload rejects", async () => {
    const onError = vi.fn()
    vi.mocked(uploadDocument).mockRejectedValue(
      new FrontendApiError({
        code: "FILE_UPLOAD_ERROR",
        message: "The file could not be uploaded.",
      }),
    )
    wrapper = mount(DocumentAttachment, {
      props: {
        attachedDocument: null,
        uploading: false,
        onAttach: vi.fn(),
        onRemove: vi.fn(),
        onError,
      },
    })

    selectFile(wrapper, supportedFile())
    await Promise.resolve()

    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0][0] as FrontendApiError).code).toBe(
      "FILE_UPLOAD_ERROR",
    )
  })

  it("ignores a stale upload result when the conversation is reset mid-upload", async () => {
    const onAttach = vi.fn()
    const onError = vi.fn()
    let resolveUpload!: (doc: AttachedDocument) => void

    vi.mocked(uploadDocument).mockImplementation(
      () =>
        new Promise<AttachedDocument>((resolve) => {
          resolveUpload = resolve
        }),
    )

    wrapper = mount(DocumentAttachment, {
      props: {
        attachedDocument: null,
        uploading: false,
        onAttach,
        onRemove: vi.fn(),
        onError,
        resetVersion: 0,
      },
    })

    selectFile(wrapper, supportedFile())
    await flushPromises()

    expect(uploadDocument).toHaveBeenCalledTimes(1)
    expect(onAttach).not.toHaveBeenCalled()
    expect(wrapper.emitted("upload:start")).toHaveLength(1)

    // The user starts a new conversation while the upload is still in flight.
    await wrapper.setProps({ resetVersion: 1 })

    // The abandoned request now resolves: it must not re-attach the old document,
    // report an error for it, or end a busy state belonging to the new session.
    resolveUpload(attached)
    await flushPromises()

    expect(onAttach).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    expect(wrapper.emitted("upload:end")).toBeUndefined()
  })
})
