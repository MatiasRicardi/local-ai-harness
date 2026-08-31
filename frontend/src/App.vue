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
const uploadingDocument = ref(false)
const messagesEnd = ref<HTMLElement>()
const abortController = ref<AbortController | null>(null)
const documentContextWarning = ref<string | null>(null)

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

function handleUploadStart() {
  uploadingDocument.value = true
}

function handleUploadEnd() {
  uploadingDocument.value = false
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
    onStart: (_model, context) => {
      // Insert empty assistant message when generation starts
      assistantMessageId = generateId()
      messages.value.push({
        id: assistantMessageId,
        role: "assistant",
        content: "",
      })

      // Show warning if document was truncated
      if (context?.documentTruncated) {
        const originalMB = (context.originalDocumentCharacters / 1024).toFixed(1)
        const includedMB = (context.includedDocumentCharacters / 1024).toFixed(1)
        documentContextWarning.value = `Document was truncated: ${includedMB}KB of ${originalMB}KB included due to context limit.`
      } else {
        documentContextWarning.value = null
      }

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
      documentContextWarning.value = null
      cleanup()
      scrollToBottom("smooth")
    },
    onStopped: () => {
      assistantMessageId = null
      documentContextWarning.value = null
      cleanup()
      scrollToBottom("auto")
    },
    onError: (message: string) => {
      assistantMessageId = null
      documentContextWarning.value = null
      error.value = message
      cleanup()
      scrollToBottom("auto")
    },
  }

  try {
    const signal = abortController.value?.signal
    const document = attachedDocument.value
      ? {
          fileId: attachedDocument.value.fileId,
          filename: attachedDocument.value.originalFilename,
          text: attachedDocument.value.text,
        }
      : undefined
    const context = {
      maxTokens: providerSettings.value.contextSizeTokens,
    }
    await streamChat(allMessages, provider, callbacks, { signal, document, context })
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
          <div v-if="documentContextWarning" class="document-context-warning">
            <span class="warning-icon">⚠️</span>
            {{ documentContextWarning }}
          </div>
          <div ref="messagesEnd" />
          <div class="composer-container">
            <DocumentAttachment
              :attached-document="attachedDocument"
              :uploading="uploadingDocument"
              @attach="handleAttach"
              @remove="handleRemove"
              @error="handleUploadError"
              @upload:start="handleUploadStart"
              @upload:end="handleUploadEnd"
            />
            <ChatInput
              :on-send="handleSend"
              :sending="sending"
              :has-document="!!attachedDocument"
              @stop="handleStop"
            />
          </div>
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

.composer-container {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 12px;
  margin-top: auto;
}

.document-context-warning {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 13px;
}

.warning-icon {
  font-size: 16px;
}
</style>
