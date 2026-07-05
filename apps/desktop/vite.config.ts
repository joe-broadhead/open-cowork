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
    // Mermaid/vega are loaded only after a diagram is rendered (lazy chunks).
    // Keep the warning threshold low so accidental multi-hundred-KB growth on
    // the eager startup path surfaces in the build log; the CI-enforced eager
    // budget lives in scripts/check-bundle-size.mjs (browser build).
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        loading: resolve(__dirname, 'loading.html'),
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
        // Supervisor source now lives in @open-cowork/runtime-host; the desktop still
        // emits it as a sibling of the built main bundle so the Electron utilityProcess
        // forker (resolveManagedOpencodeSupervisorPath) finds it next to main.
        entry: '../../packages/runtime-host/src/runtime-managed-server-supervisor.ts',
        vite: {
          build: {
            outDir: 'dist/main',
            rollupOptions: {
              external: ['electron'],
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
      // The unified renderer now lives in the shared @open-cowork/app package.
      // The Electron build keeps its root + vite-plugin-electron wiring here and
      // consumes the renderer source through this alias so packaging and the
      // main process's renderer load paths stay unchanged.
      '@': resolve(__dirname, '../../packages/app/src'),
    },
  },
  server: {
    // Dev mode serves the renderer from packages/app, which is outside this
    // config's root (apps/desktop). Allow Vite to read the workspace root so the
    // HTML entries' ../../packages/app/src/* scripts resolve during `vite`.
    fs: {
      allow: [resolve(__dirname, '../..')],
    },
  },
})
