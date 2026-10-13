import type { ChatDocumentContext } from "../provider/schemas.js";
import { buildDocumentContextMessage } from "./documentContext.js";
import { buildRuntimeContextMessage } from "./runtimeContext.js";
import {
  buildToolGuidanceMessage,
  NO_TOOLS_CAPABILITIES,
  type ToolCapabilities,
} from "./toolGuidance.js";

/**
 * A server-authored `system` message.
 *
 * These messages are privileged: they must never contain user-authored
 * content (conversation history, document text, tool results).
 */
export interface SystemMessage {
  readonly role: "system";
  readonly content: string;
}

/**
 * Inputs for the single deterministic point that assembles every
 * server-authored `system` message used by a request.
 *
 * `runtimeContextMessage` is always included; `capabilities` (derived from the
 * actually registered tools) decide the optional tool guidance; `document`
 * (when present) adds the document policy message.
 */
export interface BuildServerSystemMessagesInput {
  readonly runtimeContextMessage: SystemMessage;
  readonly capabilities: ToolCapabilities;
  readonly document?: ChatDocumentContext;
}

/**
 * Assemble the ordered list of server-authored `system` messages for a
 * request. The order is deterministic and preserves the trust hierarchy:
 *
 * 1. runtime context (always),
 * 2. tool guidance (only when at least one tool is registered),
 * 3. document policy (only when a document is attached).
 *
 * User-authored content (conversation messages, the document text) is never
 * placed in this list; it is sent separately at user priority.
 */
export function buildServerSystemMessages(
  input: BuildServerSystemMessagesInput,
): SystemMessage[] {
  const messages: SystemMessage[] = [input.runtimeContextMessage];

  const guidance = buildToolGuidanceMessage(input.capabilities);
  if (guidance) {
    messages.push(guidance);
  }

  if (input.document) {
    messages.push(buildDocumentContextMessage(input.document));
  }

  return messages;
}

/**
 * Compose the exact `systemInstructions` string fed to the context budget.
 *
 * The budget must count exactly what is sent to the provider, never an
 * estimate of a different string. Because this joins the very same
 * {@link SystemMessage} instances used to build the provider request, the
 * budgeted string always covers every server-authored system message — the
 * list used to build provider messages and the list used to build the budget
 * string are the same source.
 *
 * The document policy message is included here; the document *content*
 * (user-priority) is not, and its fixed wrapper is accounted by
 * `estimateDocumentTemplateOverhead` in `context-budget.ts`, so the policy is
 * counted exactly once and never double-counted.
 */
export function composeSystemInstructions(messages: SystemMessage[]): string {
  return messages.map((message) => message.content).join("\n");
}

/**
 * Convenience wrapper: build the server-authored system messages and compose
 * them into the budget string in one call.
 */
export function composeServerSystemInstructions(
  input: BuildServerSystemMessagesInput,
): string {
  return composeSystemInstructions(buildServerSystemMessages(input));
}

/**
 * Build the runtime-context system message from the backend clock.
 *
 * Re-exported so callers can build the whole server-authored system set from
 * a single module without importing `runtimeContext.js` directly.
 */
export { buildRuntimeContextMessage };

/**
 * Re-exported so callers can import the "no capabilities" default from the same
 * central module.
 */
export { NO_TOOLS_CAPABILITIES };
