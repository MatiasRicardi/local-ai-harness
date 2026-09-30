<script setup lang="ts">
import { ref, computed } from "vue"
import {
  streamChat,
  buildWebSearchPayload,
  type ChatMessage,
  type ChatProviderConfig,
  type StreamCallbacks,
  type WebSearchRequestConfig,
} from "./services/chat"
import { useProviderSettings } from "./composables/useProviderSettings"
import { useWebSearchSettings } from "./composables/useWebSearchSettings"
import ProviderSettings from "./components/ProviderSettings.vue"
import AppHeader from "./components/AppHeader.vue"
import ChatMessages from "./components/ChatMessages.vue"
import ChatEmptyState from "./components/ChatEmptyState.vue"
import DocumentAttachment from "./components/DocumentAttachment.vue"
import ChatInput from "./components/ChatInput.vue"
import { useConnectionTest } from "./composables/useConnectionTest"
import type { Message } from "./types"
import type { AttachedDocument } from "./services/files"
import { FrontendApiError, type AppErrorArea } from "./types/error"
import { isSecureTransport } from "./services/apiBase"

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
// Generic, tool-agnostic activity for the in-progress turn only. Set to the
// tool name on the backend `tool_start` event and cleared on the matching
// `tool_end` (or on done/error/cancel/reset); `ChatMessages` renders it as a
// human label (see its `activityLabel`). Kept free of any specific-tool notion.
const activeToolName = ref<string | null>(null)
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

// Outcome of the explicit Test Connection action, shown as a neutral dot in the
// header (never a health poll, and blank until the user tests).
const { status: connectionStatus } = useConnectionTest()

const providerSettings = useProviderSettings()
const webSearchSettings = useWebSearchSettings()

// Presentation-only summaries. They describe what the user configured, never a
// live connection state (that stays inside ProviderSettings' Test Connection).
const configuredModel = computed(() => providerSettings.value.model.trim())

// Presentation of the current generation's activity, derived from the existing
// busy flags so no part of the streaming state machine needs refactoring:
// idle (idle) | tool (a backend tool is running) | generating (streaming answer).
type GenerationActivity = "idle" | "tool" | "generating"
const activity = computed<GenerationActivity>(() =>
  loading.value ? (activeToolName.value ? "tool" : "generating") : "idle",
)

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

// Show the welcome screen only for a genuinely empty transcript: an error,
// a stopped turn or any message keeps the transcript itself on screen.
const showEmptyState = computed(
  () => messages.value.length === 0 && !chatError.value && !stopped.value,
)

function scrollToBottom(behavior: ScrollBehavior = "auto") {
  messagesEnd.value?.scrollIntoView({ behavior })
}

function cleanup() {
  abortController.value = null
  sending.value = false
  loading.value = false
  stopped.value = false
  activeToolName.value = null
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
  activeToolName.value = null
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

  // Web search defense-in-depth: block the send path when it is enabled without
  // an API key. The clear inline error lives in ProviderSettings (reactive);
  // the backend validates again as a backstop.
  if (
    webSearchSettings.settings.value.enabled &&
    !webSearchSettings.settings.value.apiKey.trim()
  ) {
    return
  }

  // Web search carries the Tavily key, a sensitive third-party secret. Reject
  // it before constructing the request when the current transport would send it
  // over cleartext to a non-local origin (CWE-319). A non-empty API base is
  // already validated as local-or-HTTPS; only the same-origin (empty base) case
  // depends on the page protocol, which is safe on loopback or over HTTPS.
  if (
    webSearchSettings.settings.value.enabled &&
    !isSecureTransport()
  ) {
    errors.value.chat = new FrontendApiError({
      code: "VALIDATION_ERROR",
      message:
        "Web search is disabled on insecure connections: serve this page over HTTPS or from localhost to send the Tavily key.",
    })
    return
  }

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
    onToolStart: ({ name }) => {
      if (currentGenerationId !== generationId) return
      activeToolName.value = name
      scrollToBottom("auto")
    },
    onToolEnd: ({ name }) => {
      if (currentGenerationId !== generationId) return
      // Match the tool name so a stray/misordered event cannot clear the
      // wrong tool; leaves the state ready for a later multi-step lifecycle.
      if (activeToolName.value === name) activeToolName.value = null
    },
    onSources: (sources) => {
      // Ignore callbacks from a previous generation (reset/cancel happened).
      if (currentGenerationId !== generationId) return

      // Attach to the current assistant turn via its id (never by index) so a
      // concurrent reset/cancel cannot place the sources on the wrong message.
      const message = assistantMessageId
        ? messages.value.find((m) => m.id === assistantMessageId)
        : undefined
      if (message) {
        message.sources = sources
      }
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
    // Omitted entirely when web search is disabled, keeping the legacy request
    // body untouched. Only enabled requests reach the backend.
    const webSearch: WebSearchRequestConfig | undefined = buildWebSearchPayload({
      enabled: webSearchSettings.settings.value.enabled,
      provider: webSearchSettings.settings.value.provider,
      apiKey: webSearchSettings.settings.value.apiKey,
      searchDepth: webSearchSettings.settings.value.searchDepth,
      maxResults: webSearchSettings.settings.value.maxResults,
    })
    await streamChat(allMessages, provider, callbacks, {
      signal,
      document,
      context,
      webSearch,
    })
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
  <div id="app" class="flex min-h-dvh flex-col bg-slate-50 text-slate-800 lg:h-dvh lg:overflow-hidden">
    <!-- Full-width header: app identity, configured endpoint/model, reset. -->
    <AppHeader
      class="header"
      :provider-name="endpointSummary.name"
      :endpoint-host="endpointSummary.host"
      :model="configuredModel"
      :context-label="configuredContext"
      :connection-status="connectionStatus"
      @reset="handleReset"
    />
    <main class="flex min-h-0 flex-1 flex-col lg:flex-row lg:overflow-hidden">
      <!-- Sidebar: stacks above the chat on narrow viewports, scrolls on its own on desktop. -->
      <aside
        class="sidebar shrink-0 border-b border-slate-200 bg-slate-100/70 lg:flex lg:min-h-0 lg:w-[340px] lg:flex-col lg:overflow-hidden lg:border-b-0 lg:border-r"
      >
        <ProviderSettings />
      </aside>
      <section class="chat-area flex min-w-0 flex-1 flex-col bg-slate-50 lg:min-h-0 lg:overflow-hidden">
        <!-- Message stream: the only scrolling pane on desktop. -->
        <div class="chat-stream chat-dots min-h-0 flex-1 lg:overflow-y-auto">
          <div class="chat-inner mx-auto flex w-full max-w-3xl flex-col px-4 pb-6 pt-6 md:px-8">
            <ChatEmptyState
              v-if="showEmptyState"
              :model="configuredModel"
              :context-label="configuredContext"
              :web-search-enabled="webSearchSettings.settings.value.enabled"
            />
            <ChatMessages
              :messages="messages"
              :loading="loading"
              :activity="activity"
              :active-tool-name="activeToolName"
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
             bottom of the workspace on desktop (the stream above scrolls alone).
             Floating look without a border line: elevation plus a fade so the dotted
             canvas rolls under it. -->
        <div class="composer-dock shrink-0 bg-gradient-to-t from-slate-50 via-slate-50 to-transparent px-4 pb-5 pt-2 md:px-6">
          <div
            class="composer-card mx-auto w-full max-w-3xl rounded-2xl border border-slate-200/90 bg-white p-2.5 shadow-floating transition-all focus-within:border-indigo-400 focus-within:ring-2 focus-within:ring-indigo-500/15"
          >
            <div
              class="composer-toolbar flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-slate-100 px-1.5 pb-2"
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
                class="composer-context flex shrink-0 items-center gap-1 font-mono text-[0.6875rem] text-slate-400"
              >
                <span>Context:</span>
                <span class="font-medium text-indigo-600">{{ configuredContext }}</span>
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
