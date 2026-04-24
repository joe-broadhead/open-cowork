import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'vite-plugin-electron'
import electronRenderer from 'vite-plugin-electron-renderer'
import { resolve } from 'path'

export default defineConfig({
  build: {
    chunkSizeWarningLimit: 550,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        chartFrame: resolve(__dirname, 'chart-frame.html'),
      },
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('vega-embed')) return 'vendor-vega-embed'
          if (id.includes('vega-lite')) return 'vendor-vega-lite'
          if (id.includes('/vega/')) return 'vendor-vega-core'
          if (id.includes('react-markdown')
            || id.includes('remark-gfm')
            || id.includes('rehype-')
            || id.includes('highlight.js')) {
            return 'capabilities-markdown'
          }
          if (id.includes('/marked/')
            || id.includes('/dompurify/')
            || id.includes('/morphdom/')
            || id.includes('/remend/')) {
            return 'chat-markdown'
          }
          if (id.includes('/mermaid/')
            || id.includes('/dagre-d3-es/')
            || id.includes('/cytoscape/')
            || id.includes('/cytoscape-cose-bilkent/')
            || id.includes('/katex/')
            || id.includes('/elkjs/')) {
            return 'vendor-mermaid'
          }
          if (id.includes('/react/')
            || id.includes('/react-dom/')
            || id.includes('/scheduler/')
            || id.includes('/zustand/')) {
            return 'vendor-react'
          }
          return undefined
        },
      },
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    electron([
      {
        entry: 'src/main/index.ts',
        vite: {
          build: {
            outDir: 'dist/main',
            rollupOptions: {
              external: ['electron', 'google-auth-library', 'vega', 'vega-lite', 'node:sqlite'],
            },
          },
        },
      },
      {
        entry: 'src/preload/index.ts',
        onstart(args) {
          args.reload()
        },
        vite: {
          build: {
            outDir: 'dist/preload',
            rollupOptions: {
              external: ['electron'],
            },
          },
        },
      },
    ]),
    electronRenderer(),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer'),
    },
  },
})
