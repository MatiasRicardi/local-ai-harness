<script setup lang="ts">
import { ref, computed } from "vue"
import { streamChat, type ChatMessage, type ChatProviderConfig, type StreamCallbacks } from "./services/chat"
import { useProviderSettings } from "./composables/useProviderSettings"
import ProviderSettings from "./components/ProviderSettings.vue"
import ChatMessages from "./components/ChatMessages.vue"
import DocumentAttachment from "./components/DocumentAttachment.vue"
import ChatInput from "./components/ChatInput.vue"
import type { Message } from "./types"
import type { AttachedDocument } from "./services/files"
import { FrontendApiError, type AppErrorArea } from "./types/error"

const messages = ref<Message[]>([])
const loading = ref(false)
// Area-keyed error record so a chat failure and an attachment failure are
// stored independently and never overwrite each other.
const errors = ref<Record<AppErrorArea, FrontendApiError | null>>({
  chat: null,
  attachment: null,
})
const sending = ref(false)
const stopped = ref(false)
const attachedDocument = ref<AttachedDocument | null>(null)
const uploadingDocument = ref(false)
const messagesEnd = ref<HTMLElement>()
const abortController = ref<AbortController | null>(null)
const documentContextWarning = ref<string | null>(null)

// Contextual error split by area, so an error is shown once, near the
// operation that produced it (chat/composer vs attachment/composer).
const chatError = computed<FrontendApiError | null>(() => errors.value.chat)
const attachmentError = computed<FrontendApiError | null>(() => errors.value.attachment)

// Generation identity used to ignore stale SSE callbacks after a reset.
let generationId = 0
// Monotonic keys passed to child components so they can clear their local
// state (composer draft / pending attachment upload) on a reset.
const chatInputResetKey = ref(0)
const attachmentResetVersion = ref(0)

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

function hasMeaningfulConversation(): boolean {
  return messages.value.some((m) => m.content.trim().length > 0)
}

function normalizeBusyState() {
  sending.value = false
  loading.value = false
  stopped.value = false
}

function handleReset() {
  // 1. Ask for confirmation only when a real conversation exists.
  if (hasMeaningfulConversation()) {
    // 2. Cancelled confirmation changes nothing (generation keeps running).
    if (!window.confirm("Start a new conversation? The current chat and attached document will be cleared.")) {
      return
    }
  }

  // 3. Abort active generation using the existing cancellation path.
  if (abortController.value && loading.value) {
    abortController.value.abort()
  }

  // 4. Invalidate the current generation before clearing state, so any
  //    already-buffered/late SSE callback cannot repopulate the conversation.
  generationId++

  // 5. Invalidate any pending attachment upload result.
  attachmentResetVersion.value++

  // 6. Clear the AbortController reference.
  abortController.value = null

  // 7. Clear conversation state.
  messages.value = []

  // 8. Remove the attached document so the new conversation starts clean.
  attachedDocument.value = null

  // 9. Clear the document-context (truncation) warning.
  documentContextWarning.value = null

  // 10. Clear transient chat/stream/upload errors.
  errors.value = { chat: null, attachment: null }
  uploadingDocument.value = false

  // 11. Normalize busy state back to idle.
  normalizeBusyState()

  // 12. Clear the unsent composer draft.
  chatInputResetKey.value++
}

function handleAttach(doc: AttachedDocument) {
  attachedDocument.value = doc
}

function handleRemove() {
  attachedDocument.value = null
}

function clearErrorForArea(area: AppErrorArea) {
  errors.value[area] = null
}

function handleUploadError(uploadError: FrontendApiError) {
  // Only the attachment area is touched, so an existing chat error is kept.
  errors.value.attachment = uploadError
}

function handleUploadAttempt() {
  // A new attachment attempt clears a previous attachment error.
  clearErrorForArea("attachment")
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

  // New generation identity; stale callbacks after a reset are ignored.
  const currentGenerationId = ++generationId

  const allMessages = [...messages.value, userMessage].filter(
    (m) => m.content.trim().length > 0,
  )

  messages.value.push({
    id: generateId(),
    role: "user",
    content: userMessage.content,
  })
  loading.value = true
  // A new chat send clears a previous chat error.
  clearErrorForArea("chat")
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
      // Ignore callbacks from a previous generation (reset/cancel happened).
      if (currentGenerationId !== generationId) return

      // Insert empty assistant message when generation starts
      assistantMessageId = generateId()
      messages.value.push({
        id: assistantMessageId,
        role: "assistant",
        content: "",
      })

      // Show warning if document was truncated
      if (context?.documentTruncated) {
        const originalChars = context.originalDocumentCharacters.toLocaleString()
        const includedChars = context.includedDocumentCharacters.toLocaleString()
        documentContextWarning.value = `Document was truncated: ${includedChars} characters of ${originalChars} included due to context limit.`
      } else {
        documentContextWarning.value = null
      }

      scrollToBottom("auto")
    },
    onDelta: (text: string) => {
      // Ignore callbacks from a previous generation (reset/cancel happened).
      if (currentGenerationId !== generationId) return

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
      // Ignore callbacks from a previous generation (reset/cancel happened).
      if (currentGenerationId !== generationId) return

      assistantMessageId = null
      documentContextWarning.value = null
      cleanup()
      scrollToBottom("smooth")
    },
    onStopped: () => {
      // Ignore callbacks from a previous generation (reset/cancel happened).
      if (currentGenerationId !== generationId) return

      assistantMessageId = null
      documentContextWarning.value = null
      cleanup()
      scrollToBottom("auto")
    },
    onError: (chatError: FrontendApiError) => {
      // Ignore callbacks from a previous generation (reset/cancel happened).
      if (currentGenerationId !== generationId) return

      assistantMessageId = null
      documentContextWarning.value = null
      errors.value.chat = chatError
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
    const chatError =
      err instanceof FrontendApiError
        ? err
        : new FrontendApiError({ code: "UNKNOWN_ERROR", message: "Something went wrong. Please try again." })
    errors.value.chat = chatError
    cleanup()
  }
}
</script>

<template>
  <div id="app">
    <header class="header">
      <h1 class="header-title">Local AI Harness</h1>
      <button
        type="button"
        class="header-new-conversation"
        aria-label="Start a new conversation"
        @click="handleReset"
      >
        New conversation
      </button>
    </header>
    <main class="main">
      <ProviderSettings />
      <section class="chat-panel">
        <div class="chat-inner">
          <ChatMessages
            :messages="messages"
            :loading="loading"
            :error="chatError"
            :stopped="stopped"
          />
          <div v-if="documentContextWarning" class="document-context-warning">
            <span class="warning-icon">⚠️</span>
            {{ documentContextWarning }}
          </div>
          <div ref="messagesEnd" />
          <div class="composer-container">
            <div v-if="attachmentError" class="attachment-error" role="alert">
              <span class="attachment-error-message">{{ attachmentError.message }}</span>
              <span
                v-if="attachmentError.detail"
                class="attachment-error-detail"
              >{{ attachmentError.detail }}</span>
            </div>
            <DocumentAttachment
              :attached-document="attachedDocument"
              :uploading="uploadingDocument"
              :reset-version="attachmentResetVersion"
              @attempt="handleUploadAttempt"
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
              :reset-key="chatInputResetKey"
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
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.header-title {
  margin: 0;
  font-size: 20px;
  color: var(--text-h);
}

.header-new-conversation {
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text-secondary);
  font-size: 0.8rem;
  font-family: inherit;
  cursor: pointer;
  transition: border-color 0.2s, color 0.2s;
}

.header-new-conversation:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--text);
}

.header-new-conversation:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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

.attachment-error {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--error, #ef4444);
  border-radius: 6px;
  color: var(--text, #b91c1c);
  font-size: 13px;
}

.attachment-error-message {
  font-weight: 600;
}

.attachment-error-detail {
  font-size: 12px;
  opacity: 0.8;
}

.warning-icon {
  font-size: 16px;
}
</style>
