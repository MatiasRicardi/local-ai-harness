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
  <div id="app" class="flex min-h-dvh flex-col bg-white text-neutral-900 lg:h-dvh lg:overflow-hidden">
    <header
      class="flex shrink-0 items-center justify-between gap-3 border-b border-neutral-200 bg-neutral-50 px-4 py-3 lg:px-6"
    >
      <h1 class="text-base font-semibold tracking-tight text-neutral-900">Local AI Harness</h1>
      <button
        type="button"
        class="header-new-conversation focus-ring inline-flex shrink-0 items-center rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 transition-colors hover:border-sky-500 hover:text-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
        aria-label="Start a new conversation"
        @click="handleReset"
      >
        New conversation
      </button>
    </header>
    <main class="flex min-h-0 flex-1 flex-col lg:flex-row lg:overflow-hidden">
      <aside
        class="shrink-0 border-b border-neutral-200 bg-neutral-50 p-4 lg:w-80 lg:min-h-0 lg:overflow-y-auto lg:border-b-0 lg:border-r"
      >
        <ProviderSettings />
      </aside>
      <section class="flex min-w-0 flex-1 flex-col lg:min-h-0 lg:overflow-hidden">
        <div class="chat-inner mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 lg:min-h-0 lg:px-6">
          <div class="flex min-h-0 flex-1 flex-col gap-3 pb-4 pt-4 lg:overflow-y-auto">
            <ChatMessages
              :messages="messages"
              :loading="loading"
              :error="chatError"
              :stopped="stopped"
            />
            <div
              v-if="documentContextWarning"
              class="document-context-warning flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700"
            >
              <svg
                class="size-3.5 shrink-0"
                viewBox="0 0 20 20"
                fill="currentColor"
                aria-hidden="true"
              >
                <path
                  fill-rule="evenodd"
                  d="M8.485 2.495c.673-1.167 2.39-1.167 3.064 0l6.28 10.875c.673 1.167-.17 2.625-1.534 2.625H3.74c-1.364 0-2.207-1.458-1.534-2.625L8.485 2.495ZM10 6a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 6Zm0 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
                  clip-rule="evenodd"
                />
              </svg>
              <span>{{ documentContextWarning }}</span>
            </div>
            <div ref="messagesEnd" />
          </div>
          <div class="composer-container flex shrink-0 flex-col gap-3 border-t border-neutral-200 py-3">
            <div
              v-if="attachmentError"
              class="attachment-error flex flex-col gap-0.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-700"
              role="alert"
            >
              <span class="attachment-error-message text-sm font-medium">{{ attachmentError.message }}</span>
              <span
                v-if="attachmentError.detail"
                class="attachment-error-detail text-xs text-red-600"
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
