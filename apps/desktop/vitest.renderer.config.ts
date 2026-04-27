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
  },
})
