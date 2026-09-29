import { ref } from "vue"
import { testProviderConnection, type ProviderTestRequest } from "../services/provider"

// ── Provider connection test ───────────────────────────────────────────────
//
// The result of the *explicit* "Test Connection" action, shared so both the
// sidebar footer and the app header can describe the same real outcome. It is
// deliberately not a health poll: `status` stays empty until the user runs a
// test, so no component can claim a live connection that was never verified.
//
// The request payload is passed in by the caller (ProviderSettings) from its
// own draft values, which keeps the existing semantics: a test runs against
// what is currently typed in the form, not against the persisted settings.

export type ConnectionTestStatus = "" | "testing" | "success" | "error"

/** Provider fields a test request needs (seconds-based timeout, as configured). */
export interface ConnectionTestDraft {
  baseUrl: string
  model: string
  apiKey?: string
  timeout: number
}

const status = ref<ConnectionTestStatus>("")
const message = ref("")
const testing = ref(false)

/**
 * Run the connection test against the given draft and publish the outcome to
 * the shared refs. Mirrors the behaviour that previously lived inside
 * `ProviderSettings.vue`: no request when the endpoint or model is missing,
 * `Connected to <model>` on success, backend/exception message on failure.
 */
export async function runConnectionTest(draft: ConnectionTestDraft): Promise<void> {
  if (!draft.baseUrl || !draft.model) return

  status.value = "testing"
  message.value = ""
  testing.value = true

  try {
    const payload: ProviderTestRequest = {
      baseUrl: draft.baseUrl,
      model: draft.model,
      apiKey: draft.apiKey || undefined,
      timeout: draft.timeout * 1000,
    }

    const response = await testProviderConnection(payload)

    if (response.success) {
      status.value = "success"
      message.value = `Connected to ${response.model}`
    } else {
      status.value = "error"
      message.value = response.error || "Connection failed"
    }
  } catch (err) {
    status.value = "error"
    message.value = err instanceof Error ? err.message : "Connection failed"
  } finally {
    testing.value = false
  }
}

/** Reactive connection-test result (read-only by convention). */
export function useConnectionTest() {
  return { status, message, testing, runTest: runConnectionTest }
}
