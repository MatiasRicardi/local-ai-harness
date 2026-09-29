<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from "vue"
import AppIcon from "./AppIcon.vue"
import ConnectionSettings from "./ConnectionSettings.vue"
import RuntimeSettings from "./RuntimeSettings.vue"
import WebSearchSettings from "./WebSearchSettings.vue"
import ConnectionTestFooter from "./ConnectionTestFooter.vue"
import {
  clampContextSize,
  getProviderSettings,
  updateProviderSettings,
} from "../composables/useProviderSettings"
import { runConnectionTest, useConnectionTest } from "../composables/useConnectionTest"

const settings = getProviderSettings()

// Draft being edited. Persisting it is debounced below; the test action reads
// it directly so it always targets what is currently in the form.
const state = ref({
  name: settings.value.name,
  baseUrl: settings.value.baseUrl,
  model: settings.value.model,
  contextSizeTokens: settings.value.contextSizeTokens,
  apiKey: settings.value.apiKey,
  timeout: settings.value.timeout,
})

// Result of the explicit Test Connection action, shared with the app header.
const { status, message, testing } = useConnectionTest()

// Reactive inline error for the Tavily key lives in the Web Search card; App
// also blocks the send path as a backstop.

// True when the configured provider base URL is a cleartext (http://) target on
// a non-local host: the stored apiKey (and any conversation contents forwarded
// to the provider) would be sent over an unencrypted connection (CWE-319).
// Loopback and HTTPS targets are safe. The backend accepts http:// by design (a
// provider may be a local llama.cpp/Ollama server), so this is a warning, not a
// block — the user may intend a LAN/local setup.
const providerBaseUrlInsecure = computed(() => {
  const base = state.value.baseUrl.trim()
  if (!base) return false
  let parsed: URL
  try {
    parsed = new URL(base)
  } catch {
    return false
  }
  if (parsed.protocol !== "http:") return false
  const host = parsed.hostname.toLowerCase()
  return host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]"
})

const timer = ref<number | undefined>(undefined)

const doSync = () => {
  if (timer.value) return
  timer.value = setTimeout(() => {
    updateProviderSettings({
      name: state.value.name,
      baseUrl: state.value.baseUrl,
      model: state.value.model,
      contextSizeTokens: clampContextSize(state.value.contextSizeTokens),
      apiKey: state.value.apiKey,
      timeout: state.value.timeout,
    })
    timer.value = undefined
  }, 300)
}

// Clean up timer on unmount
onUnmounted(() => {
  clearTimeout(timer.value)
  timer.value = undefined
})

// Watch for changes and sync with debounce
watch(
  () => [
    state.value.name,
    state.value.baseUrl,
    state.value.model,
    state.value.contextSizeTokens,
    state.value.apiKey,
    state.value.timeout,
  ],
  doSync,
  { immediate: false },
)

// A test needs an endpoint and a model; while one is running it cannot be
// re-issued.
const testDisabled = computed(
  () => !state.value.baseUrl || !state.value.model || testing.value,
)

function handleTest(): void {
  if (testDisabled.value) return
  void runConnectionTest({
    baseUrl: state.value.baseUrl,
    model: state.value.model,
    apiKey: state.value.apiKey,
    timeout: state.value.timeout,
  })
}
</script>

<template>
  <div class="provider-settings flex h-full min-h-0 flex-col">
    <div class="settings-header shrink-0 border-b border-slate-200 bg-white px-3.5 py-3">
      <h2
        class="m-0 flex items-center gap-1.5 text-xs font-semibold tracking-tight text-slate-900"
      >
        <AppIcon name="sliders" class="size-3.5 text-indigo-600" />
        <span>Model Settings</span>
      </h2>
      <p class="storage-notice m-0 mt-1 text-[0.6875rem] leading-relaxed text-slate-500">
        Settings are stored locally in your browser.
      </p>
    </div>

    <form class="settings-form flex min-h-0 flex-1 flex-col" @submit.prevent="handleTest">
      <div class="settings-groups min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <ConnectionSettings
          v-model:provider-name="state.name"
          v-model:base-url="state.baseUrl"
          v-model:model="state.model"
          :insecure-base-url="providerBaseUrlInsecure"
          :connection-status="status"
        />

        <RuntimeSettings
          v-model:context-size-tokens="state.contextSizeTokens"
          v-model:timeout="state.timeout"
          v-model:api-key="state.apiKey"
        />

        <WebSearchSettings />
      </div>

      <ConnectionTestFooter
        :disabled="testDisabled"
        :status="status"
        :message="message"
        :base-url="state.baseUrl"
      />
    </form>
  </div>
</template>
