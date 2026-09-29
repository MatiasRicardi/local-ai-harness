<script setup lang="ts">
import { computed } from "vue"
import AppIcon from "./AppIcon.vue"
import type { ConnectionTestStatus } from "../composables/useConnectionTest"

// Compact application header. Every value is passed in from the settings that
// App already owns: nothing here is hardcoded and nothing is polled.
interface Props {
  providerName: string
  /** Endpoint host without the URL scheme (cosmetic summary of the base URL). */
  endpointHost: string
  model: string
  /** Configured context window, already localised (e.g. "32,768"). */
  contextLabel: string
  /** Outcome of the explicit Test Connection action; "" when never run. */
  connectionStatus: ConnectionTestStatus
}

const props = defineProps<Props>()

defineEmits<{
  reset: []
}>()

// Application version injected at build time from package.json.
const version = __APP_VERSION__

// Screen-reader explanation of the status dot: a colour alone must not carry
// the meaning, and the dot must not imply a live health check.
const statusLabel = computed(
  () =>
    ({
      "": "Connection not tested yet",
      testing: "Connection test in progress",
      success: "Connection test succeeded",
      error: "Connection test failed",
    })[props.connectionStatus],
)
</script>

<template>
  <header
    class="app-header flex h-14 shrink-0 items-center justify-between gap-3 border-b border-slate-200 bg-white/95 px-4 backdrop-blur"
  >
    <div class="flex min-w-0 items-center gap-2.5 md:gap-3">
      <div
        class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-indigo-600 text-white shadow-sm shadow-indigo-200 ring-1 ring-indigo-500/70"
      >
        <AppIcon name="chip" class="size-4" />
      </div>
      <div class="flex min-w-0 items-center gap-2">
        <h1 class="truncate text-sm font-semibold tracking-tight text-slate-900">Local AI Harness</h1>
        <span
          class="hidden rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 font-mono text-[0.625rem] font-medium text-slate-600 sm:inline-block"
        >v{{ version }}</span>
      </div>

      <div class="mx-1 hidden h-4 w-px shrink-0 bg-slate-200 sm:block" aria-hidden="true"></div>

      <!-- Endpoint summary: configured provider + host. The dot reflects the
           last explicit connection test only (neutral when never tested). -->
      <div
        v-if="endpointHost"
        class="hidden min-w-0 items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 font-mono text-xs text-slate-600 sm:flex"
        :title="`${providerName} · ${endpointHost}`"
      >
        <span
          class="size-2 shrink-0 rounded-full"
          :class="{
            'bg-slate-300': connectionStatus === '',
            'animate-pulse bg-amber-500': connectionStatus === 'testing',
            'bg-emerald-500': connectionStatus === 'success',
            'bg-red-500': connectionStatus === 'error',
          }"
          aria-hidden="true"
        ></span>
        <span class="sr-only">{{ statusLabel }}. </span>
        <span
          v-if="providerName"
          class="max-w-[10rem] min-w-0 shrink-0 truncate font-medium text-slate-700"
        >{{ providerName }}</span>
        <span v-if="providerName" class="shrink-0 text-slate-400" aria-hidden="true">&middot;</span>
        <span class="min-w-0 truncate text-slate-500">{{ endpointHost }}</span>
      </div>
    </div>

    <div class="flex shrink-0 items-center gap-2 md:gap-3">
      <div
        v-if="model"
        class="hidden min-w-0 items-center gap-1.5 rounded-full border border-indigo-100 bg-indigo-50/80 px-2.5 py-1 font-mono text-xs text-indigo-950 md:flex"
        :title="`${model} · ${contextLabel} tokens context`"
      >
        <AppIcon name="sparkles" class="size-3.5 shrink-0 text-indigo-600" />
        <span class="max-w-[14rem] min-w-0 truncate font-medium">{{ model }}</span>
        <template v-if="contextLabel">
          <span class="shrink-0 text-indigo-400" aria-hidden="true">&middot;</span>
          <span class="shrink-0 text-indigo-700">{{ contextLabel }} ctx</span>
        </template>
      </div>

      <button
        type="button"
        class="app-header-new-chat focus-ring inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm shadow-indigo-200 transition-colors duration-150 hover:bg-indigo-700 active:bg-indigo-800 active:scale-[0.98]"
        aria-label="Start a new conversation"
        @click="$emit('reset')"
      >
        <AppIcon name="plus" class="size-3.5 stroke-[2.5]" />
        <span>New Chat</span>
      </button>
    </div>
  </header>
</template>
