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
  <div class="chat-input flex items-end gap-2">
    <textarea
      v-model="text"
      :placeholder="computedPlaceholder"
      :disabled="sending"
      @keydown.ctrl.enter="handleSend"
      @keydown.meta.enter="handleSend"
      @keydown.enter="handleEnter"
      rows="3"
      class="chat-input-textarea focus-ring max-h-52 min-h-14 flex-1 resize-y rounded-lg border border-neutral-300 bg-white px-3 py-2.5 text-base leading-relaxed text-neutral-900 placeholder:text-neutral-400 disabled:cursor-not-allowed disabled:opacity-60"
    />
    <button
      v-if="!sending"
      type="button"
      class="chat-input-btn chat-input-send focus-ring inline-flex shrink-0 items-center rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
      :disabled="sending"
      @click="handleSend"
    >
      Send
    </button>
    <button
      v-else
      type="button"
      class="chat-input-btn chat-input-stop focus-ring inline-flex shrink-0 items-center rounded-lg border border-red-200 bg-white px-4 py-2.5 text-sm font-semibold text-red-600 transition-colors hover:border-red-300 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
      @click="emit('stop')"
    >
      Stop
    </button>
  </div>
</template>
