import { copyFile, mkdir } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const outfile = resolve(repoRoot, 'apps/desktop/dist/cloud/open-cowork-cloud.mjs')
const supervisorOutfile = resolve(repoRoot, 'apps/desktop/dist/cloud/runtime-managed-server-supervisor.js')
const cloudAssetsDir = resolve(repoRoot, 'apps/desktop/dist/cloud/assets')
const cloudReactClientAsset = 'open-cowork-cloud-react.js'
const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
])

// The cloud entrypoint reuses desktop configuration modules. Those modules
// guard Electron usage at runtime, so the server bundle only needs a tiny
// undefined-valued shim instead of shipping Electron in the production image.
const cloudElectronShimPlugin = {
  name: 'cloud-electron-shim',
  setup(buildContext) {
    buildContext.onResolve({ filter: /^electron$/ }, () => ({
      path: 'electron',
      namespace: 'cloud-electron-shim',
    }))
    buildContext.onLoad({ filter: /.*/, namespace: 'cloud-electron-shim' }, () => ({
      contents: [
        'export const app = undefined;',
        'export const safeStorage = undefined;',
        'export const net = undefined;',
        'export const protocol = undefined;',
        'export const shell = undefined;',
        'export const session = undefined;',
        'export const BrowserWindow = undefined;',
        'export const ipcMain = undefined;',
        'export const Menu = undefined;',
        'export const nativeImage = undefined;',
        'export const dialog = undefined;',
        'export const Notification = undefined;',
        'export const Tray = undefined;',
        'export const powerMonitor = undefined;',
        'export const utilityProcess = undefined;',
        'export default { app, safeStorage, net, protocol, shell, session, BrowserWindow, ipcMain, Menu, nativeImage, dialog, Notification, Tray, powerMonitor, utilityProcess };',
      ].join('\n'),
      loader: 'js',
    }))
  },
}

function runPnpm(args) {
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status ?? 'unknown'}`)
  }
}

runPnpm(['--filter', '@open-cowork/website', 'build'])

await mkdir(dirname(outfile), { recursive: true })
await mkdir(cloudAssetsDir, { recursive: true })

await build({
  entryPoints: [resolve(repoRoot, 'scripts/open-cowork-cloud.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  packages: 'external',
  external: [...builtins],
  plugins: [cloudElectronShimPlugin],
  logLevel: 'info',
})

await copyFile(
  resolve(repoRoot, 'apps/website/dist/client', cloudReactClientAsset),
  resolve(cloudAssetsDir, cloudReactClientAsset),
)

await build({
  entryPoints: [resolve(repoRoot, 'apps/desktop/src/main/runtime-managed-server-supervisor.ts')],
  outfile: supervisorOutfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  external: [...builtins],
  logLevel: 'info',
})
