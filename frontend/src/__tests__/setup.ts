// Shared setup for the Vitest + jsdom environment.
//
// jsdom does not implement several DOM methods that the app uses, so we stub
// them to keep tests deterministic and free of unhandled rejections.
import { vi } from "vitest"

// jsdom lacks `scrollIntoView`, which the chat view calls after every render.
if (!Element.prototype.scrollIntoView) {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    value: vi.fn(),
    writable: true,
    configurable: true,
  })
}
