import { resolve } from 'node:path'
import type { Plugin } from 'vite'

export type ElectronWorkspaceSourceAlias = {
  find: RegExp
  replacement: string
}

export type ElectronWorkspaceSourceViteConfig = {
  plugins?: Plugin[]
  resolve?: {
    alias: ElectronWorkspaceSourceAlias[]
  }
}

const ELECTRON_SOURCE_WORKSPACES = [
  'packages/cloud-client',
  'packages/cloud-server',
  'packages/runtime-host',
  'packages/shared',
]

export function assertElectronWorkspaceSourceModule(repoRoot: string, id: string) {
  const normalizedId = id.split('?', 1)[0]?.replaceAll('\\', '/') || ''
  for (const workspace of ELECTRON_SOURCE_WORKSPACES) {
    const distRoot = `${resolve(repoRoot, workspace, 'dist').replaceAll('\\', '/')}/`
    if (normalizedId.startsWith(distRoot)) {
      throw new Error(
        `Electron development resolved ${normalizedId} through an ignored dist artifact`,
      )
    }
  }
}

/**
 * Electron's development builders run independently from the root workspace
 * build. Resolve the desktop's Node-side workspace imports to their TypeScript
 * owners so a clean checkout never depends on ignored dist artifacts.
 *
 * Production deliberately keeps package-export resolution: the root build owns
 * its topological artifact preparation and packaging behavior stays unchanged.
 */
export function electronWorkspaceSourceViteConfig(
  repoRoot: string,
  command: 'build' | 'serve',
): ElectronWorkspaceSourceViteConfig {
  if (command === 'build') return {}

  return {
    plugins: [
      {
        name: 'electron-workspace-source-boundary',
        enforce: 'post',
        load(id) {
          assertElectronWorkspaceSourceModule(repoRoot, id)
          return null
        },
      },
    ],
    resolve: {
      alias: [
        {
          find: /^@open-cowork\/cloud-client\/(.+)$/,
          replacement: resolve(repoRoot, 'packages/cloud-client/src/$1.ts'),
        },
        {
          find: /^@open-cowork\/cloud-client$/,
          replacement: resolve(repoRoot, 'packages/cloud-client/src/index.ts'),
        },
        {
          find: /^@open-cowork\/cloud-server\/(.+)$/,
          replacement: resolve(repoRoot, 'packages/cloud-server/src/$1.ts'),
        },
        {
          find: /^@open-cowork\/cloud-server$/,
          replacement: resolve(repoRoot, 'packages/cloud-server/src/index.ts'),
        },
        {
          find: /^@open-cowork\/runtime-host\/(.+)$/,
          replacement: resolve(repoRoot, 'packages/runtime-host/src/$1.ts'),
        },
        {
          find: /^@open-cowork\/runtime-host$/,
          replacement: resolve(repoRoot, 'packages/runtime-host/src/index.ts'),
        },
        {
          find: /^@open-cowork\/shared\/node$/,
          replacement: resolve(repoRoot, 'packages/shared/src/node/index.ts'),
        },
        {
          find: /^@open-cowork\/shared\/(.+)$/,
          replacement: resolve(repoRoot, 'packages/shared/src/$1.ts'),
        },
        {
          find: /^@open-cowork\/shared$/,
          replacement: resolve(repoRoot, 'packages/shared/src/index.ts'),
        },
      ],
    },
  }
}
