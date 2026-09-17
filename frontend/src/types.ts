import type { WebSearchSource } from "./services/chat"

export interface Message {
  id: string
  role: "user" | "assistant"
  content: string
  stopped?: boolean
  // Backend-provided, structurally-validated sources for this assistant turn.
  // Absent when the turn did not run a web search (or found no results).
  sources?: WebSearchSource[]
}
