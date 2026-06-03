import type { MessageAttachment, SessionInfo } from './session.js'

export const DESKTOP_PAIRING_COMMAND_KINDS = [
  'create_session',
  'prompt',
  'abort',
  'permission.respond',
  'question.reply',
  'question.reject',
  'status',
  'revoke_pairing',
] as const

export type DesktopPairingCommandKind = typeof DESKTOP_PAIRING_COMMAND_KINDS[number]

export type DesktopPairingConnectionStatus =
  | 'paired_online'
  | 'paired_offline'
  | 'disabled'
  | 'revoked'
  | 'error'

export type DesktopPairingDecisionPolicy = 'disabled' | 'local_confirmation' | 'remote_allowed'

export type DesktopPairingPolicy = {
  allowRemotePrompts: boolean
  allowRemoteAbort: boolean
  remoteApprovals: DesktopPairingDecisionPolicy
  remoteQuestions: DesktopPairingDecisionPolicy
  exposeArtifactBodies: boolean
  exposeLocalPaths: boolean
  exposeLocalMcpDetails: boolean
  allowRemoteAttachments: boolean
}

export type DesktopPairingRecord = {
  id: string
  label: string
  deviceName: string
  status: DesktopPairingConnectionStatus
  enabled: boolean
  brokerUrl: string | null
  allowedWorkspaceIds: string[]
  allowedSessionIds: string[] | null
  policy: DesktopPairingPolicy
  lastConnectedAt: string | null
  lastHeartbeatAt: string | null
  lastCommandSequence: number
  error: string | null
  createdAt: string
  updatedAt: string
  revokedAt: string | null
}

export type DesktopPairingPublicRecord = DesktopPairingRecord & {
  credential: {
    hasToken: boolean
    deviceId: string | null
    updatedAt: string | null
  }
}

export type DesktopPairingCreateInput = {
  label: string
  deviceName?: string
  brokerUrl?: string | null
  enabled?: boolean
  allowedWorkspaceIds?: string[]
  allowedSessionIds?: string[] | null
  policy?: Partial<DesktopPairingPolicy>
}

export type DesktopPairingCreated = {
  record: DesktopPairingPublicRecord
  pairingToken: string
}

export type DesktopPairingUpdateInput = {
  label?: string
  deviceName?: string
  brokerUrl?: string | null
  enabled?: boolean
  allowedWorkspaceIds?: string[]
  allowedSessionIds?: string[] | null
  policy?: Partial<DesktopPairingPolicy>
}

export type DesktopPairingCredentialMetadata = {
  pairingId: string
  deviceId: string
  hasToken: boolean
  updatedAt: string
}

export type DesktopPairingCommandLease = {
  leasedBy: string
  leaseToken: string
  leaseExpiresAt: string
}

export type DesktopPairingCommand = {
  id: string
  kind: DesktopPairingCommandKind
  pairingId: string
  workspaceId: string
  sessionId?: string | null
  actorId?: string | null
  actorLabel?: string | null
  payload?: Record<string, unknown>
  sequence: number
  createdAt: string
  lease?: DesktopPairingCommandLease
}

export type DesktopPairingCommandClaimRequest = {
  pairingId: string
  deviceId: string
  afterSequence: number
  limit: number
  leaseSeconds: number
  capabilities: {
    commands: DesktopPairingCommandKind[]
    workspaces: string[]
    policy: DesktopPairingPolicy
  }
}

export type DesktopPairingCommandClaimResult = {
  commands: DesktopPairingCommand[]
  remoteStatus?: 'online' | 'offline' | 'revoked' | 'draining'
}

export const DESKTOP_PAIRING_PROJECTION_FENCE_UNSUPPORTED = {
  supported: false,
  reasonCode: 'desktop_pairing_projection_fence_unsupported',
  message: 'Paired Desktop command results are lease-fenced but do not expose a projection checkpoint.',
  waitable: false,
} as const

export type DesktopPairingProjectionFenceStatus = typeof DESKTOP_PAIRING_PROJECTION_FENCE_UNSUPPORTED

export type DesktopPairingCommandResult = {
  ok: boolean
  status: 'completed' | 'queued' | 'blocked_by_policy' | 'requires_local_confirmation' | 'failed'
  session?: SessionInfo | null
  sessions?: SessionInfo[]
  message?: string | null
  projectionFence?: null
  projectionFenceStatus?: DesktopPairingProjectionFenceStatus
  data?: Record<string, unknown>
}

export type DesktopPairingRemoteEvent = {
  id: string
  pairingId: string
  type:
    | 'heartbeat'
    | 'command.accepted'
    | 'command.completed'
    | 'command.failed'
    | 'session.event'
    | 'audit'
    | 'status'
  workspaceId?: string
  sessionId?: string | null
  commandId?: string | null
  sequence?: number
  occurredAt: string
  payload?: Record<string, unknown>
}

export type DesktopPairingAuditAction =
  | 'pairing.created'
  | 'pairing.updated'
  | 'pairing.enabled'
  | 'pairing.disabled'
  | 'pairing.connected'
  | 'pairing.offline'
  | 'pairing.revoked'
  | 'command.accepted'
  | 'command.completed'
  | 'command.failed'
  | 'command.blocked'
  | 'remote.event.published'

export type DesktopPairingAuditEvent = {
  id: string
  pairingId: string
  action: DesktopPairingAuditAction
  actorId?: string | null
  actorLabel?: string | null
  workspaceId?: string | null
  sessionId?: string | null
  commandId?: string | null
  reason?: string | null
  metadata?: Record<string, unknown>
  createdAt: string
}

export type DesktopPairingPromptPayload = {
  text: string
  agent?: string | null
  attachments?: MessageAttachment[]
  variant?: string | null
}

export type DesktopPairingStatusSnapshot = {
  pairingId: string
  status: DesktopPairingConnectionStatus
  enabled: boolean
  lastConnectedAt: string | null
  lastHeartbeatAt: string | null
  lastCommandSequence: number
  error: string | null
}

export const DEFAULT_DESKTOP_PAIRING_POLICY: DesktopPairingPolicy = {
  allowRemotePrompts: true,
  allowRemoteAbort: true,
  remoteApprovals: 'local_confirmation',
  remoteQuestions: 'local_confirmation',
  exposeArtifactBodies: false,
  exposeLocalPaths: false,
  exposeLocalMcpDetails: false,
  allowRemoteAttachments: false,
}
