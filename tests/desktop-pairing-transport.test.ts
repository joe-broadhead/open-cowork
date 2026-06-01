import test from 'node:test'
import assert from 'node:assert/strict'
import type { DesktopPairingRecord } from '../packages/shared/src/desktop-pairing.ts'
import { DEFAULT_DESKTOP_PAIRING_POLICY } from '../packages/shared/src/desktop-pairing.ts'
import { HttpDesktopPairingTransport } from '../apps/desktop/src/main/desktop-pairing/transport.ts'

function record(brokerUrl: string): DesktopPairingRecord {
  return {
    id: 'pairing-1',
    label: 'Phone',
    deviceName: 'Desktop',
    status: 'paired_offline',
    enabled: true,
    brokerUrl,
    allowedWorkspaceIds: ['local'],
    allowedSessionIds: null,
    policy: DEFAULT_DESKTOP_PAIRING_POLICY,
    lastConnectedAt: null,
    lastHeartbeatAt: null,
    lastCommandSequence: 0,
    error: null,
    createdAt: '2026-06-01T12:00:00.000Z',
    updatedAt: '2026-06-01T12:00:00.000Z',
    revokedAt: null,
  }
}

test('desktop pairing HTTP transport blocks metadata and private broker targets before sending the token', async () => {
  let fetches = 0
  const transport = new HttpDesktopPairingTransport({
    fetchImpl: async () => {
      fetches += 1
      return new Response(null, { status: 204 })
    },
  })

  await assert.rejects(
    () => transport.heartbeat({
      record: record('http://169.254.169.254/latest/meta-data'),
      credential: { pairingId: 'pairing-1', deviceId: 'device-1', token: 'secret-token', updatedAt: '2026-06-01T12:00:00.000Z' },
    }),
    /Desktop pairing broker URL is not allowed/,
  )
  assert.equal(fetches, 0)
})

test('desktop pairing HTTP transport keeps the explicit localhost development exception', async () => {
  let requestedUrl = ''
  const transport = new HttpDesktopPairingTransport({
    fetchImpl: async (url) => {
      requestedUrl = String(url)
      return new Response(null, { status: 204 })
    },
  })

  await transport.heartbeat({
    record: record('http://localhost:8787'),
    credential: { pairingId: 'pairing-1', deviceId: 'device-1', token: 'secret-token', updatedAt: '2026-06-01T12:00:00.000Z' },
  })

  assert.equal(requestedUrl, 'http://localhost:8787/api/desktop-pairing/heartbeat')
})
