<script setup lang="ts">
import AppIcon from "./AppIcon.vue"
import type { ConnectionTestStatus } from "../composables/useConnectionTest"

interface Props {
  /** True when the base URL is cleartext HTTP to a non-local host (CWE-319). */
  insecureBaseUrl: boolean
  /** Outcome of the last explicit Test Connection action; "" when never run. */
  connectionStatus: ConnectionTestStatus
}

defineProps<Props>()

// Two-way bound to the settings draft owned by ProviderSettings: this card
// holds no configuration state of its own.
const providerName = defineModel<string>("providerName", { required: true })
const baseUrl = defineModel<string>("baseUrl", { required: true })
const model = defineModel<string>("model", { required: true })
</script>

<template>
  <section
    class="connection-settings settings-card bg-slate-50/40 space-y-3"
    aria-labelledby="connection-settings-title"
  >
    <div class="flex items-center justify-between gap-2">
      <h3 id="connection-settings-title" class="settings-card-title">
        <AppIcon name="network" class="size-3.5 text-indigo-600" />
        <span>Connection Endpoint</span>
      </h3>
      <!-- Only ever rendered from a real Test Connection run. -->
      <span
        v-if="connectionStatus !== ''"
        class="rounded border px-1.5 py-0.5 text-[0.625rem] font-medium"
        :class="{
          'border-amber-200 bg-amber-50 text-amber-800': connectionStatus === 'testing',
          'border-emerald-200 bg-emerald-50 text-emerald-700': connectionStatus === 'success',
          'border-red-200 bg-red-50 text-red-700': connectionStatus === 'error',
        }"
      >
        {{
          connectionStatus === "testing"
            ? "Testing…"
            : connectionStatus === "success"
              ? "Connected"
              : "Failed"
        }}
      </span>
    </div>

    <div class="space-y-1">
      <label for="provider-name" class="field-label">Provider Name</label>
      <input
        id="provider-name"
        v-model="providerName"
        type="text"
        placeholder="e.g. llama.cpp"
        class="field-input focus-ring placeholder:font-sans placeholder:text-slate-400"
      />
    </div>

    <div class="space-y-1">
      <label for="base-url" class="field-label">Base URL</label>
      <input
        id="base-url"
        v-model="baseUrl"
        type="url"
        spellcheck="false"
        placeholder="http://localhost:8080/v1"
        class="field-input focus-ring placeholder:font-sans placeholder:text-slate-400"
      />
    </div>

    <div
      v-if="insecureBaseUrl"
      class="provider-insecure-warning flex items-start gap-2 rounded-lg border border-amber-200/80 bg-amber-50/70 p-2.5 text-[0.6875rem] leading-snug text-amber-900"
    >
      <AppIcon name="shield-alert" class="mt-0.5 size-4 shrink-0 text-amber-600" />
      <span>
        The provider URL is HTTP to a remote host; the API key and messages are
        sent unencrypted. Use HTTPS, or point this at a local server.
      </span>
    </div>

    <div class="space-y-1">
      <label for="model" class="field-label">Model</label>
      <input
        id="model"
        v-model="model"
        type="text"
        spellcheck="false"
        placeholder="local-model"
        class="field-input focus-ring placeholder:font-sans placeholder:text-slate-400"
      />
    </div>
  </section>
</template>
