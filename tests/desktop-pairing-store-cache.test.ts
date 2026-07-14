import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  FileDesktopPairingStore,
  buildDesktopPairingRecord,
} from '../apps/desktop/src/main/desktop-pairing/store.ts'

function record(id: string) {
  return buildDesktopPairingRecord({
    id,
    now: new Date('2026-06-24T00:00:00.000Z'),
    create: { label: `Pairing ${id}`, enabled: true },
  })
}

function stateFile(path: string, ids: string[]) {
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, pairings: ids.map(record), audit: [] }), { mode: 0o600 })
}

test('FileDesktopPairingStore serves its own writes through the cache', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'oc-pairing-')), 'pairings.json')
  const store = new FileDesktopPairingStore(path)

  store.save(record('alpha'))
  assert.deepEqual(store.list().map((entry) => entry.id), ['alpha'])
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).schemaVersion, 1)

  store.save(record('beta'))
  assert.deepEqual(store.list().map((entry) => entry.id).sort(), ['alpha', 'beta'])

  assert.equal(store.remove('alpha'), true)
  assert.deepEqual(store.list().map((entry) => entry.id), ['beta'])
})

test('FileDesktopPairingStore re-reads when the file mtime changes out of band', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'oc-pairing-')), 'pairings.json')
  const past = new Date('2026-06-24T00:00:00.000Z')
  stateFile(path, ['alpha'])
  utimesSync(path, past, past)

  const store = new FileDesktopPairingStore(path)
  // First read populates the cache keyed on the (past) mtime.
  assert.deepEqual(store.list().map((entry) => entry.id), ['alpha'])

  // Replace the file out of band and advance the mtime well past the cached one.
  stateFile(path, ['alpha', 'beta'])
  const future = new Date('2026-06-24T01:00:00.000Z')
  utimesSync(path, future, future)

  assert.deepEqual(store.list().map((entry) => entry.id).sort(), ['alpha', 'beta'])
})

test('FileDesktopPairingStore quarantines a parseable non-current schema', () => {
  const root = mkdtempSync(join(tmpdir(), 'oc-pairing-schema-'))
  const path = join(root, 'pairings.json')
  try {
    writeFileSync(path, JSON.stringify({ schemaVersion: 2, pairings: [record('alpha')], audit: [] }))

    const store = new FileDesktopPairingStore(path)
    assert.deepEqual(store.list(), [])
    assert.equal(existsSync(path), false)
    assert.equal(existsSync(`${path}.corrupt`), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('FileDesktopPairingStore rejects missing persisted policy fields instead of enabling remote control defaults', () => {
  const root = mkdtempSync(join(tmpdir(), 'oc-pairing-policy-'))
  const path = join(root, 'pairings.json')
  try {
    const incomplete = record('alpha') as ReturnType<typeof record> & { policy: Partial<ReturnType<typeof record>['policy']> }
    delete incomplete.policy.allowRemotePrompts
    delete incomplete.policy.allowRemoteAbort
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, pairings: [incomplete], audit: [] }))

    const store = new FileDesktopPairingStore(path)
    assert.deepEqual(store.list(), [])
    assert.equal(existsSync(path), false)
    assert.equal(existsSync(`${path}.corrupt`), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('FileDesktopPairingStore rejects non-exact persisted audit entries', () => {
  const root = mkdtempSync(join(tmpdir(), 'oc-pairing-audit-schema-'))
  const path = join(root, 'pairings.json')
  try {
    const store = new FileDesktopPairingStore(path)
    store.appendAudit({
      id: 'audit-1',
      pairingId: 'alpha',
      action: 'pairing.created',
      actorId: null,
      actorLabel: null,
      workspaceId: null,
      sessionId: null,
      commandId: null,
      reason: null,
      createdAt: '2026-06-24T00:00:00.000Z',
    })
    const state = JSON.parse(readFileSync(path, 'utf8')) as {
      schemaVersion: number
      pairings: unknown[]
      audit: Array<Record<string, unknown>>
    }
    state.audit[0] = { ...state.audit[0], legacyActor: 'operator' }
    writeFileSync(path, JSON.stringify(state))

    const reloaded = new FileDesktopPairingStore(path)
    assert.deepEqual(reloaded.listAudit(), [])
    assert.equal(existsSync(path), false)
    assert.equal(existsSync(`${path}.corrupt`), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
