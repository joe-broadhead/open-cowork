import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

// Browser build of the unified renderer: the same renderer as the Electron build,
// minus the electron/preload/main plugin and the chart-frame asset-protocol
// rewrite (browser uses normal URLs). Output is a plain SPA the cloud server can
// serve. The Electron build stays in vite.config.ts.
export default defineConfig({
  // Served by the cloud server under /app, so every asset reference (HTML +
  // the JS bundle's internal dynamic-import / CSS-preload paths) must be
  // /app/assets/... — set the base so they're correct without server rewriting.
  base: '/app/',
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
  // Local verification only: serve the browser build same-origin and proxy the
  // backend routes to a running `pnpm cloud:dev` (:8787), so the renderer boots
  // against the real cloud HTTP+SSE API without cross-origin/CSP friction. The
  // production path is cloud-server serving dist-browser directly.
  preview: {
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
      '/auth': { target: 'http://localhost:8787', changeOrigin: true },
      '/events': { target: 'http://localhost:8787', changeOrigin: true },
      '/webhooks': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
})
