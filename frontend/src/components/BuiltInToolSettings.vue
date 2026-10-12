<script setup lang="ts">
import { computed } from "vue"
import AppIcon from "./AppIcon.vue"
import { useToolSettings } from "../composables/useToolSettings"

// Built-in tool toggles (calculator, fetch URL). Read straight from the shared
// composable: this card is a view over `useToolSettings`, it owns no duplicate
// state, and it is independent from the Tavily web-search card above — the
// built-in tools need no credentials and are owned by the model/server, so they
// must never be mixed with `webSearch`.

const tools = useToolSettings()

const calculatorEnabled = computed(() => tools.settings.value.calculatorEnabled)
const fetchUrlEnabled = computed(() => tools.settings.value.fetchUrlEnabled)

function onCalculatorToggle(event: Event): void {
  tools.updateToolSettings({
    calculatorEnabled: (event.target as HTMLInputElement).checked,
  })
}

function onFetchUrlToggle(event: Event): void {
  tools.updateToolSettings({
    fetchUrlEnabled: (event.target as HTMLInputElement).checked,
  })
}
</script>

<template>
  <section
    class="built-in-tool-settings settings-card space-y-3 bg-white"
    role="group"
    aria-labelledby="built-in-tools-title"
  >
    <div class="flex items-center justify-between gap-2">
      <h3 id="built-in-tools-title" class="settings-card-title">
        <AppIcon name="chip" class="size-3.5 text-indigo-600" />
        <span>Built-in Tools</span>
      </h3>
    </div>

    <p class="field-hint">
      Enable the model to use deterministic capabilities directly. Both are off
      by default; turn them on only when your model issues tool calls.
    </p>

    <!-- Toggle: Calculator -->
    <div class="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50/60 px-2.5 py-1.5">
      <div class="max-w-[60%]">
        <span class="field-label">Calculator</span>
        <p class="mt-1 text-[0.6875rem] leading-relaxed text-slate-500">
          Lets the model delegate arithmetic to deterministic code instead of
          calculating mentally.
        </p>
      </div>
      <label class="web-search-toggle relative inline-flex h-4.5 w-8 shrink-0 cursor-pointer items-center">
        <input
          type="checkbox"
          class="peer sr-only"
          :checked="calculatorEnabled"
          aria-label="Enable calculator tool"
          @change="onCalculatorToggle($event)"
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

    <!-- Toggle: Fetch URL -->
    <div class="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50/60 px-2.5 py-1.5">
      <div class="max-w-[60%]">
        <span class="field-label">Fetch URL</span>
        <p class="mt-1 text-[0.6875rem] leading-relaxed text-slate-500">
          Lets the model read text from a specific public HTTP(S) page. Private
          or local addresses and binary files are blocked by the backend.
        </p>
      </div>
      <label class="web-search-toggle relative inline-flex h-4.5 w-8 shrink-0 cursor-pointer items-center">
        <input
          type="checkbox"
          class="peer sr-only"
          :checked="fetchUrlEnabled"
          aria-label="Enable fetch URL tool"
          @change="onFetchUrlToggle($event)"
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

    <p class="field-hint">
      When built-in tools are enabled, intermediate tool rounds may be buffered
      before the final answer streams.
    </p>
  </section>
</template>
