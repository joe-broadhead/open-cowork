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
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    clearMocks: true,
    mockReset: false,
    restoreMocks: false,
    coverage: {
      provider: 'v8',
      reportsDirectory: '../../coverage/renderer',
      reporter: ['text', 'lcov'],
      all: true,
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/test/**',
        'src/index.tsx',
      ],
      thresholds: {
        // Baseline ratchet for the current component-test suite.
        // Keep just below measured coverage and raise as stateful
        // renderer screens gain direct tests.
        lines: 65,
        branches: 58,
        functions: 62,
        statements: 61,
      },
    },
  },
})
