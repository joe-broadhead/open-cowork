import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createWorkClaimToken,
  nowIso,
  stableId,
  stableJson,
  workspaceOperationFromType,
} from '../apps/desktop/src/main/cloud/postgres-store-id-helpers.ts'

// Focused coverage for the pure id / stable-JSON / hash / classification helpers
// extracted from postgres-control-plane-store.ts.

test('nowIso serializes a provided Date and falls back to now', () => {
  assert.equal(nowIso(new Date('2026-01-02T03:04:05.000Z')), '2026-01-02T03:04:05.000Z')
  assert.match(nowIso(undefined), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
})

test('stableJson is key-order independent and recursive', () => {
  assert.equal(stableJson({ b: 1, a: 2 }), stableJson({ a: 2, b: 1 }))
  assert.equal(stableJson({ a: { y: 1, x: 2 } }), '{"a":{"x":2,"y":1}}')
  assert.equal(stableJson([3, { b: 1, a: 2 }]), '[3,{"a":2,"b":1}]')
  // Distinct shapes serialize distinctly.
  assert.notEqual(stableJson({ a: 1 }), stableJson({ a: '1' }))
})

test('stableId is deterministic, prefixed, and a 32-hex digest', () => {
  const id = stableId('work', 'tenant', 'unit')
  assert.match(id, /^work_[0-9a-f]{32}$/)
  assert.equal(stableId('work', 'tenant', 'unit'), id)
  assert.notEqual(stableId('work', 'tenant', 'other'), id)
  // NUL-joined, so ['a','b'] and ['ab'] do not collide.
  assert.notEqual(stableId('work', 'ab'), stableId('work', 'a', 'b'))
})

test('createWorkClaimToken is claim-prefixed and unique per call', () => {
  const a = createWorkClaimToken('t', 'w', 'me')
  const b = createWorkClaimToken('t', 'w', 'me')
  assert.match(a, /^claim_[0-9a-f]{32}$/)
  // Salted with random bytes, so identical inputs still yield distinct tokens.
  assert.notEqual(a, b)
})

test('workspaceOperationFromType classifies create/delete/update', () => {
  assert.equal(workspaceOperationFromType('artifact.created'), 'create')
  assert.equal(workspaceOperationFromType('session.submitted'), 'create')
  assert.equal(workspaceOperationFromType('thread.deleted'), 'delete')
  assert.equal(workspaceOperationFromType('channel.archived'), 'delete')
  assert.equal(workspaceOperationFromType('member.renamed'), 'update')
  assert.equal(workspaceOperationFromType('anything.else'), 'update')
})
