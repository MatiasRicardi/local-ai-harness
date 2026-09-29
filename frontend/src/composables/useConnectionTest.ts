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
// Endpoint the last run targeted, so the footer can show what was actually
// requested even if the draft is edited mid-test.
const targetUrl = ref("")
// Monotonic counter identifying the in-flight test. A completion only publishes
// its result if it still matches the latest run, so a stale request that resolves
// after the target changes (or after clearStatus) can never overwrite a newer one.
let runVersion = 0

/**
 * Run the connection test against the given draft and publish the outcome to
 * the shared refs. Mirrors the behaviour that previously lived inside
 * `ProviderSettings.vue`: no request when the endpoint or model is missing,
 * `Connected to <model>` on success, backend/exception message on failure.
 */
export async function runConnectionTest(draft: ConnectionTestDraft): Promise<void> {
  if (!draft.baseUrl || !draft.model) return

  const requestVersion = ++runVersion
  status.value = "testing"
  message.value = ""
  testing.value = true
  targetUrl.value = draft.baseUrl

  try {
    const payload: ProviderTestRequest = {
      baseUrl: draft.baseUrl,
      model: draft.model,
      apiKey: draft.apiKey || undefined,
      timeout: draft.timeout * 1000,
    }

    const response = await testProviderConnection(payload)
    if (requestVersion !== runVersion) return

    if (response.success) {
      status.value = "success"
      message.value = `Connected to ${response.model}`
    } else {
      status.value = "error"
      message.value = response.error || "Connection failed"
    }
  } catch (err) {
    if (requestVersion !== runVersion) return
    status.value = "error"
    message.value = err instanceof Error ? err.message : "Connection failed"
  } finally {
    if (requestVersion === runVersion) testing.value = false
  }
}

/**
 * Forget the last test outcome. Call it when the configuration a result
 * describes changes, so a stale "Connected" badge never outlives the endpoint
 * and model it was earned against.
 */
export function clearConnectionTestStatus(): void {
  runVersion += 1
  status.value = ""
  message.value = ""
  testing.value = false
  targetUrl.value = ""
}

/** Reactive connection-test result (read-only by convention). */
export function useConnectionTest() {
  return {
    status,
    message,
    testing,
    targetUrl,
    runTest: runConnectionTest,
    clearStatus: clearConnectionTestStatus,
  }
}
