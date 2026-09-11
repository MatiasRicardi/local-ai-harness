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
  <div class="document-attachment flex flex-col gap-2">
    <input
      ref="fileInputRef"
      type="file"
      accept=".txt,.md,.pdf"
      class="document-attachment-input hidden"
      @change="handleFileChange"
      aria-label="Attach document"
    />

    <div class="document-attachment-info flex flex-col gap-2">
      <div
        v-if="uploading"
        class="document-attachment-uploading flex items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-500"
      >
        <span class="size-1.5 shrink-0 animate-pulse rounded-full bg-sky-500" aria-hidden="true"></span>
        Uploading document...
      </div>
      <div
        v-if="attachedDocument"
        class="document-attachment-meta flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2"
      >
        <span class="document-attachment-filename min-w-0 truncate text-sm font-medium text-neutral-900">{{ attachedDocument.originalFilename }}</span>
        <span class="document-attachment-status text-xs font-medium text-emerald-700">Ready</span>
        <span class="document-attachment-details text-xs text-neutral-500">
          {{ attachedDocument.characterCount.toLocaleString() }} characters
          <template v-if="attachedDocument.pageCount !== undefined">
            · {{ attachedDocument.pageCount }} page{{ attachedDocument.pageCount === 1 ? "" : "s" }}
          </template>
        </span>
      </div>

      <div
        v-if="attachedDocument && attachedDocument.warnings.length > 0"
        class="document-attachment-warnings flex flex-col gap-0.5"
      >
        <div
          v-for="(warning, index) in attachedDocument.warnings"
          :key="index"
          class="document-attachment-warning text-xs text-amber-700"
        >
          Warning: {{ warning }}
        </div>
      </div>

      <div class="document-attachment-actions flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="document-attachment-btn focus-ring inline-flex shrink-0 items-center rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 transition-colors hover:border-sky-500 hover:text-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="uploading"
          @click="handleButtonClick"
          :aria-label="attachedDocument ? 'Replace document' : 'Attach document'"
        >
          {{ attachedDocument ? "Replace" : "Attach document" }}
        </button>
        <button
          v-if="attachedDocument"
          type="button"
          class="document-attachment-remove focus-ring inline-flex shrink-0 items-center rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-xs font-medium text-neutral-700 transition-colors hover:border-red-300 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
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
