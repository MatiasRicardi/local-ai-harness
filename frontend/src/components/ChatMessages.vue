<script setup lang="ts">
import type { Message } from "../types"

interface Props {
  messages: Message[]
  loading: boolean
  error: string | null
  stopped: boolean
}

defineProps<Props>()
</script>

<template>
  <div class="chat-messages">
    <div v-if="error" class="error">
      <p>{{ error }}</p>
    </div>

    <div v-for="msg in messages" :key="msg.id" class="message" :class="['message-' + msg.role, { 'message-stopped': msg.stopped }]">
      <div class="message-content">
        <div class="message-role">{{ msg.role }}</div>
        <div class="message-text">{{ msg.content }}</div>
        <div v-if="msg.stopped" class="message-stopped-indicator">
          <span>Detenido</span>
        </div>
      </div>
    </div>

    <div v-if="loading" class="loading">
      <span>Generando...</span>
    </div>

    <div v-if="stopped" class="stopped">
      <span>Generación detenida</span>
    </div>
  </div>
</template>

<style scoped>
.chat-messages {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.loading {
  font-style: italic;
  color: var(--text);
  opacity: 0.7;
  padding: 8px 0;
}

.stopped {
  font-style: italic;
  color: #ef4444;
  opacity: 0.8;
  padding: 8px 0;
}

.error {
  padding: 12px 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
}

.error p {
  margin: 0;
  font-size: 0.9rem;
}

.message {
  padding: 12px 16px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg-secondary);
}

.message-role {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text);
  opacity: 0.6;
  margin-bottom: 4px;
}

.message-content {
  word-wrap: break-word;
}

.message-text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.5;
}

.message-user {
  background: var(--accent-bg);
  border-color: var(--accent-border);
}

.message-assistant {
  background: var(--code-bg);
}

.message-stopped {
  opacity: 0.7;
}

.message-stopped-indicator {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
  font-size: 0.8rem;
  color: #ef4444;
  font-style: italic;
}
</style>
