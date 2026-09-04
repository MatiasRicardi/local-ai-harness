<script setup lang="ts">
import { computed } from "vue"
import type { Message } from "../types"
import type { FrontendApiError } from "../types/error"
import { renderMarkdown } from "../utils/markdown"

interface Props {
  messages: Message[]
  loading: boolean
  error: FrontendApiError | null
  stopped: boolean
}

const props = defineProps<Props>()

const hasMessages = computed(() => props.messages.length > 0)

function renderAssistantContent(content: string): string {
  return renderMarkdown(content)
}
</script>

<template>
  <div class="chat-messages">
    <div v-if="error" class="error" role="alert">
      <p>{{ error.message }}</p>
      <span v-if="error.detail" class="error-detail">{{ error.detail }}</span>
    </div>

    <div v-if="!hasMessages" class="empty-state">
      <h3>Start a conversation</h3>
      <p>Send a message to your configured local model to get started.</p>
    </div>

    <div v-for="msg in messages" :key="msg.id" class="message" :class="['message-' + msg.role, { 'message-stopped': msg.stopped }]">
      <div class="message-content">
        <div class="message-role">{{ msg.role }}</div>
        <!-- eslint-disable-next-line vue/no-v-html -->
        <div v-if="msg.role === 'assistant'" class="message-text markdown-content" v-html="renderAssistantContent(msg.content)"></div>
        <div v-else class="message-text">{{ msg.content }}</div>
        <div v-if="msg.stopped" class="message-stopped-indicator">
          <span>Stopped</span>
        </div>
      </div>
    </div>

    <div v-if="loading" class="loading">
      <span>Generating...</span>
    </div>

    <div v-if="stopped" class="stopped">
      <span>Generation stopped</span>
    </div>
  </div>
</template>

<style scoped>
.chat-messages {
  display: flex;
  flex-direction: column;
  gap: 20px;
  width: 100%;
  max-width: 860px;
  margin: 0 auto;
  padding: 0 16px;
}

.empty-state {
  text-align: center;
  padding: 48px 16px;
  color: var(--text);
  opacity: 0.6;
}

.empty-state h3 {
  margin: 0 0 8px;
  font-size: 1.1rem;
  font-weight: 600;
}

.empty-state p {
  margin: 0;
  font-size: 0.9rem;
}

.loading {
  font-style: italic;
  color: var(--text);
  opacity: 0.7;
  padding: 8px 0;
}

.stopped {
  font-style: italic;
  color: #ef4444;
  opacity: 0.8;
  padding: 8px 0;
}

.error {
  padding: 12px 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
}

.error p {
  margin: 0;
  font-size: 0.9rem;
}

.error-detail {
  display: block;
  margin-top: 4px;
  font-size: 0.8rem;
  opacity: 0.85;
}

.message {
  padding: 16px 20px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg-secondary);
  width: 100%;
}

.message-role {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text);
  opacity: 0.6;
  margin-bottom: 8px;
}

.message-content {
  word-wrap: break-word;
}

.message-text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.6;
  font-size: 0.95rem;
}

.message-user {
  background: var(--accent-bg);
  border-color: var(--accent-border);
}

.message-assistant {
  background: var(--bg);
}

.message-stopped {
  opacity: 0.7;
}

.message-stopped-indicator {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
  font-size: 0.8rem;
  color: #ef4444;
  font-style: italic;
}

/* Markdown typography for assistant messages */
.markdown-content {
  white-space: normal;
  line-height: 1.6;
  font-size: 0.95rem;
}

.markdown-content p {
  margin: 0 0 12px;
}

.markdown-content p:last-child {
  margin-bottom: 0;
}

.markdown-content h1,
.markdown-content h2,
.markdown-content h3,
.markdown-content h4 {
  margin: 20px 0 10px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--text-h);
}

.markdown-content h1 { font-size: 1.5rem; }
.markdown-content h2 { font-size: 1.3rem; }
.markdown-content h3 { font-size: 1.1rem; }
.markdown-content h4 { font-size: 1rem; }

.markdown-content ul,
.markdown-content ol {
  margin: 0 0 12px;
  padding-left: 24px;
}

.markdown-content li {
  margin-bottom: 4px;
  line-height: 1.5;
}

.markdown-content a {
  color: var(--accent);
  text-decoration: none;
}

.markdown-content a:hover {
  text-decoration: underline;
}

.markdown-content blockquote {
  margin: 0 0 12px;
  padding: 4px 16px;
  border-left: 3px solid var(--accent);
  color: var(--text);
  opacity: 0.85;
}

.markdown-content strong {
  font-weight: 600;
}

.markdown-content em {
  font-style: italic;
}

.markdown-content code {
  font-family: var(--mono);
  font-size: 0.88em;
  background: var(--code-bg);
  padding: 2px 6px;
  border-radius: 4px;
}

.markdown-content pre {
  margin: 0 0 12px;
  padding: 14px 16px;
  background: var(--code-bg);
  border-radius: 8px;
  overflow-x: auto;
  font-family: var(--mono);
  font-size: 0.88rem;
  line-height: 1.5;
  white-space: pre;
  tab-size: 4;
}

.markdown-content pre code {
  background: none;
  padding: 0;
  border-radius: 0;
  font-size: inherit;
}

.markdown-content hr {
  border: none;
  border-top: 1px solid var(--border);
  margin: 16px 0;
}
</style>
