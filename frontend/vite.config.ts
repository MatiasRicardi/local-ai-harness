import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
//
// The `test` block is consumed by Vitest; Vite ignores it during dev/build.
// Keeping it here reuses the same plugin and dev-server proxy configuration.
export default defineConfig({
  plugins: [vue(), tailwindcss()],
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
