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
export function resolveApiBase(viteApiUrl?: string): string {
  return viteApiUrl ?? ""
}

export const API_BASE = resolveApiBase(import.meta.env.VITE_API_URL)
