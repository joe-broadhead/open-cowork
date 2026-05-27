import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  FileCloudWorkspaceRegistry,
  cloudWorkspaceIdForBaseUrl,
  normalizeCloudWorkspaceBaseUrl,
} from '../apps/desktop/src/main/cloud-workspace-registry.ts'

function registryPath() {
  return join(mkdtempSync(join(tmpdir(), 'open-cowork-cloud-workspaces-')), 'cloud-workspaces.json')
}

test('cloud workspace registry normalizes and persists non-secret connections', () => {
  const path = registryPath()
  const registry = new FileCloudWorkspaceRegistry(path)
  const createdAt = new Date('2026-05-27T10:00:00.000Z')
  const record = registry.upsert({
    baseUrl: 'https://cloud.example.test/api/?token=secret#fragment',
    label: ' Acme Cloud ',
  }, createdAt)

  assert.equal(record.id, cloudWorkspaceIdForBaseUrl('https://cloud.example.test/api'))
  assert.equal(record.baseUrl, 'https://cloud.example.test/api')
  assert.equal(record.label, 'Acme Cloud')
  assert.equal(record.lastSyncedAt, null)
  assert.equal(record.createdAt, createdAt.toISOString())

  const reloaded = new FileCloudWorkspaceRegistry(path).list()
  assert.deepEqual(reloaded, [record])
  const stored = readFileSync(path, 'utf-8')
  assert.equal(stored.includes('token=secret'), false)
  assert.equal(stored.includes('refreshToken'), false)
})

test('cloud workspace registry updates existing connections without changing id', () => {
  const path = registryPath()
  const registry = new FileCloudWorkspaceRegistry(path)
  const first = registry.upsert({ baseUrl: 'https://cloud.example.test', label: 'First' }, new Date('2026-05-27T10:00:00.000Z'))
  const second = registry.upsert({ baseUrl: 'https://cloud.example.test/', label: 'Second' }, new Date('2026-05-27T11:00:00.000Z'))

  assert.equal(second.id, first.id)
  assert.equal(second.label, 'Second')
  assert.equal(second.createdAt, first.createdAt)
  assert.equal(second.updatedAt, '2026-05-27T11:00:00.000Z')
  assert.equal(registry.list().length, 1)
})

test('cloud workspace registry tracks sync timestamps and removes records', () => {
  const path = registryPath()
  const registry = new FileCloudWorkspaceRegistry(path)
  const record = registry.upsert({ baseUrl: 'https://cloud.example.test' }, new Date('2026-05-27T10:00:00.000Z'))

  const touched = registry.touchSync(record.id, '2026-05-27T12:00:00.000Z', new Date('2026-05-27T12:00:01.000Z'))
  assert.equal(touched?.lastSyncedAt, '2026-05-27T12:00:00.000Z')
  assert.equal(touched?.updatedAt, '2026-05-27T12:00:01.000Z')
  assert.equal(registry.remove(record.id), true)
  assert.deepEqual(registry.list(), [])
  assert.equal(registry.remove(record.id), false)
})

test('cloud workspace registry rejects unsupported URL schemes', () => {
  assert.throws(() => normalizeCloudWorkspaceBaseUrl('file:///tmp/open-cowork'), /https/)
})

test('cloud workspace registry rejects cleartext non-loopback cloud URLs', () => {
  assert.throws(
    () => normalizeCloudWorkspaceBaseUrl('http://cloud.example.test'),
    /https, except for localhost/,
  )
  assert.equal(
    normalizeCloudWorkspaceBaseUrl('http://localhost:8787/api?token=secret#frag'),
    'http://localhost:8787/api',
  )
  assert.equal(
    normalizeCloudWorkspaceBaseUrl('http://127.0.0.1:8787'),
    'http://127.0.0.1:8787',
  )
})
