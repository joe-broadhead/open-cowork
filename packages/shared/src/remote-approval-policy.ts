import type { ResourceAuthority } from './resource-identity.js'

export const REMOTE_APPROVAL_POLICY_VERSION = 1

export type RemoteInteractionKind = 'permission-approval' | 'question-reply' | 'question-reject'
export type RemoteApprovalPolicyMode =
  | 'local-confirmation'
  | 'cloud-rbac'
  | 'gateway-actor-rbac'
  | 'paired-local-confirmation'
  | 'blocked'

export interface RemoteApprovalPolicyInput {
  authority: ResourceAuthority
  interaction: RemoteInteractionKind
  actorAuthenticated: boolean
  actorWorkspaceMember?: boolean
  explicitRemoteApprovalEnabled?: boolean
  localUserPresent?: boolean
}

export interface RemoteApprovalPolicyDecision {
  version: typeof REMOTE_APPROVAL_POLICY_VERSION
  allowed: boolean
  mode: RemoteApprovalPolicyMode
  reasonCode: string
  requiresAudit: true
  requiresLocalConfirmation: boolean
}

export function evaluateRemoteApprovalPolicy(input: RemoteApprovalPolicyInput): RemoteApprovalPolicyDecision {
  const base = {
    version: REMOTE_APPROVAL_POLICY_VERSION,
    requiresAudit: true,
  } as const

  if (!input.actorAuthenticated) {
    return {
      ...base,
      allowed: false,
      mode: 'blocked',
      reasonCode: 'actor-not-authenticated',
      requiresLocalConfirmation: true,
    }
  }

  switch (input.authority) {
    case 'desktop-local':
      return {
        ...base,
        allowed: input.localUserPresent === true,
        mode: 'local-confirmation',
        reasonCode: input.localUserPresent ? 'desktop-local-user-confirmation-required' : 'desktop-local-user-not-present',
        requiresLocalConfirmation: true,
      }
    case 'paired-desktop':
      return {
        ...base,
        allowed: input.localUserPresent === true && input.explicitRemoteApprovalEnabled === true,
        mode: 'paired-local-confirmation',
        reasonCode: input.explicitRemoteApprovalEnabled
          ? 'paired-desktop-local-confirmation-required'
          : 'paired-desktop-remote-approval-disabled',
        requiresLocalConfirmation: true,
      }
    case 'desktop-cloud':
    case 'cloud-web':
      return {
        ...base,
        allowed: input.explicitRemoteApprovalEnabled === true && input.actorWorkspaceMember === true,
        mode: 'cloud-rbac',
        reasonCode: input.explicitRemoteApprovalEnabled
          ? 'cloud-rbac-workspace-membership-required'
          : 'cloud-remote-approval-disabled',
        requiresLocalConfirmation: false,
      }
    case 'cloud-channel-gateway':
    case 'standalone-gateway':
      return {
        ...base,
        allowed: input.explicitRemoteApprovalEnabled === true && input.actorWorkspaceMember === true,
        mode: 'gateway-actor-rbac',
        reasonCode: input.explicitRemoteApprovalEnabled
          ? 'gateway-actor-rbac-required'
          : 'gateway-remote-approval-disabled',
        requiresLocalConfirmation: false,
      }
  }
}
