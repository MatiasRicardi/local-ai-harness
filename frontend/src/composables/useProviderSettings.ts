import { reactive } from "vue"

const STORAGE_KEY = "local-ai-harness-provider-settings"
const defaults = {
  name: "llama.cpp",
  baseUrl: "http://localhost:8080/v1",
  model: "local-model",
  apiKey: "",
  timeout: 120,
}

interface ProviderSettings {
  name: string
  baseUrl: string
  model: string
  apiKey: string
  timeout: number
}

let settings: ProviderSettings | null = null

export function getProviderSettings(): ProviderSettings {
  if (!settings) {
    settings = reactive({
      name: defaults.name,
      baseUrl: defaults.baseUrl,
      model: defaults.model,
      apiKey: defaults.apiKey,
      timeout: defaults.timeout,
    }) as unknown as ProviderSettings

    // Load from localStorage
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        const parsed = JSON.parse(saved) as Partial<ProviderSettings>
        if (parsed.name !== undefined) settings.name = parsed.name
        if (parsed.baseUrl !== undefined) settings.baseUrl = parsed.baseUrl
        if (parsed.model !== undefined) settings.model = parsed.model
        if (parsed.apiKey !== undefined) settings.apiKey = parsed.apiKey
        if (parsed.timeout !== undefined) settings.timeout = parsed.timeout
      }
    } catch {
      // Ignore corrupt storage
    }
  }

  return settings
}

export function useProviderSettings() {
  return getProviderSettings()
}
