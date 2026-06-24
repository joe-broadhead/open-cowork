// Wires Electron-backed implementations into the shared injection seams
// (@open-cowork/shared/node) at desktop startup. Imported early as a side effect by
// the `config-loader.ts` shim, so the hosts are set before any lazy read (config
// path resolution, credential encrypt/decrypt). The cloud server never loads this
// module's Electron values — build-cloud's Electron shim makes `app`/`safeStorage`
// undefined, so the hosts stay null and every consumer takes its Electron-free
// fallback/guard, exactly as before. Keeping all desktop Electron-host wiring in one
// place keeps the config core and the credential stores import-`electron`-free.
import electron from 'electron'
import { setAppPathHost, setSafeStorageHost } from '@open-cowork/shared/node'

const electronApp = (electron as { app?: typeof import('electron').app }).app
setAppPathHost(electronApp ?? null)

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
