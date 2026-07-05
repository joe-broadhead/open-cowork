import { readSafeStorageBackendForPolicy, resolveSecretStorageMode } from '@open-cowork/runtime-host/secure-storage-policy'
import test from 'node:test'
import assert from 'node:assert/strict'
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

test('readSafeStorageBackendForPolicy probes only Linux safeStorage backends', () => {
  let calls = 0
  const readBackend = () => {
    calls += 1
    return 'basic_text'
  }

  assert.equal(readSafeStorageBackendForPolicy(readBackend, 'darwin'), null)
  assert.equal(readSafeStorageBackendForPolicy(readBackend, 'win32'), null)
  assert.equal(calls, 0)
  assert.equal(readSafeStorageBackendForPolicy(readBackend, 'linux'), 'basic_text')
  assert.equal(calls, 1)
})

test('readSafeStorageBackendForPolicy fails closed when backend probing throws', () => {
  assert.equal(readSafeStorageBackendForPolicy(() => {
    throw new Error('backend unavailable')
  }, 'linux'), null)
})
