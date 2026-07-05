// The Electron named exports the cloud build stubs (see the `cloud-electron-shim`
// plugin in scripts/build-cloud.mjs). The cloud server reuses desktop
// config/runtime modules that `import { … } from 'electron'`; the cloud image
// ships NO Electron, so the shim provides undefined-valued stand-ins those
// modules guard at runtime. Single-sourced here so the build and the
// server→Electron boundary test (tests/cloud-server-electron-boundary.test.ts)
// agree on exactly which names are stubbed — adding an Electron import of a name
// not in this list to a cloud-reachable module would ship `undefined` to the
// cloud server, and the boundary test fails before that can happen.
export const CLOUD_ELECTRON_SHIM_EXPORTS = [
  'app',
  'safeStorage',
  'net',
  'protocol',
  'shell',
  'session',
  'BrowserWindow',
  'ipcMain',
  'Menu',
  'nativeImage',
  'dialog',
  'Notification',
  'Tray',
  'powerMonitor',
  'utilityProcess',
]
