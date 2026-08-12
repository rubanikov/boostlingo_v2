import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { configDefaults } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // frontend/e2e/*.spec.ts are Playwright specs (run via `npm run
    // test:e2e`, see playwright.config.ts) — Vitest's default include glob
    // otherwise matches them too and tries to run them as unit tests, which
    // fails since they call Playwright's own `test.describe` outside its
    // runner. Keep the two suites disjoint.
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
})
