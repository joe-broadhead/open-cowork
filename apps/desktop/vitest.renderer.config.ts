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
        // Advisory ratchet for the current component-test baseline.
        // Raise these as stateful renderer screens gain direct tests.
        lines: 5,
        branches: 1,
        functions: 1,
        statements: 5,
      },
    },
  },
})
