<script setup lang="ts">
// Shared inline icon set (stroke-based, 24x24, inherits `currentColor`).
//
// The project intentionally has no icon dependency: every glyph used by the UI
// is drawn here once so components stay readable. Sizing and colour come from
// classes on the component (e.g. `class="size-4 text-indigo-600"`).
type IconName =
  | "arrow-right"
  | "arrow-up"
  | "check"
  | "chip"
  | "code"
  | "cpu"
  | "document"
  | "gauge"
  | "globe"
  | "lock"
  | "network"
  | "paperclip"
  | "plus"
  | "search"
  | "shield-alert"
  | "sliders"
  | "sparkles"
  | "terminal"
  | "zap"

defineProps<{ name: IconName }>()
</script>

<template>
  <svg
    class="shrink-0"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <template v-if="name === 'arrow-right'">
      <path d="M4 12h15" />
      <path d="m13 6 6 6-6 6" />
    </template>
    <template v-else-if="name === 'arrow-up'">
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </template>
    <template v-else-if="name === 'check'">
      <path d="m4 12.5 5 5L20 6.5" />
    </template>
    <template v-else-if="name === 'chip'">
      <rect x="5" y="5" width="14" height="14" rx="2.5" />
      <path d="M10 10h4v4h-4z" />
      <path d="M9 2.5v2.5M12 2.5v2.5M15 2.5v2.5M9 19v2.5M12 19v2.5M15 19v2.5M2.5 9H5M2.5 12H5M2.5 15H5M19 9h2.5M19 12h2.5M19 15h2.5" />
    </template>
    <template v-else-if="name === 'code'">
      <path d="m9 8-5 4 5 4" />
      <path d="m15 8 5 4-5 4" />
      <path d="m13.5 5-3 14" />
    </template>
    <template v-else-if="name === 'cpu'">
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
      <path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" />
    </template>
    <template v-else-if="name === 'document'">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </template>
    <template v-else-if="name === 'gauge'">
      <path d="M3.5 18.5a9 9 0 1 1 17 0" />
      <path d="m12 14 4.5-4.5" />
      <path d="M12 18.6h.01" />
    </template>
    <template v-else-if="name === 'globe'">
      <circle cx="12" cy="12" r="9" />
      <path d="M3.5 9h17M3.5 15h17" />
      <path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18" />
    </template>
    <template v-else-if="name === 'lock'">
      <rect x="4" y="11" width="16" height="9.5" rx="2" />
      <path d="M8 11V7.5a4 4 0 0 1 8 0V11" />
    </template>
    <template v-else-if="name === 'network'">
      <rect x="2.5" y="16" width="7" height="6" rx="1.5" />
      <rect x="14.5" y="16" width="7" height="6" rx="1.5" />
      <rect x="8.5" y="2" width="7" height="6" rx="1.5" />
      <path d="M6 16v-3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v3" />
      <path d="M12 12V8" />
    </template>
    <template v-else-if="name === 'paperclip'">
      <path d="M20.5 11.5l-8.2 8.2a4.5 4.5 0 0 1-6.4-6.4l8.1-8.1a3 3 0 0 1 4.3 4.3l-7.5 7.5a1.5 1.5 0 0 1-2.2-2.1l6.8-6.8" />
    </template>
    <template v-else-if="name === 'plus'">
      <path d="M12 5v14M5 12h14" />
    </template>
    <template v-else-if="name === 'search'">
      <circle cx="11" cy="11" r="7" />
      <path d="m20.5 20.5-4.4-4.4" />
    </template>
    <template v-else-if="name === 'shield-alert'">
      <path d="M12 21.5c0 0-7-3.2-7-9V4.6l7-2.6 7 2.6v7.9c0 5.8-7 9-7 9z" />
      <path d="M12 7.5v5" />
      <path d="M12 15.8h.01" />
    </template>
    <template v-else-if="name === 'sliders'">
      <path d="M3 6.5h6M13.5 6.5H21M3 12h3M10.5 12H21M3 17.5h9M16.5 17.5H21" />
      <circle cx="11" cy="6.5" r="2" />
      <circle cx="8" cy="12" r="2" />
      <circle cx="14" cy="17.5" r="2" />
    </template>
    <template v-else-if="name === 'sparkles'">
      <path d="M11 3.5l1.7 4.1 4.1 1.7-4.1 1.7L11 15.1l-1.7-4.1L5.2 9.3l4.1-1.7L11 3.5z" />
      <path d="M18.5 15l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8.8-1.9z" />
    </template>
    <template v-else-if="name === 'terminal'">
      <path d="m5 8.5 4 3.5-4 3.5" />
      <path d="M11.5 16h7.5" />
    </template>
    <template v-else-if="name === 'zap'">
      <path d="M13 2.5 4.5 13.5h6L10 21.5 19.5 10h-6.5l1-7.5z" />
    </template>
  </svg>
</template>
