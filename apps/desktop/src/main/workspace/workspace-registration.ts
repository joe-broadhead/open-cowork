import type {
  DesktopPairingPublicRecord,
  WorkspaceStatus,
} from '@open-cowork/shared'
import {
  normalizeCloudWorkspaceBaseUrl,
  type CloudWorkspaceConnectionRecord,
} from '../cloud-workspace-registry.ts'
import type { WorkspaceRegistration } from './workspace-gateway-credential-state.ts'

export const LOCAL_WORKSPACE_ID = 'local'

export const LOCAL_WORKSPACE: WorkspaceRegistration = {
  id: LOCAL_WORKSPACE_ID,
  kind: 'local',
  authority: 'desktop_local',
  label: 'Local',
  status: 'online',
  lastSyncedAt: null,
}

export function normalizeDesktopWorkspaceId(workspaceId?: string | null) {
  if (workspaceId === undefined || workspaceId === null || workspaceId === '') return null
  const trimmed = workspaceId.trim()
  if (!trimmed) return null
  if (Buffer.byteLength(trimmed, 'utf8') > 512) {
    throw new Error('Workspace id is too large.')
  }
  return trimmed
}

export function readWorkspaceIdOption(input: unknown): string | null {
  if (input === undefined || input === null) return null
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Workspace options must be an object when provided.')
  }
  const workspaceId = (input as { workspaceId?: unknown }).workspaceId
  if (workspaceId === undefined || workspaceId === null || workspaceId === '') return null
  if (typeof workspaceId !== 'string') throw new Error('Workspace id must be a string.')
  return normalizeDesktopWorkspaceId(workspaceId)
}

export function cloudRegistrationFromConnection(
  connection: CloudWorkspaceConnectionRecord,
): WorkspaceRegistration {
  return {
    id: connection.id,
    kind: 'cloud',
    authority: 'cloud_worker',
    label: connection.label,
    status: 'auth_required',
    baseUrl: connection.baseUrl,
    tenantId: connection.tenantId,
    userId: connection.userId,
    profileName: connection.profileName,
    lastSyncedAt: connection.lastSyncedAt,
    error: 'Sign in to this cloud workspace to enable sync.',
  }
}

export function cloudConnectionFromWorkspace(
  workspace: WorkspaceRegistration,
): CloudWorkspaceConnectionRecord {
  if (workspace.kind !== 'cloud' || !workspace.baseUrl) {
    throw new Error('Cloud workspace requires a base URL.')
  }
  const timestamp = new Date(0).toISOString()
  return {
    id: workspace.id,
    baseUrl: normalizeCloudWorkspaceBaseUrl(workspace.baseUrl),
    label: workspace.label,
    tenantId: workspace.tenantId,
    userId: workspace.userId,
    profileName: workspace.profileName,
    lastSyncedAt: workspace.lastSyncedAt || null,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

export function pairedWorkspaceId(pairingId: string) {
  return `paired-desktop:${pairingId}`
}

export function pairedRegistrationFromRecord(
  record: DesktopPairingPublicRecord,
): WorkspaceRegistration {
  const isOnline = record.enabled && !record.revokedAt && record.status === 'paired_online'
  const isRevoked = record.revokedAt || record.status === 'revoked'
  const status: WorkspaceStatus = isRevoked
    ? 'disabled'
    : isOnline
      ? 'online'
      : record.enabled
        ? 'offline'
        : 'disabled'
  const allowedSessions = record.allowedSessionIds === null
    ? 'all allowed sessions'
    : `${record.allowedSessionIds.length} allowed session${record.allowedSessionIds.length === 1 ? '' : 's'}`
  return {
    id: pairedWorkspaceId(record.id),
    kind: 'paired_desktop',
    authority: 'desktop_paired',
    label: record.label || record.deviceName || 'Paired Desktop',
    status,
    lastSyncedAt: record.lastHeartbeatAt || record.lastConnectedAt || null,
    error: isRevoked
      ? 'This Desktop pairing has been revoked.'
      : record.error || (status === 'offline' ? 'Paired Desktop connector is offline; remote mutations are disabled.' : null),
    profileName: allowedSessions,
  }
}
