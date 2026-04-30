import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    environmentOptions: {
      jsdom: {
        url: 'http://localhost/',
      },
    },
    include: ['src/renderer/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/renderer/test/setup.ts'],
    clearMocks: true,
    mockReset: false,
    restoreMocks: false,
    coverage: {
      provider: 'v8',
      reportsDirectory: '../../coverage/renderer',
      reporter: ['text', 'lcov'],
      all: true,
      include: ['src/renderer/**/*.{ts,tsx}'],
      exclude: [
        'src/renderer/**/*.test.{ts,tsx}',
        'src/renderer/test/**',
        'src/renderer/index.tsx',
      ],
      thresholds: {
        // Baseline ratchet for the current component-test suite.
        // Keep just below measured coverage and raise as stateful
        // renderer screens gain direct tests.
        lines: 15,
        branches: 8,
        functions: 11,
        statements: 14,
      },
    },
  },
})
