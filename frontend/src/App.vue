<script setup lang="ts">
import { ref } from "vue"
import { chat, type ChatMessage, type ChatResponse } from "./services/chat"
import ProviderSettings from "./components/ProviderSettings.vue"
import ChatMessages from "./components/ChatMessages.vue"
import type { Message } from "./types"
import { onMounted } from "vue"

const messages = ref<Message[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const sending = ref(false)
const messagesEnd = ref<HTMLElement | null>(null)

// Initialize refs from DOM after mount
onMounted(() => {
  const el = document.getElementById('messages-end')
  if (el) messagesEnd.value = el
})

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9)
}

function scrollToBottom() {
  messagesEnd.value?.scrollIntoView({ behavior: "smooth" })
}

async function handleSend(text: string) {
  if (sending.value) return
  if (!text.trim()) return

  const userMessage: ChatMessage = {
    role: "user",
    content: text.trim(),
  }

  const allMessages = [...messages.value, userMessage]

  messages.value.push({
    id: generateId(),
    role: "user",
    content: userMessage.content,
  })
  loading.value = true
  error.value = null
  scrollToBottom()

  sending.value = true

  try {
    const response: ChatResponse = await chat(allMessages)

    if (!response.success) {
      error.value = response.error || "Error al enviar el mensaje."
      return
    }

    if (response.message) {
      messages.value.push({
        id: generateId(),
        role: "assistant",
        content: response.message.content,
      })
    }

    if (response.model) {
      console.log(`Model used: ${response.model}`)
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : "Error al enviar el mensaje."
  } finally {
    loading.value = false
    sending.value = false
    scrollToBottom()
  }
}
</script>

<template>
  <div id="app">
    <header class="header">
      <h1>Local AI Harness</h1>
    </header>
    <main class="main">
      <ProviderSettings />
      <section class="chat-panel">
        <div id="messages-end">
          <ChatMessages :messages="messages" :loading="loading" :error="error" />
        </div>
        <ChatInput @send="handleSend" :text-placeholder="'Escribe tu mensaje... (Enter para enviar)'" />
      </section>
    </main>
  </div>
</template>

<style scoped>
#app {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

.header {
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
  padding: 16px 24px;
}

.header h1 {
  margin: 0;
  font-size: 20px;
  color: var(--text-h);
}

.main {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.connection-panel,
.chat-panel {
  flex: 1;
  padding: 24px;
  overflow-y: auto;
}

.connection-panel {
  border-right: 1px solid var(--border);
  background: var(--bg-secondary);
}

.chat-panel {
  background: var(--bg);
  display: flex;
  flex-direction: column;
}
</style>
