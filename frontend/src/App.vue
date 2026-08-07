<script setup lang="ts">
import ProviderSettings from "./components/ProviderSettings.vue"
</script>

<template>
  <div id="app">
    <header class="header">
      <h1>Local AI Harness</h1>
    </header>
    <main class="main">
      <ProviderSettings />
      <section class="chat-panel">
        <p>Chat panel placeholder</p>
      </section>
    </main>
  </div>
</template>
