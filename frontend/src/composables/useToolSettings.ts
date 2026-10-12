import { ref, type Ref, watch } from "vue"

// ── Built-in tool settings ───────────────────────────────────────────────────
//
// Opt-in switches for the built-in model tools (calculator, fetch URL). These
// are deliberately separate from the provider settings (`useProviderSettings`)
// and from the Tavily web-search settings (`useWebSearchSettings`): the built-in
// tools require no credentials and are owned by the model/server, not by a
// third-party provider, so they must never be mixed with either of those.
//
// Design mirrors `useWebSearchSettings` (a shared singleton ref persisted to
// `localStorage`) but stays minimal: only two boolean toggles, no provider
// selector, no credential field.

export interface ToolSettings {
  calculatorEnabled: boolean
  fetchUrlEnabled: boolean
}

export const TOOL_STORAGE_KEY = "local-ai-harness-tool-settings"

export const DEFAULT_TOOL_SETTINGS: ToolSettings = {
  calculatorEnabled: false,
  fetchUrlEnabled: false,
}

/**
 * Apply defaults and normalise an (possibly partial / stale) object into a
 * complete {@link ToolSettings}.
 *
 * Only real booleans are accepted: an absent, `null`, or non-boolean stored
 * value (e.g. the string `"true"`) falls back to `false` rather than being
 * coerced through `truthiness`, so a corrupted persisted field can never turn a
 * tool on unexpectedly.
 */
export function mergeWithToolDefaults(
  partial: Partial<ToolSettings> = {},
): ToolSettings {
  return {
    // Accept only real booleans. A non-boolean stored value (e.g. the string
    // "true", or a number) falls back to `false` rather than being coerced
    // through truthiness, so a corrupted persisted field can never turn a tool
    // on unexpectedly.
    calculatorEnabled: typeof partial.calculatorEnabled === "boolean" ? partial.calculatorEnabled : false,
    fetchUrlEnabled: typeof partial.fetchUrlEnabled === "boolean" ? partial.fetchUrlEnabled : false,
  }
}

/**
 * Load persisted settings from `localStorage`, falling back to defaults when
 * nothing is stored or the stored value is corrupt. Never throws: a read
 * failure (missing storage, blocked cookies, a corrupt entry) must not break
 * chat, so it silently yields the defaults.
 */
export function loadToolSettings(): ToolSettings {
  try {
    const saved = localStorage.getItem(TOOL_STORAGE_KEY)
    const parsed = saved ? (JSON.parse(saved) as Partial<ToolSettings>) : {}
    return mergeWithToolDefaults(parsed)
  } catch {
    return mergeWithToolDefaults({})
  }
}

/**
 * Persist settings as JSON. The write is wrapped so a `setItem` failure (quota,
 * disabled storage) never propagates and breaks the caller: the in-memory
 * state stays authoritative for the current session.
 */
export function saveToolSettings(settings: ToolSettings): void {
  try {
    localStorage.setItem(TOOL_STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // Ignore: persistence is best-effort and must never break chat.
  }
}

let settingsRef: Ref<ToolSettings> | null = null

function getSettingsRef(): Ref<ToolSettings> {
  if (!settingsRef) {
    const boundRef = ref(loadToolSettings())
    settingsRef = boundRef
    // Keep the persisted value in lock-step with the ref. Idempotent, so
    // re-assigning an already-normalised value does not loop.
    watch(
      boundRef,
      (value) => {
        saveToolSettings(mergeWithToolDefaults(value))
      },
      { deep: true },
    )
  }
  return settingsRef
}

/**
 * Reactive built-in tool settings shared across the app (singleton). Call it
 * from any component; both callers observe the same underlying ref.
 */
export function useToolSettings(): {
  settings: Ref<ToolSettings>
  updateToolSettings(updates: Partial<ToolSettings>): ToolSettings
} {
  const settings = getSettingsRef()
  return {
    settings,
    updateToolSettings(updates: Partial<ToolSettings>): ToolSettings {
      const next = { ...settings.value, ...updates }
      settings.value = next
      return next
    },
  }
}
