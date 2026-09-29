import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// Application version shown in the header, read from package.json so the badge
// can never drift from the package it was built from.
const appVersion = (
  JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as {
    version: string
  }
).version

// https://vite.dev/config/
//
// The `test` block is consumed by Vitest; Vite ignores it during dev/build.
// Keeping it here reuses the same plugin and dev-server proxy configuration.
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  server: {
    proxy: {
      '/api': {
        target: process.env.VITE_API_URL ?? 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/__tests__/setup.ts'],
    // Explicit imports only: tests import { describe, it, expect, vi, ... }
    // from "vitest" rather than relying on global injection.
    globals: false,
    // Drop `vi.stubGlobal` replacements (e.g. `fetch`) after every test so a
    // stubbed global cannot leak beyond the test that created it.
    unstubGlobals: true,
  },
})
