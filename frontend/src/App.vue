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

// Presentation-only summaries. They describe what the user configured, never a
// live connection state (that stays inside ProviderSettings' Test Connection).
const configuredModel = computed(() => providerSettings.value.model.trim())

const endpointSummary = computed(() => {
  const { name, baseUrl } = providerSettings.value
  // Drop the scheme and any trailing slash: purely cosmetic, no inference.
  const host = baseUrl
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/\/+$/, "")
  return { name: name.trim(), host }
})

const configuredContext = computed(() => {
  const tokens = providerSettings.value.contextSizeTokens
  return Number.isFinite(tokens) ? tokens.toLocaleString() : ""
})

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
  <div id="app" class="flex min-h-dvh flex-col bg-white text-stone-800 lg:h-dvh lg:overflow-hidden">
    <!-- Full-width header: app identity, configured model, endpoint summary, reset. -->
    <header
      class="header flex h-14 shrink-0 items-center justify-between gap-3 border-b border-stone-200/80 bg-white/90 px-4 backdrop-blur-md md:px-5"
    >
      <div class="flex min-w-0 items-center gap-3">
        <div
          class="app-mark flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-tr from-sky-500 to-indigo-600 text-white shadow-sm shadow-sky-500/20"
        >
          <svg
            class="size-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.9"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <rect x="7" y="7" width="10" height="10" rx="2.5" />
            <path d="M10.5 10.5h3v3h-3z" fill="currentColor" stroke="none" />
            <path d="M9.5 4v3M12 4v3M14.5 4v3M9.5 17v3M12 17v3M14.5 17v3M4 9.5h3M4 12h3M4 14.5h3M17 9.5h3M17 12h3M17 14.5h3" />
          </svg>
        </div>
        <div class="flex min-w-0 items-center gap-2.5">
          <h1 class="truncate text-sm font-semibold tracking-tight text-stone-900">Local AI Harness</h1>
          <!-- Decorative separator: the badge is the configured model, not a status. -->
          <span v-if="configuredModel" class="text-stone-300" aria-hidden="true">/</span>
          <span
            v-if="configuredModel"
            class="model-badge hidden min-w-0 max-w-[16rem] items-center gap-1.5 rounded-full border border-stone-200 bg-stone-50 px-2 py-0.5 text-[0.6875rem] font-medium text-stone-700 sm:flex"
            :title="configuredModel"
          >
            <span class="size-1.5 shrink-0 rounded-full bg-sky-500" aria-hidden="true"></span>
            <span class="truncate font-mono">{{ configuredModel }}</span>
          </span>
        </div>
      </div>
      <div class="flex shrink-0 items-center gap-3">
        <div
          v-if="endpointSummary.host"
          class="endpoint-summary hidden min-w-0 items-center gap-1 rounded-md border border-stone-200/50 bg-stone-100/80 px-2.5 py-1 text-xs text-stone-400 lg:flex"
        >
          <template v-if="endpointSummary.name">
            <span class="max-w-[10rem] min-w-0 truncate font-mono text-[0.6875rem]">{{ endpointSummary.name }}</span>
            <span class="text-stone-300" aria-hidden="true">&bull;</span>
          </template>
          <span class="max-w-[14rem] min-w-0 truncate">{{ endpointSummary.host }}</span>
        </div>
        <button
          type="button"
          class="header-new-conversation focus-ring inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-3.5 py-1.5 text-xs font-medium text-stone-700 shadow-sm transition-colors duration-150 hover:bg-stone-50 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="Start a new conversation"
          @click="handleReset"
        >
          <svg
            class="size-3.5 shrink-0 text-stone-400"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M10 4.5v11M4.5 10h11" />
          </svg>
          <span>New conversation</span>
        </button>
      </div>
    </header>
    <main class="flex min-h-0 flex-1 flex-col lg:flex-row lg:overflow-hidden">
      <!-- Sidebar: stacks above the chat on narrow viewports, scrolls on its own on desktop. -->
      <aside
        class="sidebar shrink-0 border-b border-stone-200/75 bg-stone-50 lg:min-h-0 lg:w-88 lg:overflow-y-auto lg:border-b-0 lg:border-r"
      >
        <ProviderSettings />
      </aside>
      <section class="chat-area flex min-w-0 flex-1 flex-col bg-white lg:min-h-0 lg:overflow-hidden">
        <!-- Message stream: the only scrolling pane on desktop. -->
        <div class="chat-stream chat-dots min-h-0 flex-1 lg:overflow-y-auto">
          <div class="chat-inner mx-auto flex w-full max-w-4xl flex-col px-4 pb-6 pt-6 md:px-8">
            <ChatMessages
              :messages="messages"
              :loading="loading"
              :error="chatError"
              :stopped="stopped"
            />
            <div
              v-if="documentContextWarning"
              class="document-context-warning mt-4 flex items-start gap-2 rounded-xl border border-amber-200/80 bg-amber-50/80 px-3 py-2 text-xs text-amber-700"
            >
              <svg
                class="size-3.5 shrink-0"
                viewBox="0 0 20 20"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M10 3.5 18 17H2z" />
                <path d="M10 8.2v3.4" />
                <path d="M10 14h.01" />
              </svg>
              <span>{{ documentContextWarning }}</span>
            </div>
            <div ref="messagesEnd" />
          </div>
        </div>
        <!-- Composer dock: in normal document flow on narrow screens, pinned to the
             bottom of the workspace on desktop (the stream above scrolls alone). -->
        <div class="composer-dock shrink-0 border-t border-stone-200/70 bg-white px-4 py-4 md:px-6">
          <div
            class="composer-card mx-auto w-full max-w-3xl rounded-2xl border border-stone-200 bg-white p-2.5 shadow-lg shadow-stone-200/40 transition-all focus-within:border-sky-500 focus-within:ring-2 focus-within:ring-sky-100"
          >
            <div
              class="composer-toolbar flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-stone-100 px-1.5 pb-2"
            >
              <DocumentAttachment
                class="min-w-0 flex-1"
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
              <!-- Only the configured window is known: token usage is not reported. -->
              <div
                v-if="configuredContext"
                class="composer-context flex shrink-0 items-center gap-1 font-mono text-[0.6875rem] text-stone-400"
              >
                <span>Context:</span>
                <span class="font-medium text-stone-600">{{ configuredContext }}</span>
              </div>
            </div>
            <div
              v-if="attachmentError"
              class="attachment-error mt-2 flex flex-col gap-0.5 rounded-xl border border-red-200/80 bg-red-50/80 px-3 py-2 text-red-700"
              role="alert"
            >
              <span class="attachment-error-message text-xs font-medium">{{ attachmentError.message }}</span>
              <span
                v-if="attachmentError.detail"
                class="attachment-error-detail text-[0.6875rem] text-red-600"
              >{{ attachmentError.detail }}</span>
            </div>
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
