import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'vite-plugin-electron'
import { resolve } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import type { Plugin, ResolvedConfig } from 'vite'
import { chartFrameAssetUrl } from './src/lib/chart-frame-assets'
import { rendererWorkspaceSourceAliases } from '../../packages/app/vite.workspace-source-aliases'
import { electronWorkspaceSourceViteConfig } from './vite.electron-workspace-source-aliases'

const repoRoot = resolve(__dirname, '../..')
let electronDevelopmentGeneration = 0
let electronRestartQueue = Promise.resolve()
let electronRestartTimer: NodeJS.Timeout | null = null
let latestElectronStartup: (() => Promise<boolean>) | null = null

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

async function performElectronRestart(startup: () => Promise<boolean>) {
  const currentApp = process.electronApp
  if (currentApp && currentApp.exitCode === null && currentApp.signalCode === null) {
    // vite-plugin-electron's default restart starts the replacement immediately
    // after signalling the old process. On macOS that races Electron's
    // single-instance lock and can make the replacement exit, taking Vite with
    // it. Detach the plugin's process.exit listener and wait for the old app.
    currentApp.removeListener('exit', process.exit)
    await new Promise<void>((resolveRestart, rejectRestart) => {
      const timeout = setTimeout(() => {
        currentApp.removeListener('exit', handleExit)
        rejectRestart(new Error('Timed out waiting for Electron to exit during development restart'))
      }, 10_000)
      const handleExit = () => {
        clearTimeout(timeout)
        resolveRestart()
      }
      currentApp.once('exit', handleExit)
      if (!currentApp.kill()) {
        clearTimeout(timeout)
        currentApp.removeListener('exit', handleExit)
        resolveRestart()
      }
    })
  }
  const started = await startup()
  if (started && process.electronApp) {
    electronDevelopmentGeneration += 1
    if (process.env.OPEN_COWORK_DEV_SMOKE === '1') {
      process.stdout.write(
        `[desktop-dev] electron generation=${electronDevelopmentGeneration} pid=${process.electronApp.pid}\n`,
      )
    }
  }
}

function restartElectronAfterExit(startup: () => Promise<boolean>) {
  latestElectronStartup = startup
  if (electronRestartTimer) clearTimeout(electronRestartTimer)
  electronRestartTimer = setTimeout(() => {
    electronRestartTimer = null
    const queuedStartup = latestElectronStartup
    if (!queuedStartup) return
    electronRestartQueue = electronRestartQueue
      .catch(() => undefined)
      .then(() => performElectronRestart(queuedStartup))
    void electronRestartQueue.catch((error) => {
      process.stderr.write(
        `[desktop-dev] Electron restart failed: ${error instanceof Error ? error.message : String(error)}\n`,
      )
    })
  }, 500)
}

export default defineConfig(({ command }) => {
  const electronWorkspaceVite = electronWorkspaceSourceViteConfig(repoRoot, command)

  return {
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
          }
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
          onstart(args) {
            restartElectronAfterExit(args.startup)
          },
          vite: {
            ...electronWorkspaceVite,
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
            ...electronWorkspaceVite,
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
            ...electronWorkspaceVite,
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
      alias: [
        ...(command === 'serve'
          ? [
              ...rendererWorkspaceSourceAliases(repoRoot),
              // HTML entrypoints resolve their relative ../../packages/app imports to
              // /packages/app/src/* in development. Map that URL prefix to the real
              // workspace owner instead of asking Vite to find it under apps/desktop.
              { find: '/packages/app/src', replacement: resolve(__dirname, '../../packages/app/src') },
              // Vite optimizes React from the desktop root before it follows renderer
              // source imports. React is owned by @open-cowork/app, so point bare React
              // imports (including jsx-runtime and react-dom/client subpaths) at that
              // workspace's declared dependency instead of relying on pnpm hoisting.
              { find: 'react', replacement: resolve(__dirname, '../../packages/app/node_modules/react') },
              { find: 'react-dom', replacement: resolve(__dirname, '../../packages/app/node_modules/react-dom') },
            ]
          : []),
        // The unified renderer lives in the shared @open-cowork/app package.
        { find: '@', replacement: resolve(__dirname, '../../packages/app/src') },
      ],
    },
    server: {
      // Dev mode serves the renderer from packages/app, which is outside this
      // config's root (apps/desktop). Allow Vite to read the workspace root so the
      // HTML entries' ../../packages/app/src/* scripts resolve during `vite`.
      fs: {
        allow: [repoRoot],
      },
    },
  }
})
