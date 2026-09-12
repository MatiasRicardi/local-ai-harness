<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from "vue"
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

// Live preview of the value being typed, shown in the field's label row.
const contextBadge = computed(() => {
  const tokens = Number(state.value.contextSizeTokens)
  return Number.isFinite(tokens) && tokens > 0 ? tokens.toLocaleString() : ""
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
  <div class="provider-settings flex h-full flex-col">
    <div class="settings-header border-b border-stone-200/70 px-4 py-4">
      <div class="flex items-center gap-2">
        <svg
          class="size-3.5 shrink-0 text-sky-600"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M2.5 6.5h7M15.5 6.5h2M2.5 13.5h1.5M9.5 13.5h8" />
          <circle cx="12.6" cy="6.5" r="1.6" />
          <circle cx="6.6" cy="13.5" r="1.6" />
        </svg>
        <h2 class="m-0 text-xs font-semibold uppercase tracking-[0.14em] text-stone-900">Model Settings</h2>
      </div>
      <p class="storage-notice m-0 mt-1 text-[0.6875rem] leading-relaxed text-stone-500">
        Settings are stored locally in your browser.
      </p>
    </div>

    <form @submit.prevent="handleTest" class="settings-form flex flex-1 flex-col gap-4 p-4">
      <div class="form-group flex flex-col gap-1.5">
        <label for="provider-name" class="text-[0.6875rem] font-semibold uppercase tracking-wider text-stone-500">Provider Name</label>
        <input
          id="provider-name"
          v-model="state.name"
          type="text"
          placeholder="e.g. llama.cpp"
          class="focus-ring w-full rounded-lg border border-stone-200 bg-white px-3 py-2 font-mono text-xs text-stone-900 shadow-sm placeholder:font-sans placeholder:text-stone-400"
        />
      </div>

      <div class="form-group flex flex-col gap-1.5">
        <label for="base-url" class="text-[0.6875rem] font-semibold uppercase tracking-wider text-stone-500">Base URL</label>
        <input
          id="base-url"
          v-model="state.baseUrl"
          type="url"
          placeholder="http://localhost:8080/v1"
          class="focus-ring w-full rounded-lg border border-stone-200 bg-white px-3 py-2 font-mono text-xs text-stone-900 shadow-sm placeholder:font-sans placeholder:text-stone-400"
        />
      </div>

      <div class="form-group flex flex-col gap-1.5">
        <label for="model" class="text-[0.6875rem] font-semibold uppercase tracking-wider text-stone-500">Model</label>
        <input
          id="model"
          v-model="state.model"
          type="text"
          placeholder="local-model"
          class="focus-ring w-full rounded-lg border border-stone-200 bg-white px-3 py-2 font-mono text-xs text-stone-900 shadow-sm placeholder:font-sans placeholder:text-stone-400"
        />
      </div>

      <div class="form-group flex flex-col gap-1.5">
        <div class="flex items-baseline justify-between gap-2">
          <label for="context-size" class="text-[0.6875rem] font-semibold uppercase tracking-wider text-stone-500">Context size</label>
          <span
            v-if="contextBadge"
            class="context-size-value rounded border border-sky-100 bg-sky-50 px-1.5 py-0.5 font-mono text-[0.6875rem] font-semibold text-sky-600"
          >{{ contextBadge }}</span>
        </div>
        <input
          id="context-size"
          v-model.number="state.contextSizeTokens"
          type="number"
          min="1024"
          max="2000000"
          step="1024"
          class="focus-ring w-full rounded-lg border border-stone-200 bg-white px-3 py-2 font-mono text-xs text-stone-900 shadow-sm placeholder:text-stone-400"
        />
        <small class="helper text-[0.6875rem] font-normal leading-relaxed text-stone-500">Approximate maximum context window supported by the configured model.</small>
      </div>

      <div class="form-group flex flex-col gap-1.5">
        <label for="api-key" class="text-[0.6875rem] font-semibold uppercase tracking-wider text-stone-500">
          API Key <span class="font-normal normal-case tracking-normal text-stone-400">(optional)</span>
        </label>
        <div class="relative">
          <input
            id="api-key"
            v-model="state.apiKey"
            type="password"
            placeholder="Leave blank if not required"
            class="focus-ring w-full rounded-lg border border-stone-200 bg-white px-3 py-2 pr-8 font-mono text-xs text-stone-900 shadow-sm placeholder:font-sans placeholder:text-stone-400"
          />
          <svg
            class="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-stone-400"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <rect x="4" y="8.5" width="12" height="8.5" rx="1.5" />
            <path d="M7 8.5V6.8a3 3 0 0 1 6 0v1.7" />
          </svg>
        </div>
        <small class="warning text-[0.6875rem] font-normal leading-relaxed text-amber-700">Your API key is stored in localStorage on this browser.</small>
      </div>

      <div class="form-group flex flex-col gap-1.5">
        <label for="timeout" class="text-[0.6875rem] font-semibold uppercase tracking-wider text-stone-500">Timeout (seconds)</label>
        <input
          id="timeout"
          v-model.number="state.timeout"
          type="number"
          min="10"
          max="300"
          step="10"
          class="focus-ring w-full rounded-lg border border-stone-200 bg-white px-3 py-2 font-mono text-xs text-stone-900 shadow-sm placeholder:text-stone-400"
        />
      </div>

      <div class="form-actions flex flex-col gap-2 pt-1">
        <button
          type="submit"
          class="btn btn-primary focus-ring inline-flex w-full items-center justify-center gap-2 rounded-lg bg-sky-600 px-4 py-2.5 text-xs font-semibold text-white shadow-sm shadow-sky-500/20 transition-all duration-150 hover:bg-sky-700 active:scale-[0.99] disabled:cursor-not-allowed disabled:bg-stone-200 disabled:text-stone-400 disabled:shadow-none"
          :disabled="!state.baseUrl || !state.model || state.testing"
        >
          <svg
            class="size-3.5 shrink-0"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M13 1.8 3.8 11.4h4.6l-1.4 6.8L14.8 8.6h-4.4L13 1.8z" />
          </svg>
          <span>{{ state.testing ? "Testing..." : "Test Connection" }}</span>
        </button>
      </div>

      <div
        v-if="state.testing"
        class="status testing mt-1 flex items-start gap-2 rounded-xl border border-amber-200/80 bg-amber-50/80 px-3 py-2.5 text-xs text-amber-800"
      >
        <span class="mt-1 size-1.5 shrink-0 animate-pulse rounded-full bg-amber-500" aria-hidden="true"></span>
        <span>Testing connection to <span class="font-mono text-[0.6875rem]">{{ state.baseUrl }}</span>...</span>
      </div>

      <div
        v-else-if="state.status === 'success'"
        class="status success mt-1 flex items-start gap-2 rounded-xl border border-emerald-200/80 bg-emerald-50/80 px-3 py-2.5 text-xs text-emerald-800"
      >
        <svg
          class="mt-0.5 size-3.5 shrink-0 text-emerald-600"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="10" cy="10" r="7.5" />
          <path d="m6.2 10.2 2.6 2.6 5-5.4" />
        </svg>
        <span class="min-w-0">
          <strong class="font-semibold">Connected!</strong>
          <span class="mt-0.5 block break-all font-mono text-[0.6875rem] text-emerald-700">{{ state.message }}</span>
        </span>
      </div>

      <div
        v-else-if="state.status === 'error'"
        class="status error mt-1 flex items-start gap-2 rounded-xl border border-red-200/80 bg-red-50/80 px-3 py-2.5 text-xs text-red-800"
      >
        <svg
          class="mt-0.5 size-3.5 shrink-0 text-red-600"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <circle cx="10" cy="10" r="7.5" />
          <path d="M10 6v5" />
          <path d="M10 13.8h.01" />
        </svg>
        <span class="min-w-0">
          <strong class="font-semibold">Connection failed</strong>
          <span class="mt-0.5 block break-words text-[0.6875rem] text-red-700">{{ state.message }}</span>
        </span>
      </div>
    </form>
  </div>
</template>
