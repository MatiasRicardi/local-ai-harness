import { buildWebSearchGuidanceMessage } from "./webSearchPrompt.js";

/**
 * Compose the exact `systemInstructions` string fed to the context budget.
 *
 * Budgeting must count exactly what is sent to the provider, never an estimate
 * of a different string. The runtime-context message is always included (built
 * once, from the backend clock); the web-search guidance is included only when
 * the enabled-search branch actually prepends it to the provider request.
 *
 * Keeping this in one helper guarantees neither server-authored system message
 * is forgotten (or double-counted) regardless of the code path.
 */
export function composeSystemInstructions(
  runtimeContextContent: string,
  webSearchEnabled: boolean,
): string {
  return webSearchEnabled
    ? `${runtimeContextContent}\n${buildWebSearchGuidanceMessage().content}`
    : runtimeContextContent;
}
