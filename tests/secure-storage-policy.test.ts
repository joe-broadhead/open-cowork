import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveSecretStorageMode } from '../apps/desktop/src/main/secure-storage-policy.ts'

test('resolveSecretStorageMode prefers encrypted storage whenever protective safeStorage is available', () => {
  assert.equal(resolveSecretStorageMode({ isPackaged: false, encryptionAvailable: true }), 'encrypted')
  assert.equal(resolveSecretStorageMode({ isPackaged: true, encryptionAvailable: true }), 'encrypted')
  assert.equal(resolveSecretStorageMode({
    isPackaged: true,
    encryptionAvailable: true,
    selectedStorageBackend: 'gnome_libsecret',
  }), 'encrypted')
  assert.equal(resolveSecretStorageMode({
    isPackaged: true,
    encryptionAvailable: true,
    selectedStorageBackend: 'kwallet',
  }), 'encrypted')
})

test('resolveSecretStorageMode only allows plaintext secret storage in development', () => {
  assert.equal(resolveSecretStorageMode({ isPackaged: false, encryptionAvailable: false }), 'plaintext')
  assert.equal(resolveSecretStorageMode({ isPackaged: true, encryptionAvailable: false }), 'unavailable')
})

test('resolveSecretStorageMode treats Linux basic_text as non-protective', () => {
  assert.equal(resolveSecretStorageMode({
    isPackaged: false,
    encryptionAvailable: true,
    selectedStorageBackend: 'basic_text',
  }), 'plaintext')
  assert.equal(resolveSecretStorageMode({
    isPackaged: true,
    encryptionAvailable: true,
    selectedStorageBackend: 'basic_text',
  }), 'unavailable')
})
