import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_DESKTOP_PAIRING_POLICY } from '../packages/shared/src/desktop-pairing.ts'
import {
  buildDesktopPairingRecord,
  normalizeDesktopPairingBrokerUrl,
  updateDesktopPairingRecord,
} from '../apps/desktop/src/main/desktop-pairing/store.ts'
import { resolveDesktopPairingBrokerUrl } from '../apps/desktop/src/main/desktop-pairing/broker-url-policy.ts'

test('desktop pairing broker URL persistence rejects literal metadata and private targets', () => {
  for (const url of [
    'http://169.254.169.254/latest/meta-data',
    'https://169.254.169.254/latest/meta-data',
    'https://10.0.0.1/broker',
    'https://192.168.1.10/broker',
    'https://[fd00::1]/broker',
  ]) {
    assert.throws(
      () => normalizeDesktopPairingBrokerUrl(url),
      /metadata|private|cloud|not allowed|URL targets/i,
      `expected ${url} to be rejected`,
    )
  }
})

test('desktop pairing broker URL persistence keeps localhost development and public HTTPS URLs', () => {
  assert.equal(normalizeDesktopPairingBrokerUrl('http://localhost:8787///'), 'http://localhost:8787')
  assert.equal(normalizeDesktopPairingBrokerUrl('https://broker.example.test/path?token=secret#frag'), 'https://broker.example.test/path')
})

test('desktop pairing broker URL persistence rejects embedded URL credentials', () => {
  for (const url of [
    'https://user:password@broker.example.test',
    'http://user:password@localhost:8787',
  ]) {
    assert.throws(
      () => normalizeDesktopPairingBrokerUrl(url),
      /embedded credentials/i,
      `expected ${url} to be rejected`,
    )
  }
})

test('desktop pairing create and update reject disallowed broker URLs before saving records', () => {
  assert.throws(
    () => buildDesktopPairingRecord({
      id: 'pairing-1',
      now: new Date('2026-06-01T12:00:00.000Z'),
      create: {
        label: 'Phone',
        brokerUrl: 'https://192.168.1.10/broker',
        allowedWorkspaceIds: ['local'],
      },
    }),
    /private/i,
  )

  const existing = {
    id: 'pairing-1',
    label: 'Phone',
    deviceName: 'Desktop',
    status: 'disabled' as const,
    enabled: false,
    brokerUrl: 'https://broker.example.test',
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

  assert.throws(
    () => updateDesktopPairingRecord(existing, { brokerUrl: 'http://169.254.169.254/latest/meta-data' }),
    /metadata/i,
  )
})

test('desktop pairing broker URL resolution rejects public hostnames that resolve private', async () => {
  await assert.rejects(
    () => resolveDesktopPairingBrokerUrl('https://broker.example.test', {
      resolveHostname: async () => [{ address: '10.0.0.5', family: 4 }],
    }),
    /resolves to a private/i,
  )
})
