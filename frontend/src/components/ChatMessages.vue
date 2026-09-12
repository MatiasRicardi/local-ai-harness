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
// Neutral label: Message data does not store which model generated each
// response, so deriving it from the live model name would relabel historical
// answers whenever the provider model changes. Use a stable "Assistant" label.
const assistantLabel = computed(() => "Assistant")

function renderAssistantContent(content: string): string {
  return renderMarkdown(content)
}
</script>

<template>
  <div class="chat-messages flex flex-col gap-5">
    <div
      v-if="error"
      class="error flex items-start gap-2.5 rounded-xl border border-red-200/80 bg-red-50/80 p-3 text-red-700"
      role="alert"
    >
      <span
        class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-500/10 text-red-600"
        aria-hidden="true"
      >
        <svg class="size-3" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round">
          <path d="M10 4.5v6.5" />
          <path d="M10 14.4h.01" />
        </svg>
      </span>
      <div class="min-w-0">
        <p class="m-0 text-xs font-medium text-red-800">{{ error.message }}</p>
        <span v-if="error.detail" class="error-detail mt-0.5 block text-[0.6875rem] break-words text-red-600">{{ error.detail }}</span>
      </div>
    </div>

    <div
      v-if="!hasMessages"
      class="empty-state rounded-2xl border border-dashed border-stone-200 bg-white/70 px-4 py-16 text-center"
    >
      <h3 class="m-0 mb-1 text-sm font-semibold text-stone-900">Start a conversation</h3>
      <p class="m-0 text-sm text-stone-500">Send a message to your configured local model to get started.</p>
    </div>

    <article
      v-for="msg in messages"
      :key="msg.id"
      class="message flex w-full items-start gap-3.5"
      :class="[
        msg.role === 'user' ? 'message-user' : 'message-assistant',
        msg.stopped ? 'message-stopped' : '',
      ]"
    >
      <div
        class="message-avatar flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
        :class="
          msg.role === 'user'
            ? 'bg-stone-200 text-stone-600 shadow-inner'
            : 'bg-gradient-to-tr from-sky-500 to-indigo-600 text-white shadow-sm shadow-sky-500/20 ring-2 ring-white'
        "
      >
        <svg
          v-if="msg.role === 'user'"
          class="size-4"
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
        >
          <circle cx="10" cy="6.6" r="3.4" />
          <path d="M3.6 17.4a6.4 6.4 0 0 1 12.8 0z" />
        </svg>
        <svg
          v-else
          class="size-4"
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M13 1.8 3.8 11.4h4.6l-1.4 6.8L14.8 8.6h-4.4L13 1.8z" />
        </svg>
      </div>
      <div class="message-content min-w-0 flex-1">
        <div class="message-role mb-1 flex flex-wrap items-center gap-2">
          <span class="text-xs font-semibold text-stone-900">
            {{ msg.role === 'user' ? "You" : assistantLabel }}
          </span>
        </div>
        <!-- eslint-disable vue/no-v-html --><!-- content is sanitized via DOMPurify in renderMarkdown() -->
        <div
          v-if="msg.role === 'assistant'"
          class="message-text markdown-content break-words rounded-2xl rounded-tl-sm border border-stone-200 bg-white p-4 text-sm leading-relaxed text-stone-800 shadow-sm"
          v-html="renderAssistantContent(msg.content)"
        ></div>
        <!-- eslint-enable vue/no-v-html -->
        <!-- Kept on one line: the bubble preserves newlines, so it must not pick up template whitespace. -->
        <div v-else class="message-text inline-block max-w-2xl break-words whitespace-pre-wrap rounded-2xl rounded-tl-sm border border-stone-200/60 bg-stone-100/90 p-4 text-sm leading-relaxed text-stone-800">{{ msg.content }}</div>
        <div
          v-if="msg.stopped"
          class="message-stopped-indicator mt-1.5 flex items-center gap-1.5 text-[0.6875rem] font-medium italic text-red-600"
        >
          <span>Stopped</span>
        </div>
      </div>
    </article>

    <div v-if="loading" class="loading flex items-center gap-2.5 text-xs italic text-stone-400">
      <span class="flex shrink-0 items-center gap-1" aria-hidden="true">
        <span class="size-1.5 animate-pulse rounded-full bg-sky-400"></span>
        <span class="size-1.5 animate-pulse rounded-full bg-sky-500"></span>
        <span class="size-1.5 animate-pulse rounded-full bg-sky-600"></span>
      </span>
      <span>Generating...</span>
    </div>

    <div
      v-if="stopped"
      class="stopped flex items-center gap-2 rounded-xl border border-red-200/80 bg-red-50/80 px-3 py-2 text-xs font-medium italic text-red-600"
    >
      <span>Generation stopped</span>
    </div>
  </div>
</template>
