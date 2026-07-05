import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

// Browser build of the unified renderer: the same renderer as the Electron build,
// minus the electron/preload/main plugin and the chart-frame asset-protocol
// rewrite (browser uses normal URLs). Output is a plain SPA the cloud server can
// serve. The Electron build stays in vite.config.ts.
//
// Two HTML inputs, mirroring the desktop build's `main` + `chartFrame` entries:
//   - browser.html: the SPA shell the cloud serves at / (and /app).
//   - chart-frame.html: the sandboxed Vega iframe the SPA's VegaChart embeds. It
//     pulls in vega-embed/vega-lite/vega, so without it the browser build ships no
//     vega at all and interactive charts 404 in the cloud (BUNDLE-1). The cloud
//     server serves the emitted chart-frame.html + its hashed /app/assets/* chunks.
export default defineConfig({
  // Served by the cloud server under /app, so every asset reference (HTML +
  // the JS bundle's internal dynamic-import / CSS-preload paths) must be
  // /app/assets/... — set the base so they're correct without server rewriting.
  base: '/app/',
  build: {
    outDir: 'dist-browser',
    emptyOutDir: true,
    // Budget guard: warn well below the old 3 MB so accidental multi-hundred-KB
    // growth on the eager startup path is visible in the build log. The hard,
    // CI-enforced budget lives in scripts/check-bundle-size.mjs, which sums the
    // gzipped eager entry graph from the manifest below (lazy mermaid/vega
    // chunks are excluded).
    chunkSizeWarningLimit: 700,
    // Emit .vite/manifest.json so the bundle-size budget script can walk the
    // browser entry's static-import (eager) graph + CSS precisely.
    manifest: true,
    rollupOptions: {
      input: {
        browser: resolve(__dirname, 'browser.html'),
        chartFrame: resolve(__dirname, 'chart-frame.html'),
      },
      output: {
        // Mirror the desktop vite.config.ts manualChunks so the chart-frame entry
        // emits the same isolated vendor-vega-* chunks (kept off the SPA's startup
        // path) plus the shared vendor-react chunk.
        manualChunks(id) {
          if (!id.includes('/node_modules/')) return undefined
          if (id.includes('/node_modules/vega-embed/')) return 'vendor-vega-embed'
          if (id.includes('/node_modules/vega-lite/')) return 'vendor-vega-lite'
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
      '@': resolve(__dirname, 'src'),
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
