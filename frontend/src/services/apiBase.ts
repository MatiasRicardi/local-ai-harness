/**
 * Single place where the browser-facing API base URL is resolved.
 *
 * `VITE_API_URL` is a Vite *build-time* value: it is inlined into the bundle,
 * so changing it requires a rebuild rather than restarting a container.
 *
 * The default is the empty string, which makes every service request a
 * same-origin relative path (`/api/...`):
 *
 * - `pnpm dev`: the browser calls `http://127.0.0.1:5173/api/...` and the Vite
 *   development proxy forwards it to the backend;
 * - Docker Compose: the browser calls the frontend origin and nginx proxies
 *   `/api/` to `backend:3000` on the Compose network.
 *
 * A Docker service DNS name such as `http://backend:3000` is deliberately never
 * compiled into the bundle: the browser cannot resolve it.
 *
 * The rule lives in a pure function so both branches can be tested without
 * depending on whether a developer happens to have a local `.env`.
 */
/**
 * Loopback hosts are safe over HTTP: their traffic never leaves the machine,
 * so there is no cleartext exposure to a third party. Everything else must
 * use HTTPS to avoid sending sensitive payloads (e.g. `payload.apiKey`) over
 * a cleartext connection (CWE-319).
 */
function isLocalhostHost(host: string): boolean {
  const normalized = host.toLowerCase()
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  )
}

/**
 * Rejects a non-local HTTP API base before it can be used, so no sensitive
 * payload is ever sent over cleartext to a remote server. The empty base
 * (same-origin) and HTTPS bases are always allowed; only non-local HTTP is
 * rejected, with localhost development explicitly permitted over HTTP.
 */
export function assertSecureApiBase(viteApiUrl: string): void {
  const base = viteApiUrl.trim()
  if (!base) return

  // Protocol-relative bases (e.g. "//attacker.example") inherit the page
  // protocol but hijack the host. new URL() throws for them (no base to derive
  // the protocol), so the parse below would silently accept them; reject
  // explicitly so a request can never be routed to an attacker host (CWE-201).
  if (base.startsWith("//")) {
    throw new Error(
      `Insecure API base rejected: "${base}". Protocol-relative bases are not allowed.`,
    )
  }

  let parsed: URL
  try {
    parsed = new URL(base)
  } catch {
    // A leading-slash same-origin relative path (e.g. "/api") has no base to
    // resolve against and throws, but it resolves to the current origin at
    // request time, so it is safe. Only the cleartext-to-remote concern is
    // guarded at resolution.
    return
  }

  if (parsed.protocol === "http:" && !isLocalhostHost(parsed.hostname)) {
    throw new Error(
      `Insecure API base rejected: "${base}". Non-local API bases must use HTTPS; ` +
        "localhost development is allowed over HTTP.",
    )
  }
}

export function resolveApiBase(viteApiUrl?: string): string {
  const base = viteApiUrl ?? ""
  assertSecureApiBase(base)
  return base
}

/**
 * True when a page origin cannot leak a cleartext payload to a third party
 * (CWE-319): HTTPS on any host, or loopback over HTTP.
 *
 * Exported as a pure function of `location` so the rule is testable without a
 * live browser global.
 */
export function isSecurePageOrigin(location: {
  protocol: string
  hostname: string
}): boolean {
  return location.protocol === "https:" || isLocalhostHost(location.hostname)
}

/**
 * True when the current transport cannot leak a cleartext payload to a third
 * party (CWE-319). Used to gate requests that carry a sensitive key (e.g. the
 * Tavily web-search `apiKey`) before constructing or sending them.
 *
 * - A non-empty API base is already validated as local-or-HTTPS by
 *   {@link assertSecureApiBase}, so its transport is safe regardless of the
 *   page that issued the request.
 * - An empty base is same-origin, so transport security is the page's own
 *   protocol (see {@link isSecurePageOrigin}): loopback is safe over HTTP, any
 *   other host must be HTTPS.
 *
 * Only meaningful in a browser; non-browser contexts default to safe so the
 * module never throws while resolving `API_BASE` at import time.
 */
export function isSecureTransport(): boolean {
  if (API_BASE.trim()) return true
  if (typeof window === "undefined") return true
  return isSecurePageOrigin(window.location)
}

export const API_BASE = resolveApiBase(import.meta.env.VITE_API_URL)
