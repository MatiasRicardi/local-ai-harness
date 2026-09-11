<script setup lang="ts">
import { ref, watch } from "vue"
import type { AttachedDocument } from "../services/files"
import { uploadDocument, isSupportedExtension } from "../services/files"
import { FrontendApiError } from "../types/error"

interface Props {
  attachedDocument: AttachedDocument | null
  uploading: boolean
  onAttach: (doc: AttachedDocument) => void
  onRemove: () => void
  onError: (error: FrontendApiError) => void
  resetVersion?: number
}

const props = defineProps<Props>()

// Local request generation used to ignore a late upload result after a
// conversation reset, without moving upload ownership or adding an AbortSignal.
let uploadGeneration = 0

const fileInputRef = ref<HTMLInputElement | null>(null)

async function handleFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file || props.uploading) return

  // A new attempt clears any previous attachment error at the App level.
  emit("attempt")

  if (!isSupportedExtension(file.name)) {
    // Client-side fast rejection (backend keeps its own authoritative check).
    props.onError(
      new FrontendApiError({
        code: "UNSUPPORTED_FILE",
        message: "Unsupported file type. Allowed: .txt, .md, .pdf",
      }),
    )
    resetInput()
    return
  }

  // Pin this request's generation so a reset mid-upload can invalidate it.
  const currentGeneration = ++uploadGeneration

  emit("upload:start")

  try {
    const doc = await uploadDocument(file)
    // Ignore a late upload result that arrives after a conversation reset.
    if (currentGeneration !== uploadGeneration) return
    props.onAttach(doc)
    resetInput()
  } catch (err) {
    if (currentGeneration !== uploadGeneration) return
    props.onError(
      err instanceof FrontendApiError
        ? err
        : new FrontendApiError({
            code: "FILE_UPLOAD_ERROR",
            message: "The file could not be uploaded.",
          }),
    )
    resetInput()
  } finally {
    if (currentGeneration === uploadGeneration) {
      emit("upload:end")
    }
  }
}

// Invalidate any in-flight upload when the parent requests a reset.
watch(
  () => props.resetVersion,
  () => {
    uploadGeneration++
    resetInput()
  },
)

function handleButtonClick() {
  fileInputRef.value?.click()
}

function handleRemove() {
  props.onRemove()
  resetInput()
}

function resetInput() {
  if (fileInputRef.value) {
    fileInputRef.value.value = ""
  }
}

const emit = defineEmits<{
  "upload:start": []
  "upload:end": []
  "attempt": []
}>()
</script>

<template>
  <!-- Compact toolbar rendered at the top of the composer card. -->
  <div class="document-attachment flex min-w-0 flex-col gap-1">
    <input
      ref="fileInputRef"
      type="file"
      accept=".txt,.md,.pdf"
      class="document-attachment-input hidden"
      @change="handleFileChange"
      aria-label="Attach document"
    />

    <div class="document-attachment-info flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
      <span
        v-if="attachedDocument"
        class="document-attachment-meta flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-md border border-stone-200/70 bg-stone-50 px-2 py-1 text-[0.6875rem]"
      >
        <svg
          class="size-3 shrink-0 text-sky-600"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M6 2.5h6l3 3v12H6z" />
          <path d="M12 2.5V6h3" />
        </svg>
        <span class="document-attachment-filename max-w-[14rem] truncate font-medium text-stone-700">{{ attachedDocument.originalFilename }}</span>
        <span class="document-attachment-status font-medium text-emerald-600">Ready</span>
        <span class="document-attachment-details text-stone-400">
          {{ attachedDocument.characterCount.toLocaleString() }} characters
          <template v-if="attachedDocument.pageCount !== undefined">
            · {{ attachedDocument.pageCount }} page{{ attachedDocument.pageCount === 1 ? "" : "s" }}
          </template>
        </span>
      </span>

      <div
        v-if="uploading"
        class="document-attachment-uploading flex items-center gap-1.5 rounded-md border border-stone-200/70 bg-stone-50 px-2 py-1 text-[0.6875rem] text-stone-500"
      >
        <span class="size-1.5 shrink-0 animate-pulse rounded-full bg-sky-500" aria-hidden="true"></span>
        Uploading document...
      </div>

      <div
        v-if="attachedDocument && attachedDocument.warnings.length > 0"
        class="document-attachment-warnings flex w-full flex-col gap-0.5"
      >
        <div
          v-for="(warning, index) in attachedDocument.warnings"
          :key="index"
          class="document-attachment-warning text-[0.6875rem] text-amber-700"
        >
          Warning: {{ warning }}
        </div>
      </div>

      <div class="document-attachment-actions flex flex-wrap items-center gap-1">
        <button
          type="button"
          class="document-attachment-btn focus-ring-inset inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-[0.6875rem] font-medium text-stone-600 transition-colors duration-150 hover:bg-stone-100 hover:text-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="uploading"
          @click="handleButtonClick"
          :aria-label="attachedDocument ? 'Replace document' : 'Attach document'"
        >
          <svg
            class="size-3 shrink-0"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M6 2.5h6l3 3v12H6z" />
            <path d="M12 2.5V6h3" />
          </svg>
          {{ attachedDocument ? "Replace" : "Attach document" }}
        </button>
        <button
          v-if="attachedDocument"
          type="button"
          class="document-attachment-remove focus-ring-inset inline-flex shrink-0 items-center rounded-lg px-2 py-1 text-[0.6875rem] font-medium text-stone-500 transition-colors duration-150 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="uploading"
          @click="handleRemove"
          aria-label="Remove attached document"
        >
          Remove
        </button>
      </div>
    </div>
  </div>
</template>
