<script setup lang="ts">
import { computed } from "vue"
import AppIcon from "./AppIcon.vue"
import { useWebSearchSettings } from "../composables/useWebSearchSettings"

// Tavily web-search settings. Read straight from the shared composable: this
// card is a view over `useWebSearchSettings`, it owns no duplicate state, and
// it must never touch the provider API key above (different key, different
// destination). `provider` stays Tavily-only — the backend supports just this
// one — so no selector is offered.
const webSearch = useWebSearchSettings()

const enabled = computed(() => webSearch.settings.value.enabled)

// Mirrors the App-level send guard, surfaced inline next to the field.
const missingKey = computed(() => enabled.value && !webSearch.settings.value.apiKey.trim())

function onToggle(event: Event): void {
  webSearch.updateWebSearchSettings({ enabled: (event.target as HTMLInputElement).checked })
}

function onApiKeyInput(event: Event): void {
  webSearch.updateWebSearchSettings({ apiKey: (event.target as HTMLInputElement).value })
}

function onSearchDepthChange(event: Event): void {
  webSearch.updateWebSearchSettings({
    searchDepth: (event.target as HTMLSelectElement).value as "basic" | "advanced",
  })
}

function onMaxResultsInput(event: Event): void {
  webSearch.updateWebSearchSettings({
    maxResults: Number((event.target as HTMLInputElement).value),
  })
}
</script>

<template>
  <section
    class="web-search-settings settings-card space-y-3 bg-white"
    role="group"
    aria-labelledby="web-search-settings-title"
  >
    <div class="flex items-center justify-between gap-2">
      <h3 id="web-search-settings-title" class="settings-card-title">
        <AppIcon name="globe" class="size-3.5 text-indigo-600" />
        <span>Web Search</span>
      </h3>
      <!-- Real checkbox (keyboard/AT accessible) styled as a switch. The track
           and knob are siblings of the input so Tailwind's `peer-*` variants
           apply to both. -->
      <label class="web-search-toggle relative inline-flex h-4.5 w-8 shrink-0 cursor-pointer items-center">
        <input
          type="checkbox"
          class="peer sr-only"
          :checked="enabled"
          aria-label="Enable web search"
          aria-describedby="web-search-hint"
          @change="onToggle($event)"
        />
        <span
          class="block h-4.5 w-8 rounded-full bg-slate-200 transition-colors duration-150 peer-checked:bg-indigo-600 peer-focus-visible:ring-2 peer-focus-visible:ring-inset peer-focus-visible:ring-indigo-500/40"
          aria-hidden="true"
        ></span>
        <span
          class="pointer-events-none absolute left-0.5 size-3.5 rounded-full bg-white shadow-sm transition-transform duration-150 peer-checked:translate-x-3.5"
          aria-hidden="true"
        ></span>
      </label>
    </div>

    <p id="web-search-hint" class="field-hint">
      Lets the model search the web with Tavily. One search per message; pages
      are not fetched.
    </p>

    <div class="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50/60 px-2.5 py-1.5">
      <span class="field-label">Provider</span>
      <span class="font-mono text-xs font-medium text-slate-700">Tavily</span>
    </div>

    <div class="space-y-1">
      <label for="web-search-api-key" class="field-label">
        Tavily API Key
        <span v-if="enabled" class="text-amber-700">(required when enabled)</span>
      </label>
      <div class="relative">
        <input
          id="web-search-api-key"
          :value="webSearch.settings.value.apiKey"
          type="password"
          placeholder="tvly-..."
          autocomplete="off"
          spellcheck="false"
          aria-autocomplete="none"
          class="field-input focus-ring pr-8 placeholder:text-slate-400"
          @input="onApiKeyInput($event)"
        />
        <AppIcon
          name="lock"
          class="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-slate-400"
        />
      </div>
      <p v-if="missingKey" class="web-search-key-warning field-hint text-amber-700">
        Enter your Tavily API key to enable web search.
      </p>
      <p v-else class="field-hint">
        Sent to your Local AI Harness backend, and only when Web Search is on.
      </p>
    </div>

    <div class="grid grid-cols-2 gap-2.5">
      <div class="space-y-1">
        <label for="search-depth" class="field-label">Search depth</label>
        <select
          id="search-depth"
          :value="webSearch.settings.value.searchDepth"
          class="focus-ring w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-800 shadow-subtle focus:border-indigo-600"
          @change="onSearchDepthChange($event)"
        >
          <option value="basic">Basic</option>
          <option value="advanced">Advanced</option>
        </select>
      </div>
      <div class="space-y-1">
        <label for="max-results" class="field-label">Max results</label>
        <input
          id="max-results"
          :value="webSearch.settings.value.maxResults"
          type="number"
          min="1"
          max="10"
          step="1"
          class="field-input focus-ring"
          @input="onMaxResultsInput($event)"
        />
      </div>
    </div>

    <p class="field-hint">
      Advanced depth costs more Tavily credits and returns slightly better
      matches. Range: 1–10 results.
    </p>
  </section>
</template>
