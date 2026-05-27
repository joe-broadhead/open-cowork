import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { FileCloudWorkspaceCredentialStore } from '../apps/desktop/src/main/cloud-workspace-credentials.ts'

function credentialPath() {
  return join(mkdtempSync(join(tmpdir(), 'open-cowork-cloud-credentials-')), 'cloud-workspace-credentials.json')
}

function encryptedStorage() {
  return {
    mode: 'encrypted' as const,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${Buffer.from(plaintext, 'utf-8').toString('base64')}`, 'utf-8'),
    decryptString: (encrypted: Buffer) => {
      const raw = encrypted.toString('utf-8')
      assert.ok(raw.startsWith('encrypted:'))
      return Buffer.from(raw.slice('encrypted:'.length), 'base64').toString('utf-8')
    },
  }
}

test('cloud workspace credential store encrypts tokens and exposes metadata separately', () => {
  const path = credentialPath()
  const store = new FileCloudWorkspaceCredentialStore({ path, secretStorage: encryptedStorage() })
  const saved = store.save({
    workspaceId: 'cloud:test',
    accessToken: 'access-token-secret',
    refreshToken: 'refresh-token-secret',
    expiresAt: '2026-05-27T12:00:00.000Z',
  }, new Date('2026-05-27T10:00:00.000Z'))

  assert.equal(saved.workspaceId, 'cloud:test')
  assert.equal(store.get('cloud:test')?.accessToken, 'access-token-secret')
  assert.deepEqual(store.listMetadata(), [{
    workspaceId: 'cloud:test',
    hasAccessToken: true,
    hasRefreshToken: true,
    expiresAt: '2026-05-27T12:00:00.000Z',
    updatedAt: '2026-05-27T10:00:00.000Z',
  }])

  const stored = readFileSync(path, 'utf-8')
  assert.equal(stored.includes('access-token-secret'), false)
  assert.equal(stored.includes('refresh-token-secret'), false)
})

test('cloud workspace credential store returns only non-expired access tokens', () => {
  const path = credentialPath()
  const store = new FileCloudWorkspaceCredentialStore({ path, secretStorage: encryptedStorage() })
  store.save({
    workspaceId: 'cloud:test',
    accessToken: 'access-token-secret',
    expiresAt: '2026-05-27T12:00:00.000Z',
  }, new Date('2026-05-27T10:00:00.000Z'))

  assert.equal(store.getUsableAccessToken('cloud:test', new Date('2026-05-27T11:59:00.000Z')), 'access-token-secret')
  assert.equal(store.getUsableAccessToken('cloud:test', new Date('2026-05-27T11:59:40.000Z')), null)
})

test('cloud workspace credential store removes workspace credentials', () => {
  const path = credentialPath()
  const store = new FileCloudWorkspaceCredentialStore({ path, secretStorage: encryptedStorage() })
  store.save({
    workspaceId: 'cloud:test',
    accessToken: 'access-token-secret',
    expiresAt: '2026-05-27T12:00:00.000Z',
  }, new Date('2026-05-27T10:00:00.000Z'))

  assert.equal(store.remove('cloud:test'), true)
  assert.equal(store.get('cloud:test'), null)
  assert.equal(store.remove('cloud:test'), false)
})

test('cloud workspace credential store fails closed when secure storage is unavailable', () => {
  const path = credentialPath()
  const store = new FileCloudWorkspaceCredentialStore({
    path,
    secretStorage: {
      mode: 'unavailable',
      encryptString: () => Buffer.from(''),
      decryptString: () => '',
    },
  })

  assert.throws(
    () => store.save({
      workspaceId: 'cloud:test',
      accessToken: 'access-token-secret',
      expiresAt: '2026-05-27T12:00:00.000Z',
    }),
    /Secure storage unavailable/,
  )
})
