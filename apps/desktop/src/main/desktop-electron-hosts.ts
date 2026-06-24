// Wires Electron-backed implementations into the shared injection seams
// (@open-cowork/shared/node) at desktop startup. Imported as the FIRST side-effect of
// the desktop entry (index.ts), so the hosts are set before any lazy read (config
// path resolution, credential encrypt/decrypt, log destination). The cloud server
// never loads this module's Electron values — build-cloud's Electron shim makes
// `app`/`safeStorage` undefined, so the hosts stay null and every consumer takes its
// Electron-free fallback/guard, exactly as before. Keeping all desktop Electron-host
// wiring in one place keeps the config core and the credential stores
// import-`electron`-free.
import electron from 'electron'
import { setAppPathHost, setDesktopShellHost, setLogStorage, setSafeStorageHost } from '@open-cowork/shared/node'
import { getAppDataDir, getLogFilePrefix } from '@open-cowork/runtime-host/config'

const electronApp = (electron as { app?: typeof import('electron').app }).app
setAppPathHost(electronApp ?? null)

// Wire the logger's destination from the (Electron-free) config core. Lazy, so it
// reads getAppDataDir only on the first file write — after setAppPathHost above.
setLogStorage(() => ({ directory: getAppDataDir(), filePrefix: getLogFilePrefix() }))

const electronShell = (electron as { shell?: typeof import('electron').shell }).shell
const electronBrowserWindow = (electron as { BrowserWindow?: typeof import('electron').BrowserWindow }).BrowserWindow
setDesktopShellHost(
  electronShell || electronApp || electronBrowserWindow
    ? {
        openExternal: (url) => electronShell?.openExternal(url),
        setLoginItemSettings: (settings) => electronApp?.setLoginItemSettings?.(settings),
        broadcastToRenderers: (channel, ...args) => {
          for (const win of electronBrowserWindow?.getAllWindows() ?? []) {
            if (!win.isDestroyed()) win.webContents.send(channel, ...args)
          }
        },
      }
    : null,
)

const electronSafeStorage = (electron as {
  safeStorage?: typeof import('electron').safeStorage & { getSelectedStorageBackend?: () => string }
}).safeStorage
setSafeStorageHost(
  electronSafeStorage
    ? {
        isEncryptionAvailable: () => electronSafeStorage.isEncryptionAvailable(),
        encryptString: (plainText) => electronSafeStorage.encryptString(plainText),
        decryptString: (encrypted) => electronSafeStorage.decryptString(encrypted),
        getSelectedStorageBackend: electronSafeStorage.getSelectedStorageBackend
          ? () => electronSafeStorage.getSelectedStorageBackend!()
          : undefined,
      }
    : null,
)
