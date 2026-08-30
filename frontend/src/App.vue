<script setup lang="ts">
import { ref } from "vue"
import { streamChat, type ChatMessage, type ChatProviderConfig, type StreamCallbacks } from "./services/chat"
import { useProviderSettings } from "./composables/useProviderSettings"
import ProviderSettings from "./components/ProviderSettings.vue"
import ChatMessages from "./components/ChatMessages.vue"
import DocumentAttachment from "./components/DocumentAttachment.vue"
import ChatInput from "./components/ChatInput.vue"
import type { Message } from "./types"
import type { AttachedDocument } from "./services/files"

const messages = ref<Message[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const sending = ref(false)
const stopped = ref(false)
const attachedDocument = ref<AttachedDocument | null>(null)
const messagesEnd = ref<HTMLElement>()
const abortController = ref<AbortController | null>(null)

const providerSettings = useProviderSettings()

function scrollToBottom(behavior: ScrollBehavior = "auto") {
  messagesEnd.value?.scrollIntoView({ behavior })
}

function cleanup() {
  abortController.value = null
  sending.value = false
  loading.value = false
  stopped.value = false
}

function handleStop() {
  if (!abortController.value || !loading.value) return
  abortController.value.abort()
  stopped.value = true

  // Mark the last assistant message as stopped
  const lastMsg = messages.value[messages.value.length - 1]
  if (lastMsg && lastMsg.role === "assistant") {
    lastMsg.stopped = true
  }
}

function handleAttach(doc: AttachedDocument) {
  attachedDocument.value = doc
}

function handleRemove() {
  attachedDocument.value = null
}

function handleUploadError(message: string) {
  error.value = message
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9)
}

async function handleSend(text: string) {
  if (sending.value) return
  if (!text.trim()) return

  const userMessage: ChatMessage = {
    role: "user",
    content: text.trim(),
  }

  stopped.value = false

  const allMessages = [...messages.value, userMessage].filter(
    (m) => m.content.trim().length > 0,
  )

  messages.value.push({
    id: generateId(),
    role: "user",
    content: userMessage.content,
  })
  loading.value = true
  error.value = null
  scrollToBottom("auto")

  abortController.value = new AbortController()

  sending.value = true

  let assistantMessageId: string | null = null

  const provider: ChatProviderConfig = {
    baseUrl: providerSettings.value.baseUrl,
    model: providerSettings.value.model,
    apiKey: providerSettings.value.apiKey || undefined,
    timeoutMs: providerSettings.value.timeout * 1000,
  }

  const callbacks: StreamCallbacks = {
    onStart: () => {
      // Insert empty assistant message when generation starts
      assistantMessageId = generateId()
      messages.value.push({
        id: assistantMessageId,
        role: "assistant",
        content: "",
      })
      scrollToBottom("auto")
    },
    onDelta: (text: string) => {
      // Append delta to the current assistant message
      if (assistantMessageId !== null) {
        const msg = messages.value.find((m) => m.id === assistantMessageId)
        if (msg) {
          msg.content += text
          scrollToBottom("auto")
        }
      }
    },
    onDone: () => {
      assistantMessageId = null
      cleanup()
      scrollToBottom("smooth")
    },
    onStopped: () => {
      assistantMessageId = null
      cleanup()
      scrollToBottom("auto")
    },
    onError: (message: string) => {
      assistantMessageId = null
      error.value = message
      cleanup()
      scrollToBottom("auto")
    },
  }

  try {
    const signal = abortController.value?.signal
    await streamChat(allMessages, provider, callbacks, { signal })
  } catch (err) {
    // AbortError: onStopped or cleanup already handles state reset
    if (err instanceof DOMException && err.name === "AbortError") {
      cleanup()
      return
    }
    error.value = err instanceof Error ? err.message : "Error sending message."
    cleanup()
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
        <div class="chat-inner">
          <ChatMessages :messages="messages" :loading="loading" :error="error" :stopped="stopped" />
          <div ref="messagesEnd" />
          <DocumentAttachment
            :attached-document="attachedDocument"
            @attach="handleAttach"
            @remove="handleRemove"
            @error="handleUploadError"
          />
          <ChatInput
            :on-send="handleSend"
            :text-placeholder="'Type your message... (Enter to send)'"
            :sending="sending"
            @stop="handleStop"
          />
        </div>
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

.connection-panel {
  flex: 1;
  padding: 24px;
  background: var(--bg-secondary);
  border-right: 1px solid var(--border);
  overflow-y: auto;
}

.chat-panel {
  flex: 1;
  background: var(--bg);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

.chat-inner {
  display: flex;
  flex-direction: column;
  flex: 1;
  max-width: 860px;
  width: 100%;
  margin: 0 auto;
  padding: 0 16px;
  gap: 16px;
}
</style>
