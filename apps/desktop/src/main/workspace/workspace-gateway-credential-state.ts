import type {
  WorkspaceInfo,
  WorkspaceStatus,
} from '@open-cowork/shared'
import type {
  GatewayWorkspaceCredentialClearResult,
  GatewayWorkspaceCredentialReadFailure,
  GatewayWorkspaceCredentialStore,
} from '../gateway-workspace-credentials.ts'
import {
  normalizeGatewayWorkspaceBaseUrl,
  type GatewayWorkspaceConnectionRecord,
} from '../gateway-workspace-registry.ts'

export type WorkspaceRegistration = Omit<WorkspaceInfo, 'active'>

export function gatewayCredentialReadError(result: GatewayWorkspaceCredentialReadFailure) {
  if (result.status === 'unavailable') {
    return 'Gateway credential storage is temporarily unavailable. The stored bytes were preserved; retry or use the explicit recovery action.'
  }
  return 'Gateway credential storage needs recovery. The stored bytes were preserved; use the explicit credential recovery action.'
}

export function gatewayCredentialFailureWorkspaceStatus(
  failure: GatewayWorkspaceCredentialReadFailure,
): WorkspaceStatus {
  return failure.status === 'corrupt' ? 'error' : 'offline'
}

export class GatewayCredentialStorageReadError extends Error {
  readonly failure: GatewayWorkspaceCredentialReadFailure

  constructor(failure: GatewayWorkspaceCredentialReadFailure) {
    super(gatewayCredentialReadError(failure))
    this.name = 'GatewayCredentialStorageReadError'
    this.failure = failure
  }
}

export function assertGatewayCredentialCleared(result: GatewayWorkspaceCredentialClearResult) {
  if (result.status === 'unavailable') {
    throw new Error('Gateway credential storage is temporarily unavailable. The credential was preserved; retry sign-out later.')
  }
  if (result.status === 'corrupt') {
    throw new Error('Gateway credential storage needs recovery. The credential was preserved and sign-out did not complete.')
  }
}

export function gatewayRegistrationFromConnection(
  connection: GatewayWorkspaceConnectionRecord,
  status: WorkspaceStatus = 'auth_required',
): WorkspaceRegistration {
  return {
    id: connection.id,
    kind: 'gateway',
    authority: 'gateway_standalone',
    label: connection.label,
    status,
    baseUrl: connection.baseUrl,
    lastSyncedAt: connection.lastSyncedAt,
    gatewayCredentialStatus: 'missing',
    error: status === 'auth_required'
      ? 'Add a Gateway workspace token to enable this private Gateway connection.'
      : null,
  }
}

export function gatewayConnectionFromWorkspace(
  workspace: WorkspaceRegistration,
): GatewayWorkspaceConnectionRecord {
  if (workspace.kind !== 'gateway' || !workspace.baseUrl) {
    throw new Error('Gateway workspace requires a base URL.')
  }
  const timestamp = new Date(0).toISOString()
  return {
    id: workspace.id,
    baseUrl: normalizeGatewayWorkspaceBaseUrl(workspace.baseUrl),
    label: workspace.label,
    lastSyncedAt: workspace.lastSyncedAt || null,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

export function applyGatewayCredentialStatus(
  workspace: WorkspaceRegistration,
  credentialStore: GatewayWorkspaceCredentialStore | null,
): WorkspaceRegistration {
  if (workspace.kind !== 'gateway') return workspace
  const tokenResult = credentialStore?.getToken(workspace.id)
  if (!tokenResult || tokenResult.status === 'missing') {
    return {
      ...workspace,
      gatewayCredentialStatus: 'missing',
    }
  }
  if (tokenResult.status !== 'available') {
    return {
      ...workspace,
      status: gatewayCredentialFailureWorkspaceStatus(tokenResult),
      gatewayCredentialStatus: tokenResult.status,
      error: gatewayCredentialReadError(tokenResult),
    }
  }
  return {
    ...workspace,
    status: 'online',
    gatewayCredentialStatus: 'available',
    error: null,
  }
}

export function resetGatewayCredentialWorkspaceStates(
  workspaces: Map<string, WorkspaceRegistration>,
) {
  for (const [workspaceId, workspace] of workspaces.entries()) {
    if (workspace.kind !== 'gateway') continue
    workspaces.set(workspaceId, {
      ...workspace,
      status: 'auth_required',
      gatewayCredentialStatus: 'missing',
      error: 'Gateway credentials were reset after storage recovery. Add a new token to reconnect.',
    })
  }
}
