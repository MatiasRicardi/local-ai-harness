import { ref, type Ref, watch } from "vue"

// ── Web search settings ──────────────────────────────────────────────────────
//
// User-configured Tavily web-search options. These are deliberately separate
// from the LLM provider settings (`useProviderSettings`): the provider
// `apiKey` configures the local model, while this `apiKey` is the Tavily key.
// They must never be mixed.
//
// Design mirrors `useProviderSettings` but keeps the heavy lifting in pure
// helpers so persistence, defaults and bounds are unit-testable without a
// Vue component or a leaked module-level singleton.

export type WebSearchProviderName = "tavily"
export type WebSearchDepth = "basic" | "advanced"

export interface WebSearchSettings {
  enabled: boolean
  provider: WebSearchProviderName
  apiKey: string
  searchDepth: WebSearchDepth
  maxResults: number
}

export const WEB_SEARCH_STORAGE_KEY = "local-ai-harness-web-search-settings"

// Conservative bounds enforced before any external call. Mirrors the backend
// `WEB_SEARCH_MIN_RESULTS` / `WEB_SEARCH_MAX_RESULTS`.
export const WEB_SEARCH_MIN_RESULTS = 1
export const WEB_SEARCH_MAX_RESULTS = 10

export const DEFAULT_WEB_SEARCH_SETTINGS: WebSearchSettings = {
  enabled: false,
  provider: "tavily",
  apiKey: "",
  searchDepth: "basic",
  maxResults: 5,
}

/**
 * Apply defaults and normalise an (possibly partial / stale) object into a
 * complete, in-range {@link WebSearchSettings}.
 *
 * `provider` is intentionally fixed to `tavily`: the UI exposes no real
 * multi-provider selector in this phase, so any other stored value is ignored.
 * `maxResults` is clamped to `[1, 10]`; non-numeric / out-of-range input falls
 * back to the default so an HTML `input[number]` can never produce an invalid
 * persisted value.
 */
export function mergeWithWebSearchDefaults(
  partial: Partial<WebSearchSettings> = {},
): WebSearchSettings {
  return {
    // `??` only guards null/undefined, so a corrupted persisted field (e.g.
    // `"apiKey": 42`) would slip through as the wrong type and later break
    // callers that assume the declared type (e.g. `.trim()` on `apiKey`).
    // Validate the runtime type / enum before accepting each value.
    enabled:
      typeof partial.enabled === "boolean"
        ? partial.enabled
        : DEFAULT_WEB_SEARCH_SETTINGS.enabled,
    provider: "tavily",
    apiKey:
      typeof partial.apiKey === "string"
        ? partial.apiKey
        : DEFAULT_WEB_SEARCH_SETTINGS.apiKey,
    searchDepth:
      partial.searchDepth === "basic" || partial.searchDepth === "advanced"
        ? partial.searchDepth
        : DEFAULT_WEB_SEARCH_SETTINGS.searchDepth,
    maxResults: clampMaxResults(partial.maxResults),
  }
}

export function clampMaxResults(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(numeric)) {
    return DEFAULT_WEB_SEARCH_SETTINGS.maxResults
  }
  return Math.max(WEB_SEARCH_MIN_RESULTS, Math.min(WEB_SEARCH_MAX_RESULTS, numeric))
}

/**
 * Load persisted settings from `localStorage`, falling back to defaults when
 * nothing is stored or the stored value is corrupt. Never throws.
 */
export function loadWebSearchSettings(): WebSearchSettings {
  try {
    const saved = localStorage.getItem(WEB_SEARCH_STORAGE_KEY)
    const parsed = saved ? (JSON.parse(saved) as Partial<WebSearchSettings>) : {}
    return mergeWithWebSearchDefaults(parsed)
  } catch {
    return mergeWithWebSearchDefaults({})
  }
}

/** Persist settings as JSON. Writes only what it receives (already normalised). */
export function saveWebSearchSettings(settings: WebSearchSettings): void {
  localStorage.setItem(WEB_SEARCH_STORAGE_KEY, JSON.stringify(settings))
}

let settingsRef: Ref<WebSearchSettings> | null = null

function getSettingsRef(): Ref<WebSearchSettings> {
  if (!settingsRef) {
    const boundRef = ref(loadWebSearchSettings())
    settingsRef = boundRef
    // Keep the persisted value in lock-step with direct DOM binding: every
    // mutation is normalised (clamp) and saved. Idempotent, so re-assigning an
    // already-normalised value does not loop.
    watch(
      boundRef,
      (value) => {
        const next = mergeWithWebSearchDefaults(value)
        const changed =
          next.enabled !== value.enabled ||
          next.apiKey !== value.apiKey ||
          next.searchDepth !== value.searchDepth ||
          next.maxResults !== value.maxResults
        if (changed) {
          boundRef.value = next
        }
        saveWebSearchSettings(next)
      },
      { deep: true },
    )
  }
  return settingsRef
}

/**
 * Reactive web-search settings shared across the app (singleton). Call it from
 * any component; both callers observe the same underlying ref.
 */
export function useWebSearchSettings(): {
  settings: Ref<WebSearchSettings>
  updateWebSearchSettings(updates: Partial<WebSearchSettings>): WebSearchSettings
} {
  const settings = getSettingsRef()
  return {
    settings,
    updateWebSearchSettings(updates: Partial<WebSearchSettings>): WebSearchSettings {
      const next = updateWebSearchSettings(settings.value, updates)
      settings.value = next
      return next
    },
  }
}

/**
 * Merge `updates` over `current`, persist and return the normalised result.
 * Exported so tests (and any caller) can drive the singleton's ref directly
 * without mounting a component.
 */
export function updateWebSearchSettings(
  current: WebSearchSettings,
  updates: Partial<WebSearchSettings>,
): WebSearchSettings {
  const next = mergeWithWebSearchSettings(current, updates)
  saveWebSearchSettings(next)
  return next
}

/** Merge `updates` over `current` and normalise. Shared by the composable. */
export function mergeWithWebSearchSettings(
  current: WebSearchSettings,
  updates: Partial<WebSearchSettings>,
): WebSearchSettings {
  return mergeWithWebSearchDefaults({ ...current, ...updates })
}
