import test from 'node:test'
import assert from 'node:assert/strict'

import { Phase0ControlPlaneProofStore } from '../apps/desktop/src/main/cloud/phase0-control-plane.ts'

test('phase0 control plane rejects stale worker writes after lease reassignment', () => {
  const store = new Phase0ControlPlaneProofStore()
  const first = store.claimSession('session-1', 'worker-a', new Date('2026-01-01T00:00:00.000Z'), 1000)
  assert.ok(first)
  assert.deepEqual(store.writeProjection(first, 1), { sessionId: 'session-1', projectionSeq: 1 })

  const blocked = store.claimSession('session-1', 'worker-b', new Date('2026-01-01T00:00:00.500Z'), 1000)
  assert.equal(blocked, null)

  const second = store.claimSession('session-1', 'worker-b', new Date('2026-01-01T00:00:02.000Z'), 1000)
  assert.ok(second)
  assert.throws(() => store.writeProjection(first, 2), /stale/i)
  assert.deepEqual(store.writeProjection(second, 2), { sessionId: 'session-1', projectionSeq: 2 })
})

test('phase0 control plane fences checkpoint versions', () => {
  const store = new Phase0ControlPlaneProofStore()
  const lease = store.claimSession('session-1', 'worker-a', new Date('2026-01-01T00:00:00.000Z'), 1000)
  assert.ok(lease)

  const checkpointed = store.checkpoint(lease)
  assert.equal(checkpointed.checkpointVersion, 1)
  assert.throws(() => store.writeProjection(lease, 1), /checkpoint/i)
  assert.deepEqual(store.writeProjection(checkpointed, 1), { sessionId: 'session-1', projectionSeq: 1 })
})

test('phase0 commands are idempotent and reject conflicting command id reuse', () => {
  const store = new Phase0ControlPlaneProofStore()
  const command = store.enqueueCommand({
    commandId: 'cmd-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-1',
    kind: 'prompt',
    payload: { text: 'hello' },
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  })
  assert.equal(command.status, 'pending')
  assert.equal(command.createdSeq, 1)

  const replay = store.enqueueCommand({
    commandId: 'cmd-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-1',
    kind: 'prompt',
    payload: { text: 'hello' },
    createdAt: new Date('2026-01-01T00:01:00.000Z'),
  })
  assert.deepEqual(replay, command)

  assert.throws(() => store.enqueueCommand({
    commandId: 'cmd-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-1',
    kind: 'prompt',
    payload: { text: 'different' },
  }), /reused/)
})

test('phase0 command delivery requires current lease and supports ack replay', () => {
  const store = new Phase0ControlPlaneProofStore()
  const firstLease = store.claimSession('session-1', 'worker-a', new Date('2026-01-01T00:00:00.000Z'), 1000)
  assert.ok(firstLease)
  store.enqueueCommand({
    commandId: 'cmd-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-1',
    kind: 'question.reply',
    payload: { requestId: 'q1', answers: ['yes'] },
    targetLeaseToken: firstLease.leaseToken,
  })

  const claimed = store.claimNextCommand(firstLease)
  assert.equal(claimed?.commandId, 'cmd-1')
  assert.equal(claimed?.status, 'running')

  const secondLease = store.claimSession('session-1', 'worker-b', new Date('2026-01-01T00:00:02.000Z'), 1000)
  assert.ok(secondLease)
  assert.throws(() => store.ackCommand(firstLease, 'cmd-1'), /stale/i)

  const targetLocked = store.claimNextCommand(secondLease)
  assert.equal(targetLocked, null)

  const late = store.enqueueCommand({
    commandId: 'cmd-2',
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-1',
    kind: 'abort',
    payload: {},
  })
  assert.equal(late.status, 'pending')
  assert.equal(store.claimNextCommand(secondLease)?.commandId, 'cmd-2')
  const acked = store.ackCommand(secondLease, 'cmd-2', new Date('2026-01-01T00:00:03.000Z'))
  assert.equal(acked.status, 'acked')
  assert.equal(store.ackCommand(secondLease, 'cmd-2').ackedAt, '2026-01-01T00:00:03.000Z')
})
