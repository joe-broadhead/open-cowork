import assert from 'node:assert/strict'
import test from 'node:test'
import type { DesktopPairingPublicRecord } from '@open-cowork/shared'
import {
  LOCAL_WORKSPACE,
  LOCAL_WORKSPACE_ID,
  cloudConnectionFromWorkspace,
  cloudRegistrationFromConnection,
  normalizeDesktopWorkspaceId,
  pairedRegistrationFromRecord,
  pairedWorkspaceId,
  readWorkspaceIdOption,
} from '../apps/desktop/src/main/workspace/workspace-registration.ts'

function pairingRecord(
  overrides: Partial<DesktopPairingPublicRecord> = {},
): DesktopPairingPublicRecord {
  return {
    id: 'pairing-1',
    label: 'Phone Gateway',
    deviceName: 'Phone',
    status: 'paired_online',
    enabled: true,
    brokerUrl: 'https://gateway.example.test',
    allowedWorkspaceIds: ['local'],
    allowedSessionIds: ['session-1'],
    policy: {
      allowRemotePrompts: true,
      allowRemoteAbort: true,
      remoteApprovals: 'local_confirmation',
      remoteQuestions: 'local_confirmation',
      exposeArtifactBodies: false,
      exposeLocalPaths: false,
      exposeLocalMcpDetails: false,
      allowRemoteAttachments: false,
    },
    lastConnectedAt: '2026-05-27T10:00:00.000Z',
    lastHeartbeatAt: '2026-05-27T10:01:00.000Z',
    lastCommandSequence: 7,
    error: null,
    createdAt: '2026-05-27T09:00:00.000Z',
    updatedAt: '2026-05-27T10:01:00.000Z',
    revokedAt: null,
    credential: {
      hasToken: true,
      deviceId: 'device-1',
      updatedAt: '2026-05-27T09:00:00.000Z',
    },
    ...overrides,
  }
}

test('workspace registration exposes the exact local identity', () => {
  assert.equal(LOCAL_WORKSPACE_ID, 'local')
  assert.deepEqual(LOCAL_WORKSPACE, {
    id: 'local',
    kind: 'local',
    authority: 'desktop_local',
    label: 'Local',
    status: 'online',
    lastSyncedAt: null,
  })
})

test('workspace id normalization is bounded and option parsing stays fail-closed', () => {
  assert.equal(normalizeDesktopWorkspaceId(undefined), null)
  assert.equal(normalizeDesktopWorkspaceId(null), null)
  assert.equal(normalizeDesktopWorkspaceId(''), null)
  assert.equal(normalizeDesktopWorkspaceId('   '), null)
  assert.equal(normalizeDesktopWorkspaceId(' local '), 'local')
  assert.throws(() => normalizeDesktopWorkspaceId('😀'.repeat(129)), /too large/)

  assert.equal(readWorkspaceIdOption(undefined), null)
  assert.equal(readWorkspaceIdOption(null), null)
  assert.equal(readWorkspaceIdOption({}), null)
  assert.equal(readWorkspaceIdOption({ workspaceId: '' }), null)
  assert.equal(readWorkspaceIdOption({ workspaceId: ' cloud:test ' }), 'cloud:test')
  assert.throws(() => readWorkspaceIdOption([]), /must be an object/)
  assert.throws(() => readWorkspaceIdOption('local'), /must be an object/)
  assert.throws(() => readWorkspaceIdOption({ workspaceId: 42 }), /must be a string/)
})

test('cloud connection and registration mappings preserve metadata and normalize URLs', () => {
  const connection = {
    id: 'cloud:test',
    baseUrl: 'https://cloud.example.test/admin',
    label: 'Test Cloud',
    tenantId: 'tenant-1',
    userId: 'user-1',
    profileName: 'reviewer',
    lastSyncedAt: '2026-05-27T10:00:00.000Z',
    createdAt: '2026-05-27T09:00:00.000Z',
    updatedAt: '2026-05-27T10:00:00.000Z',
  }

  assert.deepEqual(cloudRegistrationFromConnection(connection), {
    id: 'cloud:test',
    kind: 'cloud',
    authority: 'cloud_worker',
    label: 'Test Cloud',
    status: 'auth_required',
    baseUrl: 'https://cloud.example.test/admin',
    tenantId: 'tenant-1',
    userId: 'user-1',
    profileName: 'reviewer',
    lastSyncedAt: '2026-05-27T10:00:00.000Z',
    error: 'Sign in to this cloud workspace to enable sync.',
  })

  assert.deepEqual(cloudConnectionFromWorkspace({
    id: 'cloud:test',
    kind: 'cloud',
    authority: 'cloud_worker',
    label: 'Test Cloud',
    status: 'online',
    baseUrl: 'https://cloud.example.test/admin/?token=secret#fragment',
    tenantId: 'tenant-1',
    userId: 'user-1',
    profileName: 'reviewer',
    lastSyncedAt: '2026-05-27T10:00:00.000Z',
  }), {
    id: 'cloud:test',
    baseUrl: 'https://cloud.example.test/admin',
    label: 'Test Cloud',
    tenantId: 'tenant-1',
    userId: 'user-1',
    profileName: 'reviewer',
    lastSyncedAt: '2026-05-27T10:00:00.000Z',
    createdAt: '1970-01-01T00:00:00.000Z',
    updatedAt: '1970-01-01T00:00:00.000Z',
  })

  assert.throws(() => cloudConnectionFromWorkspace({
    ...LOCAL_WORKSPACE,
    baseUrl: 'https://cloud.example.test',
  }), /requires a base URL/)
})

test('paired registration mapping covers online, offline, disabled, and revoked identities', () => {
  assert.equal(pairedWorkspaceId('pairing-1'), 'paired-desktop:pairing-1')
  assert.deepEqual(pairedRegistrationFromRecord(pairingRecord()), {
    id: 'paired-desktop:pairing-1',
    kind: 'paired_desktop',
    authority: 'desktop_paired',
    label: 'Phone Gateway',
    status: 'online',
    lastSyncedAt: '2026-05-27T10:01:00.000Z',
    error: null,
    profileName: '1 allowed session',
  })
  assert.deepEqual(pairedRegistrationFromRecord(pairingRecord({
    label: '',
    status: 'paired_offline',
    lastHeartbeatAt: null,
    allowedSessionIds: null,
  })), {
    id: 'paired-desktop:pairing-1',
    kind: 'paired_desktop',
    authority: 'desktop_paired',
    label: 'Phone',
    status: 'offline',
    lastSyncedAt: '2026-05-27T10:00:00.000Z',
    error: 'Paired Desktop connector is offline; remote mutations are disabled.',
    profileName: 'all allowed sessions',
  })
  assert.equal(pairedRegistrationFromRecord(pairingRecord({
    enabled: false,
    allowedSessionIds: [],
  })).status, 'disabled')
  assert.deepEqual(pairedRegistrationFromRecord(pairingRecord({
    status: 'revoked',
    revokedAt: '2026-05-27T11:00:00.000Z',
  })), {
    id: 'paired-desktop:pairing-1',
    kind: 'paired_desktop',
    authority: 'desktop_paired',
    label: 'Phone Gateway',
    status: 'disabled',
    lastSyncedAt: '2026-05-27T10:01:00.000Z',
    error: 'This Desktop pairing has been revoked.',
    profileName: '1 allowed session',
  })
})
