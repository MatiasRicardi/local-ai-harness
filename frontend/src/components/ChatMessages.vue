<script setup lang="ts">
import { computed } from "vue"
import type { Message } from "../types"
import type { FrontendApiError } from "../types/error"
import { renderMarkdown } from "../utils/markdown"

interface Props {
  messages: Message[]
  loading: boolean
  error: FrontendApiError | null
  stopped: boolean
}

const props = defineProps<Props>()

const hasMessages = computed(() => props.messages.length > 0)

function renderAssistantContent(content: string): string {
  return renderMarkdown(content)
}
</script>

<template>
  <div class="chat-messages flex flex-col gap-3">
    <div
      v-if="error"
      class="error flex flex-col gap-0.5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-red-700"
      role="alert"
    >
      <p class="m-0 text-sm font-medium">{{ error.message }}</p>
      <span v-if="error.detail" class="error-detail text-xs text-red-600">{{ error.detail }}</span>
    </div>

    <div v-if="!hasMessages" class="empty-state px-4 py-16 text-center">
      <h3 class="m-0 mb-1 text-sm font-semibold text-neutral-800">Start a conversation</h3>
      <p class="m-0 text-sm text-neutral-500">Send a message to your configured local model to get started.</p>
    </div>

    <div
      v-for="msg in messages"
      :key="msg.id"
      class="message w-full rounded-lg border p-4"
      :class="[
        msg.role === 'user'
          ? 'message-user border-sky-200 bg-sky-50'
          : 'message-assistant border-neutral-200 bg-white',
        msg.stopped ? 'message-stopped opacity-70' : '',
      ]"
    >
      <div class="message-content min-w-0 break-words">
        <div class="message-role mb-1.5 text-[0.7rem] font-medium uppercase tracking-wider text-neutral-500">
          {{ msg.role }}
        </div>
        <!-- eslint-disable-next-line vue/no-v-html -->
        <div v-if="msg.role === 'assistant'" class="message-text markdown-content text-base leading-relaxed text-neutral-800" v-html="renderAssistantContent(msg.content)"></div>
        <div v-else class="message-text text-base leading-relaxed break-words whitespace-pre-wrap text-neutral-900">{{ msg.content }}</div>
        <div v-if="msg.stopped" class="message-stopped-indicator mt-2 text-xs italic text-red-600">
          <span>Stopped</span>
        </div>
      </div>
    </div>

    <div v-if="loading" class="loading flex items-center gap-2 text-sm italic text-neutral-500">
      <span class="size-1.5 shrink-0 animate-pulse rounded-full bg-sky-500" aria-hidden="true"></span>
      <span>Generating...</span>
    </div>

    <div v-if="stopped" class="stopped flex items-center gap-2 text-sm italic text-red-600">
      <span>Generation stopped</span>
    </div>
  </div>
</template>
