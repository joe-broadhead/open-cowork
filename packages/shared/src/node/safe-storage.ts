/// <reference types="node" />
// Injected OS credential-encryption seam (Electron `safeStorage`), shared by the
// settings store, the cloud/gateway workspace credential stores, and the workflow
// secret store. These modules historically imported `electron` solely for
// `safeStorage` (encrypt/decrypt BYOK credentials + report the selected backend);
// injecting that exact surface here keeps them Electron-free and package-resolvable
// WITHOUT changing any encryption behavior — the desktop wires Electron's real
// `safeStorage`, so credentials are encrypted/decrypted identically. The cloud (and
// node:test) leave the host unset; each module's existing "safeStorage unavailable"
// guard then applies, exactly as when `electron.safeStorage` was undefined under the
// build-cloud shim. This is pure dependency injection, not a crypto change.
export type SafeStorageHost = {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
  getSelectedStorageBackend?(): string
}

let safeStorageHost: SafeStorageHost | null = null

export function setSafeStorageHost(host: SafeStorageHost | null) {
  safeStorageHost = host
}

export function getSafeStorageHost(): SafeStorageHost | null {
  return safeStorageHost
}
