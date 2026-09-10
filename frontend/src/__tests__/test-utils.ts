import { vi } from "vitest"
import type { VueWrapper } from "@vue/test-utils"
import type { Ref } from "vue"

/**
 * Shared, small test helpers for the frontend suite.
 *
 * These avoid building an internal testing framework: each helper solves one
 * concrete jsdom/Vue Test Utils quirk that the MVP components hit.
 */

/**
 * Resolve once the microtask queue has drained. A macrotask boundary
 * (`setTimeout(0)`) guarantees every queued microtask — including the awaited
 * mocked `uploadDocument` chain — has run before the assertions read state.
 */
export function flushPromises(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

/**
 * jsdom refuses to set a file input's `.value` to a non-empty string, and it
 * throws when a previously file-bearing input is reset to `""` (which
 * `DocumentAttachment.resetInput` does on success/remove). Stubbing the value
 * setter makes file selection and reset deterministic without touching
 * production code.
 */
export function stubFileInputValueSetter(): ReturnType<
  typeof vi.spyOn
> {
  return vi.spyOn(HTMLInputElement.prototype, "value", "set").mockImplementation(() => {})
}

/**
 * Select a file in a file input for jsdom.
 *
 * `@vue/test-utils` `setValue` assigns `element.value = file`, which jsdom
 * rejects for file inputs. Instead we expose the chosen file through `files`
 * and dispatch a native `change` event, which is what the components read.
 */
export function selectFile(
  wrapper: VueWrapper<any>,
  file: File,
): void {
  const input = wrapper.find('input[type="file"]').element as HTMLInputElement
  Object.defineProperty(input, "files", {
    configurable: true,
    get: () => ({ 0: file, length: 1 }) as unknown as FileList,
  })
  input.dispatchEvent(new Event("change", { bubbles: true }))
}

/** Read a reactive ref's current value. */
export function readRef<T>(ref: Ref<T>): T {
  return ref.value
}
