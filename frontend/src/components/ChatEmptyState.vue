<script setup lang="ts">
import AppIcon from "./AppIcon.vue"

interface Props {
  /** Configured model id, shown as-is; empty until the settings form has one. */
  model: string
  /** Configured context window, already localised (e.g. "32,768"). */
  contextLabel: string
  /** Real Tavily state, so the copy never claims search that is turned off. */
  webSearchEnabled: boolean
}

defineProps<Props>()
</script>

<template>
  <div class="chat-empty-state empty-state mx-auto flex w-full max-w-2xl flex-col items-center py-10 text-center md:py-16">
    <div
      class="flex size-14 items-center justify-center rounded-2xl border border-indigo-100 bg-white text-indigo-600 shadow-floating"
      aria-hidden="true"
    >
      <AppIcon name="sparkles" class="size-6" />
    </div>

    <h2 class="m-0 mt-5 text-lg font-semibold tracking-tight text-slate-900">
      Start a new conversation
    </h2>
    <p class="m-0 mt-1.5 max-w-md text-sm leading-relaxed text-slate-500">
      <template v-if="model">
        Prompts are sent to
        <span class="font-mono text-[0.8125rem] font-medium text-slate-700">{{ model }}</span>
        <template v-if="contextLabel">
          ({{ contextLabel }} token window
          <template v-if="webSearchEnabled">, web search on</template>
          ).
        </template>
      </template>
      <template v-else>
        Configure an endpoint in Model Settings, then send the first message.
      </template>
    </p>

    <p class="m-0 mt-2 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[0.6875rem] text-slate-400">
      <span class="inline-flex items-center gap-1">
        <AppIcon name="paperclip" class="size-3.5" />
        Attach a .txt, .md or .pdf file to use it as context.
      </span>
      <span class="hidden sm:inline" aria-hidden="true">&middot;</span>
      <span class="inline-flex items-center gap-1">
        <AppIcon name="globe" class="size-3.5" />
        Web search is {{ webSearchEnabled ? "on" : "off" }}.
      </span>
    </p>
  </div>
</template>
