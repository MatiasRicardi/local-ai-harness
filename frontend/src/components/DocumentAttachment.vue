<script setup lang="ts">
import { ref } from "vue"
import type { AttachedDocument } from "../services/files"
import { uploadDocument, isSupportedExtension } from "../services/files"

interface Props {
  attachedDocument: AttachedDocument | null
  uploading: boolean
  onAttach: (doc: AttachedDocument) => void
  onRemove: () => void
  onError: (message: string) => void
}

const props = defineProps<Props>()

const fileInputRef = ref<HTMLInputElement | null>(null)

async function handleFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file || props.uploading) return

  if (!isSupportedExtension(file.name)) {
    props.onError(`Unsupported file type. Allowed: .txt, .md, .pdf`)
    resetInput()
    return
  }

  emit("upload:start")

  try {
    const doc = await uploadDocument(file)
    props.onAttach(doc)
    resetInput()
  } catch (err) {
    props.onError(err instanceof Error ? err.message : "Upload failed.")
    resetInput()
  } finally {
    emit("upload:end")
  }
}

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
}>()
</script>

<template>
  <div class="document-attachment">
    <input
      ref="fileInputRef"
      type="file"
      accept=".txt,.md,.pdf"
      class="document-attachment-input"
      @change="handleFileChange"
      aria-label="Attach document"
    />

    <div class="document-attachment-info">
      <div v-if="uploading" class="document-attachment-uploading">
        Uploading document...
      </div>
      <template v-else-if="attachedDocument">
        <div class="document-attachment-meta">
          <span class="document-attachment-filename">{{ attachedDocument.originalFilename }}</span>
          <span class="document-attachment-status">Ready</span>
          <span class="document-attachment-details">
            {{ attachedDocument.characterCount.toLocaleString() }} characters
            <template v-if="attachedDocument.pageCount !== undefined">
              · {{ attachedDocument.pageCount }} page{{ attachedDocument.pageCount === 1 ? "" : "s" }}
            </template>
          </span>
        </div>

        <div
          v-if="attachedDocument.warnings.length > 0"
          class="document-attachment-warnings"
        >
          <div
            v-for="(warning, index) in attachedDocument.warnings"
            :key="index"
            class="document-attachment-warning"
          >
            Warning: {{ warning }}
          </div>
        </div>
      </template>

      <div class="document-attachment-actions">
        <button
          type="button"
          class="document-attachment-btn"
          :disabled="uploading"
          @click="handleButtonClick"
          :aria-label="attachedDocument ? 'Replace document' : 'Attach document'"
        >
          {{ attachedDocument ? "Replace" : "Attach document" }}
        </button>
        <button
          v-if="attachedDocument"
          type="button"
          class="document-attachment-remove"
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

<style scoped>
.document-attachment {
  display: flex;
  align-items: center;
  gap: 8px;
}

.document-attachment-input {
  display: none;
}

.document-attachment-btn {
  padding: 8px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: var(--text);
  font-family: inherit;
  font-size: 0.85rem;
  cursor: pointer;
  transition: border-color 0.2s, opacity 0.2s;
}

.document-attachment-btn:hover:not(:disabled) {
  border-color: var(--accent);
}

.document-attachment-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.document-attachment-info {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
  flex: 1;
  min-width: 0;
}

.document-attachment-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.document-attachment-filename {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--text-h);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.document-attachment-status {
  font-size: 0.75rem;
  color: #16a34a;
  font-weight: 500;
}

.document-attachment-details {
  font-size: 0.78rem;
  color: var(--text);
  opacity: 0.7;
}

.document-attachment-warnings {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 2px;
}

.document-attachment-warning {
  font-size: 0.75rem;
  color: #d97706;
}

.document-attachment-remove {
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
  font-family: inherit;
  font-size: 0.78rem;
  cursor: pointer;
  white-space: nowrap;
  transition: border-color 0.2s, opacity 0.2s;
  flex-shrink: 0;
}

.document-attachment-remove:hover {
  border-color: #ef4444;
  color: #ef4444;
}

.document-attachment-uploading {
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
  font-size: 0.85rem;
  color: var(--text);
  opacity: 0.7;
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 38px;
}
</style>
