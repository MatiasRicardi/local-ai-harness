<script setup lang="ts">
import { reactive, ref, watch, onUnmounted } from "vue"
import { testProviderConnection, type ProviderTestRequest } from "../services/provider"
import { getProviderSettings, STORAGE_KEY } from "../composables/useProviderSettings"

const settings = getProviderSettings()

const state = reactive({
  name: settings.name,
  baseUrl: settings.baseUrl,
  model: settings.model,
  apiKey: settings.apiKey,
  timeout: settings.timeout,
  status: "" as
    | ""
    | "testing"
    | "success"
    | "error",
  message: "",
  testing: false,
})

const timer = ref<number | undefined>(undefined)

const doSync = () => {
  if (timer.value) return
  timer.value = setTimeout(() => {
    settings.name = state.name
    settings.baseUrl = state.baseUrl
    settings.model = state.model
    settings.apiKey = state.apiKey
    settings.timeout = state.timeout
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      name: state.name,
      baseUrl: state.baseUrl,
      model: state.model,
      apiKey: state.apiKey,
      timeout: state.timeout,
    }))
    timer.value = undefined
  }, 300)
}

// Clean up timer on unmount
onUnmounted(() => {
  clearTimeout(timer.value)
  timer.value = undefined
})

// Watch for changes and sync with debounce
watch(
  () => [state.name, state.baseUrl, state.model, state.apiKey, state.timeout],
  doSync,
  { immediate: false }
)

const handleTest = async () => {
  if (!state.baseUrl || !state.model) return

  state.status = "testing"
  state.message = ""
  state.testing = true

  try {
    const payload: ProviderTestRequest = {
      baseUrl: state.baseUrl,
      model: state.model,
      apiKey: state.apiKey || undefined,
      timeout: state.timeout * 1000,
    }

    const response = await testProviderConnection(payload)

    if (response.success) {
      state.status = "success"
      state.message = `Connected to ${response.model}`
      // watch() handler syncs to singleton + localStorage automatically
    } else {
      state.status = "error"
      state.message = response.error || "Connection failed"
      // watch() handler syncs to singleton + localStorage automatically
    }
  } catch (err) {
    state.status = "error"
    state.message = err instanceof Error ? err.message : "Connection failed"
    // watch() handler syncs to singleton + localStorage automatically
  } finally {
    state.testing = false
  }
}
</script>

<template>
  <div class="provider-settings">
    <h2>Provider Settings</h2>
    <p class="storage-notice">Settings are stored locally in your browser.</p>

    <form @submit.prevent="handleTest" class="settings-form">
      <div class="form-group">
        <label for="provider-name">Provider Name</label>
        <input
          id="provider-name"
          v-model="state.name"
          type="text"
          placeholder="e.g. llama.cpp"
        />
      </div>

      <div class="form-group">
        <label for="base-url">Base URL</label>
        <input
          id="base-url"
          v-model="state.baseUrl"
          type="url"
          placeholder="http://localhost:8080/v1"
        />
      </div>

      <div class="form-group">
        <label for="model">Model</label>
        <input
          id="model"
          v-model="state.model"
          type="text"
          placeholder="local-model"
        />
      </div>

      <div class="form-group">
        <label for="api-key">API Key (optional)</label>
        <input
          id="api-key"
          v-model="state.apiKey"
          type="password"
          placeholder="Leave blank if not required"
        />
        <small class="warning">Your API key is stored in localStorage on this browser.</small>
      </div>

      <div class="form-group">
        <label for="timeout">Timeout (seconds)</label>
        <input
          id="timeout"
          v-model.number="state.timeout"
          type="number"
          min="10"
          max="300"
          step="10"
        />
      </div>

      <div class="form-actions">
        <button
          type="submit"
          class="btn btn-primary"
          :disabled="!state.baseUrl || !state.model || state.testing"
        >
          {{ state.testing ? "Testing..." : "Test Connection" }}
        </button>
      </div>

      <div v-if="state.testing" class="status testing">
        Testing connection to {{ state.baseUrl }}...
      </div>

      <div v-else-if="state.status === 'success'" class="status success">
        <strong>Connected!</strong> {{ state.message }}
      </div>

      <div v-else-if="state.status === 'error'" class="status error">
        <strong>Connection failed</strong> — {{ state.message }}
      </div>
    </form>
  </div>
</template>

<style scoped>
.provider-settings {
  padding: 1rem;
  border: 1px solid #ccc;
  border-radius: 8px;
  background: #fafafa;
}

.provider-settings h2 {
  margin-top: 0;
  font-size: 1.1rem;
}

.storage-notice {
  font-size: 0.85rem;
  color: #666;
  margin-bottom: 1rem;
}

.settings-form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.form-group label {
  font-size: 0.9rem;
  font-weight: 600;
}

.form-group input {
  padding: 0.4rem 0.5rem;
  border: 1px solid #bbb;
  border-radius: 4px;
  font-size: 0.9rem;
}

.form-group input:focus {
  outline: none;
  border-color: #4a90d9;
  box-shadow: 0 0 0 2px rgba(74, 144, 217, 0.2);
}

.form-group small {
  color: #e67e22;
  font-size: 0.75rem;
}

.form-actions {
  display: flex;
  gap: 0.5rem;
}

.btn {
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.9rem;
  font-weight: 600;
}

.btn-primary {
  background: #4a90d9;
  color: #fff;
}

.btn-primary:disabled {
  background: #aaa;
  cursor: not-allowed;
}

.btn-primary:hover:not(:disabled) {
  background: #3a7bc8;
}

.status {
  padding: 0.5rem 0.75rem;
  border-radius: 4px;
  font-size: 0.85rem;
  margin-top: 0.5rem;
}

.status.testing {
  background: #fff3cd;
  color: #856404;
}

.status.success {
  background: #d4edda;
  color: #155724;
}

.status.error {
  background: #f8d7da;
  color: #721c24;
}
</style>
