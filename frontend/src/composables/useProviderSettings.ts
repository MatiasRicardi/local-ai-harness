import { ref, type Ref } from "vue"

export const STORAGE_KEY = "local-ai-harness-provider-settings"

interface ProviderSettings {
  name: string
  baseUrl: string
  model: string
  apiKey: string
  timeout: number
}

const defaults: ProviderSettings = {
  name: "llama.cpp",
  baseUrl: "http://localhost:8080/v1",
  model: "local-model",
  apiKey: "",
  timeout: 120,
}

function loadFromStorage(): Partial<ProviderSettings> {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      return JSON.parse(saved) as Partial<ProviderSettings>
    }
  } catch {
    // Ignore corrupt storage
  }
  return {}
}

function saveToStorage(settings: ProviderSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
}

function mergeWithDefaults(saved: Partial<ProviderSettings>): ProviderSettings {
  return {
    name: saved.name ?? defaults.name,
    baseUrl: saved.baseUrl ?? defaults.baseUrl,
    model: saved.model ?? defaults.model,
    apiKey: saved.apiKey ?? defaults.apiKey,
    timeout: saved.timeout ?? defaults.timeout,
  }
}

let settingsRef: Ref<ProviderSettings> | null = null

export function getProviderSettings(): Ref<ProviderSettings> {
  if (!settingsRef) {
    const saved = loadFromStorage()
    settingsRef = ref(mergeWithDefaults(saved)) as Ref<ProviderSettings>
  }
  return settingsRef
}

function setSettingsRef(value: ProviderSettings): void {
  if (settingsRef) {
    settingsRef.value = value
  }
}

export function useProviderSettings(): Ref<ProviderSettings> {
  return getProviderSettings()
}

export function updateProviderSettings(updates: Partial<ProviderSettings>): ProviderSettings {
  const current = getProviderSettings().value
  const next = { ...current, ...updates }
  setSettingsRef(next)
  saveToStorage(next)
  return next
}
