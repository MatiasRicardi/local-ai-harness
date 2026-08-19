<script setup lang="ts">
import { ref } from "vue"

interface Props {
  onSend: (text: string) => void
  textPlaceholder?: string
  sending?: boolean
}

const props = defineProps<Props>()

const emit = defineEmits<{
  stop: []
}>()
const text = ref("")

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
  <div class="chat-input">
    <textarea
      v-model="text"
      :placeholder="textPlaceholder"
      :disabled="sending"
      @keydown.ctrl.enter="handleSend"
      @keydown.meta.enter="handleSend"
      @keydown.enter="handleEnter"
      rows="3"
      class="chat-input-textarea"
    />
    <button
      v-if="!sending"
      type="button"
      class="chat-input-btn chat-input-send"
      :disabled="sending"
      @click="handleSend"
    >
      Send
    </button>
    <button
      v-else
      type="button"
      class="chat-input-btn chat-input-stop"
      @click="emit('stop')"
    >
      Stop
    </button>
  </div>
</template>

<style scoped>
.chat-input {
  display: flex;
  gap: 10px;
  margin-top: auto;
  padding-top: 12px;
  align-items: flex-end;
}

.chat-input-textarea {
  flex: 1;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg);
  color: var(--text);
  font-family: inherit;
  font-size: 0.95rem;
  line-height: 1.5;
  resize: vertical;
  min-height: 56px;
  max-height: 200px;
  outline: none;
  transition: border-color 0.2s;
}

.chat-input-textarea:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(74, 144, 217, 0.15);
}

.chat-input-textarea:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.chat-input-btn {
  padding: 12px 22px;
  border: none;
  border-radius: 10px;
  font-family: inherit;
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: opacity 0.2s;
  flex-shrink: 0;
}

.chat-input-btn:hover {
  opacity: 0.85;
}

.chat-input-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.chat-input-send {
  background: var(--accent);
  color: var(--bg);
}

.chat-input-stop {
  background: #ef4444;
  color: white;
}
</style>
