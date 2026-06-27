import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

// Browser build of the unified renderer: the same renderer as the Electron build,
// minus the electron/preload/main plugin and the chart-frame asset-protocol
// rewrite (browser uses normal URLs). Output is a plain SPA the cloud server can
// serve. The Electron build stays in vite.config.ts.
export default defineConfig({
  build: {
    outDir: 'dist-browser',
    emptyOutDir: true,
    chunkSizeWarningLimit: 3000,
    rollupOptions: {
      input: {
        browser: resolve(__dirname, 'browser.html'),
      },
      output: {
        manualChunks(id) {
          if (!id.includes('/node_modules/')) return undefined
          if (id.includes('vega-embed')) return 'vendor-vega-embed'
          if (id.includes('vega-lite')) return 'vendor-vega-lite'
          if (/\/node_modules\/vega\//.test(id)) return 'vendor-vega-core'
          if (/\/node_modules\/(react|react-dom|scheduler|zustand)\//.test(id)) return 'vendor-react'
          return undefined
        },
      },
    },
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer'),
    },
  },
})
