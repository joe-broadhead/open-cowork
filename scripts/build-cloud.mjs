import { mkdir } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const outfile = resolve(repoRoot, 'apps/desktop/dist/cloud/open-cowork-cloud.mjs')
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

await mkdir(dirname(outfile), { recursive: true })

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
