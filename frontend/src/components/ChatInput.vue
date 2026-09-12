<script setup lang="ts">
import { computed, ref, watch } from "vue"

interface Props {
  onSend: (text: string) => void
  textPlaceholder?: string
  sending?: boolean
  hasDocument?: boolean
  resetKey?: number
}

const props = defineProps<Props>()

const computedPlaceholder = computed(() => {
  if (props.textPlaceholder !== undefined) {
    return props.textPlaceholder
  }
  return props.hasDocument
    ? "Ask a question about the attached document..."
    : "Type your message..."
})

const emit = defineEmits<{
  stop: []
}>()
const text = ref("")

// Clear the local draft when the parent requests a conversation reset.
watch(
  () => props.resetKey,
  () => {
    text.value = ""
  },
)

function handleSend() {
  if (text.value.trim()) {
    props.onSend(text.value.trim())
    text.value = ""
  }
}

function handleEnter(event: KeyboardEvent) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault()
    handleSend()
  }
}
</script>

<template>
  <!-- The composer card shell (border, shadow, focus ring) lives in App.vue, so the
       textarea is borderless and the whole card reads as a single input. The draft
       stays 16px on narrow screens to avoid the mobile browser zoom-on-focus. -->
  <div class="chat-input flex flex-col gap-1">
    <label for="chat-composer-input" class="sr-only">Message</label>
    <textarea
      id="chat-composer-input"
      v-model="text"
      :placeholder="computedPlaceholder"
      :disabled="sending"
      :aria-busy="sending ? 'true' : 'false'"
      @keydown.ctrl.enter="handleSend"
      @keydown.meta.enter="handleSend"
      @keydown.enter="handleEnter"
      rows="3"
      class="chat-input-textarea max-h-52 min-h-14 w-full flex-1 resize-none border-0 bg-transparent p-1.5 text-base leading-relaxed text-stone-800 placeholder:text-stone-400 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 md:text-sm"
    />
    <div class="chat-input-actions flex items-center justify-between gap-2 px-1.5 pb-1 pt-1">
      <span class="chat-input-hint hidden text-[0.625rem] text-stone-400 sm:block">
        <kbd
          class="rounded border border-stone-200 bg-stone-100 px-1.5 py-0.5 font-mono text-[0.625rem] text-stone-600"
        >Enter</kbd>
        to send
        <span class="mx-1 text-stone-300" aria-hidden="true">&middot;</span>
        <kbd
          class="rounded border border-stone-200 bg-stone-100 px-1.5 py-0.5 font-mono text-[0.625rem] text-stone-600"
        >Shift + Enter</kbd>
        for new line
      </span>
      <div class="chat-input-buttons flex shrink-0 items-center gap-2">
        <button
          v-if="!sending"
          type="button"
          class="chat-input-btn chat-input-send inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-sky-600 px-4 py-2 text-xs font-medium text-white shadow-sm shadow-sky-500/20 transition-all duration-150 hover:bg-sky-700 active:scale-[0.98] focus-ring disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="sending"
          @click="handleSend"
        >
          <span>Send</span>
          <svg
            class="size-3.5 shrink-0"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M17.5 10 2.5 3.2l1.9 6.8-1.9 6.8L17.5 10Z" />
          </svg>
        </button>
        <button
          v-else
          type="button"
          class="chat-input-btn chat-input-stop inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-red-600 px-4 py-2 text-xs font-medium text-white shadow-sm shadow-red-500/20 transition-colors duration-150 hover:bg-red-700 focus-ring disabled:cursor-not-allowed disabled:opacity-50"
          @click="emit('stop')"
        >
          <span>Stop</span>
          <svg
            class="size-3 shrink-0"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <rect x="5" y="5" width="10" height="10" rx="1.5" />
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>
