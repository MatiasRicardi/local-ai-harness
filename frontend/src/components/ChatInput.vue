<script setup lang="ts">
import { ref } from "vue"

interface Props {
  onSend: (text: string) => void
  textPlaceholder?: string
}

const props = defineProps<Props>()
const text = ref("")

function handleSend() {
  if (text.value.trim()) {
    props.onSend(text.value.trim())
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
      @keydown.ctrl.enter="handleSend"
      @keydown.meta.enter="handleSend"
      @keydown.enter="handleEnter"
      rows="3"
      class="chat-input-textarea"
    />
    <button
      type="button"
      class="chat-input-send"
      @click="handleSend"
    >
      Send
    </button>
  </div>
</template>

<style scoped>
.chat-input {
  display: flex;
  gap: 8px;
  margin-top: auto;
}

.chat-input-textarea {
  flex: 1;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: var(--text);
  font-family: inherit;
  resize: vertical;
  min-height: 60px;
  max-height: 200px;
  outline: none;
  transition: border-color 0.2s;
}

.chat-input-textarea:focus {
  border-color: var(--accent);
}

.chat-input-send {
  padding: 10px 20px;
  background: var(--accent);
  color: var(--bg);
  border: none;
  border-radius: 8px;
  font-family: inherit;
  font-size: 0.9rem;
  cursor: pointer;
  white-space: nowrap;
  transition: opacity 0.2s;
}

.chat-input-send:hover {
  opacity: 0.85;
}

.chat-input-send:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
