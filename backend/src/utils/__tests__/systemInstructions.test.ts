import { describe, it, expect } from "vitest";
import { composeSystemInstructions } from "../systemInstructions.js";
import { buildRuntimeContextMessage } from "../runtimeContext.js";
import { buildWebSearchGuidanceMessage } from "../webSearchPrompt.js";

const RUNTIME = buildRuntimeContextMessage(
  { timeZone: "America/Montevideo", locale: "es-UY" },
  new Date("2026-10-02T01:30:00.000Z"),
);

const GUIDANCE = buildWebSearchGuidanceMessage().content;

describe("composeSystemInstructions", () => {
  it("returns just the runtime-context message when web search is disabled", () => {
    expect(composeSystemInstructions(RUNTIME.content, false)).toBe(RUNTIME.content);
  });

  it("includes the web-search guidance when web search is enabled", () => {
    const composed = composeSystemInstructions(RUNTIME.content, true);

    // Exactly one newline joins the two server-authored system messages, and
    // both are present verbatim so the budget counts every character sent.
    expect(composed).toBe(`${RUNTIME.content}\n${GUIDANCE}`);
    expect(composed).toContain(RUNTIME.content);
    expect(composed).toContain(GUIDANCE);
  });

  it("never estimates a string different from what is sent", () => {
    // The composed budget string must contain every character of the runtime
    // message that is actually prepended to the request.
    const composed = composeSystemInstructions(RUNTIME.content, true);
    expect(composed).toContain(RUNTIME.content);
  });
});
