import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs'
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
  writeFileSync(path, JSON.stringify({ pairings: ids.map(record), audit: [] }), { mode: 0o600 })
}

test('FileDesktopPairingStore serves its own writes through the cache', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'oc-pairing-')), 'pairings.json')
  const store = new FileDesktopPairingStore(path)

  store.save(record('alpha'))
  assert.deepEqual(store.list().map((entry) => entry.id), ['alpha'])

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
