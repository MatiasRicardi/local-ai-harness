<script setup lang="ts">
import { ref, watch, onUnmounted } from "vue"
import { testProviderConnection, type ProviderTestRequest } from "../services/provider"
import { getProviderSettings, updateProviderSettings } from "../composables/useProviderSettings"

const settings = getProviderSettings()

const state = ref({
  name: settings.value.name,
  baseUrl: settings.value.baseUrl,
  model: settings.value.model,
  contextSizeTokens: settings.value.contextSizeTokens,
  apiKey: settings.value.apiKey,
  timeout: settings.value.timeout,
  status: "" as
    | ""
    | "testing"
    | "success"
    | "error",
  message: "",
  testing: false,
})

const timer = ref<number | undefined>(undefined)

const MIN_CONTEXT_SIZE = 1024
const MAX_CONTEXT_SIZE = 2000000

const doSync = () => {
  if (timer.value) return
  timer.value = setTimeout(() => {
    const validatedContextSize = Math.max(MIN_CONTEXT_SIZE, Math.min(MAX_CONTEXT_SIZE, state.value.contextSizeTokens))
    updateProviderSettings({
      name: state.value.name,
      baseUrl: state.value.baseUrl,
      model: state.value.model,
      contextSizeTokens: validatedContextSize,
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
  { immediate: false }
)

const handleTest = async () => {
  if (!state.value.baseUrl || !state.value.model) return

  state.value.status = "testing"
  state.value.message = ""
  state.value.testing = true

  try {
    const payload: ProviderTestRequest = {
      baseUrl: state.value.baseUrl,
      model: state.value.model,
      apiKey: state.value.apiKey || undefined,
      timeout: state.value.timeout * 1000,
    }

    const response = await testProviderConnection(payload)

    if (response.success) {
      state.value.status = "success"
      state.value.message = `Connected to ${response.model}`
    } else {
      state.value.status = "error"
      state.value.message = response.error || "Connection failed"
    }
  } catch (err) {
    state.value.status = "error"
    state.value.message = err instanceof Error ? err.message : "Connection failed"
  } finally {
    state.value.testing = false
  }
}
</script>

<template>
  <div class="provider-settings flex flex-col gap-3">
    <h2 class="m-0 text-sm font-semibold text-neutral-900">Provider Settings</h2>
    <p class="storage-notice m-0 text-xs text-neutral-500">Settings are stored locally in your browser.</p>

    <form @submit.prevent="handleTest" class="settings-form flex flex-col gap-3">
      <div class="form-group flex flex-col gap-1">
        <label for="provider-name" class="text-xs font-medium text-neutral-700">Provider Name</label>
        <input
          id="provider-name"
          v-model="state.name"
          type="text"
          placeholder="e.g. llama.cpp"
          class="focus-ring w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm text-neutral-900 placeholder:text-neutral-400"
        />
      </div>

      <div class="form-group flex flex-col gap-1">
        <label for="base-url" class="text-xs font-medium text-neutral-700">Base URL</label>
        <input
          id="base-url"
          v-model="state.baseUrl"
          type="url"
          placeholder="http://localhost:8080/v1"
          class="focus-ring w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm text-neutral-900 placeholder:text-neutral-400"
        />
      </div>

      <div class="form-group flex flex-col gap-1">
        <label for="model" class="text-xs font-medium text-neutral-700">Model</label>
        <input
          id="model"
          v-model="state.model"
          type="text"
          placeholder="local-model"
          class="focus-ring w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm text-neutral-900 placeholder:text-neutral-400"
        />
      </div>

      <div class="form-group flex flex-col gap-1">
        <label for="context-size" class="text-xs font-medium text-neutral-700">Context Size (tokens)</label>
        <input
          id="context-size"
          v-model.number="state.contextSizeTokens"
          type="number"
          min="1024"
          max="2000000"
          step="1024"
          class="focus-ring w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm text-neutral-900 placeholder:text-neutral-400"
        />
        <small class="helper text-xs font-normal text-neutral-500">Approximate maximum context window supported by the configured model.</small>
      </div>

      <div class="form-group flex flex-col gap-1">
        <label for="api-key" class="text-xs font-medium text-neutral-700">API Key (optional)</label>
        <input
          id="api-key"
          v-model="state.apiKey"
          type="password"
          placeholder="Leave blank if not required"
          class="focus-ring w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm text-neutral-900 placeholder:text-neutral-400"
        />
        <small class="warning text-xs text-amber-700">Your API key is stored in localStorage on this browser.</small>
      </div>

      <div class="form-group flex flex-col gap-1">
        <label for="timeout" class="text-xs font-medium text-neutral-700">Timeout (seconds)</label>
        <input
          id="timeout"
          v-model.number="state.timeout"
          type="number"
          min="10"
          max="300"
          step="10"
          class="focus-ring w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm text-neutral-900 placeholder:text-neutral-400"
        />
      </div>

      <div class="form-actions flex gap-2">
        <button
          type="submit"
          class="btn btn-primary focus-ring inline-flex items-center justify-center rounded-md bg-sky-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-sky-700 disabled:cursor-not-allowed disabled:bg-neutral-300 disabled:text-neutral-500"
          :disabled="!state.baseUrl || !state.model || state.testing"
        >
          {{ state.testing ? "Testing..." : "Test Connection" }}
        </button>
      </div>

      <div v-if="state.testing" class="status testing mt-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
        Testing connection to {{ state.baseUrl }}...
      </div>

      <div v-else-if="state.status === 'success'" class="status success mt-1 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
        <strong>Connected!</strong> {{ state.message }}
      </div>

      <div v-else-if="state.status === 'error'" class="status error mt-1 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
        <strong>Connection failed</strong> — {{ state.message }}
      </div>
    </form>
  </div>
</template>
