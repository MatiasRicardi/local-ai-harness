<script setup lang="ts">
import { computed } from "vue"
import AppIcon from "./AppIcon.vue"
import { MAX_CONTEXT_SIZE, MIN_CONTEXT_SIZE } from "../composables/useProviderSettings"

// Two-way bound to the settings draft owned by ProviderSettings.
const contextSizeTokens = defineModel<number>("contextSizeTokens", { required: true })
const timeout = defineModel<number>("timeout", { required: true })
const apiKey = defineModel<string>("apiKey", { required: true })

// The accepted window is 1,024 … 2,000,000 tokens, so a linear slider would put
// every realistic model in the first few percent of the track. The slider walks
// a power-of-two ladder derived from the real bounds instead; the number field
// below it still accepts any exact value inside those bounds.
const contextRungs = computed<number[]>(() => {
  const rungs: number[] = []
  for (let tokens = MIN_CONTEXT_SIZE; tokens <= MAX_CONTEXT_SIZE; tokens *= 2) {
    rungs.push(tokens)
  }
  return rungs
})

// Position of the configured value on the ladder (nearest rung). Derived, never
// stored: the number field and the slider always read the same model value.
const contextRungIndex = computed(() => {
  let best = 0
  let bestDistance = Number.POSITIVE_INFINITY
  contextRungs.value.forEach((tokens, index) => {
    const distance = Math.abs(tokens - contextSizeTokens.value)
    if (distance < bestDistance) {
      best = index
      bestDistance = distance
    }
  })
  return best
})

function handleRungInput(event: Event): void {
  const index = Number((event.target as HTMLInputElement).value)
  const rung = contextRungs.value[index]
  if (Number.isFinite(rung)) {
    contextSizeTokens.value = rung
  }
}

// Labels for a handful of evenly spaced rungs, so the scale is readable without
// hardcoding a range that the settings do not allow.
const contextRungLabels = computed(() => {
  const rungs = contextRungs.value
  const step = Math.max(1, Math.round((rungs.length - 1) / 5))
  const indices: number[] = []
  for (let index = 0; index < rungs.length; index += step) {
    indices.push(index)
  }
  if (indices[indices.length - 1] !== rungs.length - 1) {
    indices.push(rungs.length - 1)
  }
  return indices.map((index) => ({
    index,
    label: formatKiloTokens(rungs[index]),
    active: index === contextRungIndex.value,
  }))
})

function formatKiloTokens(tokens: number): string {
  if (tokens >= 1024 * 1024) return `${Math.round(tokens / (1024 * 1024))}M`
  if (tokens >= 1024) return `${Math.round(tokens / 1024)}K`
  return String(tokens)
}

const contextLabel = computed(() =>
  Number.isFinite(contextSizeTokens.value) ? contextSizeTokens.value.toLocaleString() : "",
)

// Numeric fields ignore unparsable input (a cleared field, "abc") instead of
// writing NaN into the draft, which would otherwise be sent to the provider.
function commitNumber(event: Event, apply: (value: number) => void): void {
  const raw = (event.target as HTMLInputElement).value
  const parsed = Number(raw)
  if (raw.trim() === "" || !Number.isFinite(parsed)) return
  apply(parsed)
}
</script>

<template>
  <section
    class="runtime-settings settings-card space-y-3.5 bg-white"
    aria-labelledby="runtime-settings-title"
  >
    <div class="flex items-center justify-between gap-2">
      <h3 id="runtime-settings-title" class="settings-card-title">
        <AppIcon name="gauge" class="size-3.5 text-indigo-600" />
        <span>Context &amp; Runtime</span>
      </h3>
      <span
        v-if="contextLabel"
        class="rounded bg-indigo-50 px-2 py-0.5 font-mono text-[0.6875rem] font-semibold text-indigo-600"
      >{{ contextLabel }} tokens</span>
    </div>

    <div class="space-y-1.5">
      <div class="flex items-baseline justify-between gap-2">
        <label for="context-slider" class="field-label">Context window</label>
        <span
          v-if="contextLabel"
          class="font-mono text-[0.6875rem] font-medium text-slate-700"
        >{{ contextLabel }}</span>
      </div>
      <input
        id="context-slider"
        :value="contextRungIndex"
        type="range"
        min="0"
        :max="contextRungs.length - 1"
        step="1"
        class="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-slate-200 accent-indigo-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
        @input="handleRungInput"
      />
      <div class="flex justify-between font-mono text-[0.5625rem] text-slate-400">
        <span
          v-for="rung in contextRungLabels"
          :key="rung.index"
          :class="rung.active ? 'font-bold text-indigo-600' : ''"
        >{{ rung.label }}</span>
      </div>
    </div>

    <div class="grid grid-cols-2 gap-2.5 pt-0.5">
      <div class="space-y-1">
        <label for="context-size" class="field-label">Context size</label>
        <input
          id="context-size"
          :value="contextSizeTokens"
          type="number"
          min="1024"
          max="2000000"
          step="1024"
          class="field-input focus-ring"
          @input="commitNumber($event, (value) => (contextSizeTokens = value))"
        />
      </div>
      <div class="space-y-1">
        <label for="timeout" class="field-label">Timeout (sec)</label>
        <input
          id="timeout"
          :value="timeout"
          type="number"
          min="10"
          max="300"
          step="10"
          class="field-input focus-ring"
          @input="commitNumber($event, (value) => (timeout = value))"
        />
      </div>
    </div>

    <div class="space-y-1">
      <label for="api-key" class="field-label">
        API Key
        <span class="font-normal text-slate-400">(optional)</span>
      </label>
      <div class="relative">
        <input
          id="api-key"
          v-model="apiKey"
          type="password"
          autocomplete="off"
          spellcheck="false"
          placeholder="Leave blank if not required"
          class="field-input focus-ring pr-8 placeholder:font-sans placeholder:text-slate-400"
        />
        <AppIcon
          name="lock"
          class="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-slate-400"
        />
      </div>
      <p class="provider-key-notice field-hint text-amber-700">
        Your API key is stored in localStorage on this browser.
      </p>
    </div>

    <p class="field-hint">
      Context size is the approximate maximum window supported by the configured
      model; requests larger than it are truncated or rejected.
    </p>
  </section>
</template>
