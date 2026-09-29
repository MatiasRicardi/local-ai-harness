<script setup lang="ts">
import AppIcon from "./AppIcon.vue"
import type { ConnectionTestStatus } from "../composables/useConnectionTest"

interface Props {
  /** A test needs both an endpoint and a model, and cannot run while busy. */
  disabled: boolean
  /** Outcome of the last explicit Test Connection action; "" when never run. */
  status: ConnectionTestStatus
  /** Human-readable result text from the last run. */
  message: string
  /** Endpoint the last run targeted (shown only while testing). */
  baseUrl: string
}

defineProps<Props>()
</script>

<template>
  <div class="connection-test-footer shrink-0 border-t border-slate-200 bg-white p-3">
    <div
      v-if="status === 'testing'"
      class="status testing flex items-start gap-2 rounded-xl border border-amber-200/80 bg-amber-50/80 px-3 py-2.5 text-xs text-amber-800"
    >
      <span class="mt-1 size-1.5 shrink-0 animate-pulse rounded-full bg-amber-500" aria-hidden="true"></span>
      <span>
        Testing connection to
        <span class="break-all font-mono text-[0.6875rem]">{{ baseUrl }}</span>&hellip;
      </span>
    </div>

    <div
      v-else-if="status === 'success'"
      class="status success flex items-start gap-2 rounded-xl border border-emerald-200/80 bg-emerald-50/80 px-3 py-2.5 text-xs text-emerald-800"
    >
      <AppIcon name="check" class="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
      <span class="min-w-0">
        <strong class="font-semibold">Connected!</strong>
        <span class="mt-0.5 block break-all font-mono text-[0.6875rem] text-emerald-700">{{ message }}</span>
      </span>
    </div>

    <div
      v-else-if="status === 'error'"
      class="status error flex items-start gap-2 rounded-xl border border-red-200/80 bg-red-50/80 px-3 py-2.5 text-xs text-red-800"
    >
      <AppIcon name="shield-alert" class="mt-0.5 size-3.5 shrink-0 text-red-600" />
      <span class="min-w-0">
        <strong class="font-semibold">Connection failed</strong>
        <span class="mt-0.5 block break-words text-[0.6875rem] text-red-700">{{ message }}</span>
      </span>
    </div>

    <div class="mt-0.5 rounded-xl bg-slate-900 p-2.5 shadow-floating">
      <button
        type="submit"
        class="btn btn-primary focus-ring inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white shadow-sm shadow-indigo-950/40 transition-all duration-150 hover:bg-indigo-500 active:scale-[0.99] disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400 disabled:shadow-none"
        :disabled="disabled"
      >
        <AppIcon name="zap" class="size-3.5 shrink-0" />
        <span>{{ status === "testing" ? "Testing..." : "Test Connection" }}</span>
      </button>
      <p class="m-0 mt-2 text-center text-[0.625rem] leading-relaxed text-slate-400">
        Sends one minimal prompt to the endpoint and model in the form.
      </p>
    </div>
  </div>
</template>
