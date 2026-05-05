import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'vite-plugin-electron'
import { resolve } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import type { Plugin, ResolvedConfig } from 'vite'
import { chartFrameAssetUrl } from './src/lib/chart-frame-assets'

function packageNameFromId(id: string) {
  const normalized = id.replace(/\\/g, '/')
  const marker = '/node_modules/'
  const nodeModulesIndex = normalized.lastIndexOf(marker)
  if (nodeModulesIndex < 0) return null
  const parts = normalized.slice(nodeModulesIndex + marker.length).split('/')
  if (!parts[0]) return null
  return parts[0].startsWith('@') ? `${parts[0]}/${parts[1] || ''}` : parts[0]
}

function chartFrameAssetProtocolPlugin(): Plugin {
  let config: ResolvedConfig
  let shouldRewriteChartFrame = false

  return {
    name: 'chart-frame-asset-protocol',
    apply: 'build',
    configResolved(resolvedConfig) {
      config = resolvedConfig
      const input = resolvedConfig.build.rollupOptions.input
      shouldRewriteChartFrame = Boolean(input && typeof input === 'object' && !Array.isArray(input) && 'chartFrame' in input)
    },
    closeBundle() {
      if (!shouldRewriteChartFrame) return
      const chartFrameHtmlPath = resolve(config.root, config.build.outDir, 'chart-frame.html')
      let source: string
      try {
        source = readFileSync(chartFrameHtmlPath, 'utf8')
      } catch (error) {
        this.error(`Expected chart-frame.html to be emitted by the renderer build: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      const rewritten = source.replace(
        /(<script\b[^>]*\bsrc=")(\.\/assets\/chartFrame-[^"]+\.js)(")/,
        (_match, prefix: string, assetPath: string, suffix: string) => `${prefix}${chartFrameAssetUrl(assetPath)}${suffix}`,
      )
      if (rewritten === source) {
        this.error('Expected chart-frame.html to contain a bundled chartFrame module script')
        return
      }
      writeFileSync(chartFrameHtmlPath, rewritten)
    },
  }
}

export default defineConfig({
  build: {
    // Electron loads renderer chunks from local files. Disabling Vite's
    // modulepreload link generation keeps lazy feature chunks from becoming
    // startup dependencies when Rolldown shares preload bookkeeping.
    modulePreload: false,
    // Mermaid is loaded only after a diagram is rendered. Keep the warning
    // threshold above that isolated lazy chunk while still catching accidental
    // multi-megabyte growth elsewhere.
    chunkSizeWarningLimit: 3000,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        chartFrame: resolve(__dirname, 'chart-frame.html'),
      },
      output: {
        manualChunks(id) {
          const packageName = packageNameFromId(id)
          if (!packageName) return undefined
          if (packageName === 'vega-embed') return 'vendor-vega-embed'
          if (packageName === 'vega-lite') return 'vendor-vega-lite'
          if (packageName === 'vega') return 'vendor-vega-core'
          if (packageName === 'react'
            || packageName === 'react-dom'
            || packageName === 'scheduler'
            || packageName === 'zustand') {
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
    chartFrameAssetProtocolPlugin(),
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
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer'),
    },
  },
})
