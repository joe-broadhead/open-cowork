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
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('vega-embed')) return 'vendor-vega-embed'
          if (id.includes('vega-lite')) return 'vendor-vega-lite'
          if (id.includes('/vega/')) return 'vendor-vega-core'
          if (id.includes('react-markdown')
            || id.includes('remark-gfm')
            || id.includes('rehype-')
            || id.includes('highlight.js')
            || id.includes('/marked/')
            || id.includes('/dompurify/')
            || id.includes('/morphdom/')
            || id.includes('/remend/')) {
            return 'vendor-markdown'
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
              external: ['electron', 'better-sqlite3', 'google-auth-library'],
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
