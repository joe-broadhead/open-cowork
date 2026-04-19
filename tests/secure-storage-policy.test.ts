import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveSecretStorageMode } from '../apps/desktop/src/main/secure-storage-policy.ts'

test('resolveSecretStorageMode prefers encrypted storage whenever safeStorage is available', () => {
  assert.equal(resolveSecretStorageMode({ isPackaged: false, encryptionAvailable: true }), 'encrypted')
  assert.equal(resolveSecretStorageMode({ isPackaged: true, encryptionAvailable: true }), 'encrypted')
})

test('resolveSecretStorageMode only allows plaintext secret storage in development', () => {
  assert.equal(resolveSecretStorageMode({ isPackaged: false, encryptionAvailable: false }), 'plaintext')
  assert.equal(resolveSecretStorageMode({ isPackaged: true, encryptionAvailable: false }), 'unavailable')
})
