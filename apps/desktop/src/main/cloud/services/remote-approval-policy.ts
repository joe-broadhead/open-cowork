import {
  evaluateRemoteApprovalPolicy,
  type RemoteApprovalPolicyDecision,
  type RemoteInteractionKind,
  type ResourceAuthority,
} from '@open-cowork/shared'
import type { CloudRuntimePolicy } from '../cloud-config.ts'
import { CloudServiceError } from '../cloud-service-error.ts'
import type { ControlPlaneStore } from '../control-plane-store.ts'
import type { CloudPrincipal } from '../session-service.ts'

export type RemoteInteractionPolicyInput = {
  sessionId: string
  commandId: string
  interaction: RemoteInteractionKind
  targetId: string
  authority?: Extract<ResourceAuthority, 'cloud-web' | 'cloud-channel-gateway'>
  actorWorkspaceMember?: boolean
  recordAllowedAudit?: boolean
  deniedEventType?: string
  targetType?: string
  auditTargetId?: string
}

export type RemoteInteractionAuditActor = {
  actorType: 'user' | 'api_token'
  actorId: string
  accountId: string | null
}

function remoteInteractionAuditEvent(interaction: RemoteInteractionKind) {
  switch (interaction) {
    case 'permission-approval':
      return 'cloud_interaction.permission.responded'
    case 'question-reject':
      return 'cloud_interaction.question.rejected'
    case 'question-reply':
      return 'cloud_interaction.question.replied'
  }
}

export async function assertRemoteApprovalInteractionAllowed(options: {
  store: ControlPlaneStore
  policy: CloudRuntimePolicy
  principal: CloudPrincipal
  orgId: string
  actor: RemoteInteractionAuditActor
  input: RemoteInteractionPolicyInput
  resolveActorWorkspaceMember: () => Promise<boolean>
}): Promise<RemoteApprovalPolicyDecision> {
  const {
    store,
    policy,
    principal,
    orgId,
    actor,
    input,
    resolveActorWorkspaceMember,
  } = options
  const authority = input.authority || 'cloud-web'
  const actorWorkspaceMember = input.actorWorkspaceMember ?? await resolveActorWorkspaceMember()
  const decision = evaluateRemoteApprovalPolicy({
    authority,
    interaction: input.interaction,
    actorAuthenticated: Boolean(principal.userId),
    actorWorkspaceMember,
    explicitRemoteApprovalEnabled: policy.allowRemoteApprovalResponses,
    localUserPresent: false,
  })
  if (!decision.allowed || input.recordAllowedAudit !== false) {
    await store.recordAuditEvent({
      orgId,
      accountId: actor.accountId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      eventType: decision.allowed
        ? remoteInteractionAuditEvent(input.interaction)
        : input.deniedEventType || 'cloud_interaction.remote_policy.denied',
      targetType: input.targetType || 'session',
      targetId: input.auditTargetId || input.sessionId,
      metadata: {
        sessionId: input.sessionId,
        commandId: input.commandId,
        targetId: input.targetId,
        interaction: input.interaction,
        authority,
        policyVersion: decision.version,
        policyMode: decision.mode,
        policyReasonCode: decision.reasonCode,
        explicitRemoteApprovalEnabled: policy.allowRemoteApprovalResponses,
        actorWorkspaceMember,
      },
    })
  }
  if (!decision.allowed) {
    throw new CloudServiceError(403, 'Remote question and approval responses are disabled for this cloud profile.', {
      policyCode: decision.reasonCode,
    })
  }
  return decision
}
