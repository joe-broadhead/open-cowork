import type {
  GovernanceAuditActor,
  GovernanceGroup,
  GovernanceIncidentControlKind,
  GovernanceOrganization,
  GovernanceOwner,
  GovernancePrincipal,
  GovernanceRole,
  GovernanceSubjectKind,
} from '@open-cowork/shared'
import { COWORK_GOVERNANCE_SCHEMA_VERSION } from '@open-cowork/shared'

const INCIDENT_CONTROL_ROLES: Record<GovernanceIncidentControlKind, GovernanceRole[]> = {
  pause_agent: ['admin', 'owner', 'approver'],
  retire_agent: ['admin', 'owner', 'approver'],
  pause_crew: ['admin', 'owner', 'approver'],
  retire_crew: ['admin', 'owner', 'approver'],
  quarantine_memory: ['admin', 'owner', 'approver'],
  revoke_tool: ['admin', 'approver'],
  export_audit: ['admin', 'approver', 'viewer'],
}

export type GovernanceIncidentPolicyOutcome = 'allowed' | 'denied'

export interface GovernanceIncidentPolicyDecision {
  schemaVersion: number
  subjectKind: GovernanceSubjectKind
  subjectId: string
  action: GovernanceIncidentControlKind
  outcome: GovernanceIncidentPolicyOutcome
  reason: string
  requiredRoles: GovernanceRole[]
  actor: GovernanceAuditActor
  actorRoles: GovernanceRole[]
}

export const LOCAL_GOVERNANCE_OWNER: GovernanceOwner = {
  kind: 'user',
  id: 'local-user',
  displayName: 'Local user',
}

export const LOCAL_GOVERNANCE_ORGANIZATION: GovernanceOrganization = {
  schemaVersion: COWORK_GOVERNANCE_SCHEMA_VERSION,
  id: 'local-organization',
  tenantId: 'local-tenant',
  displayName: 'Local Open Cowork',
  mode: 'local',
}

export const LOCAL_GOVERNANCE_ADMIN_GROUP: GovernanceGroup = {
  kind: 'group',
  id: 'local-admins',
  displayName: 'Local administrators',
  roles: ['admin', 'owner', 'approver'],
}

export const SYSTEM_GOVERNANCE_OWNER: GovernanceOwner = {
  kind: 'system',
  id: 'open-cowork',
  displayName: 'Open Cowork',
}

export const LOCAL_GOVERNANCE_PRINCIPAL: GovernancePrincipal = {
  ...LOCAL_GOVERNANCE_OWNER,
  roles: ['admin', 'approver', 'owner'],
  groupIds: [LOCAL_GOVERNANCE_ADMIN_GROUP.id],
}

export const LOCAL_GOVERNANCE_APPROVERS: GovernanceOwner[] = [
  LOCAL_GOVERNANCE_OWNER,
  LOCAL_GOVERNANCE_ADMIN_GROUP,
]

export function listLocalGovernancePrincipals(): GovernancePrincipal[] {
  return [{
    ...LOCAL_GOVERNANCE_PRINCIPAL,
    roles: [...LOCAL_GOVERNANCE_PRINCIPAL.roles],
    groupIds: [...LOCAL_GOVERNANCE_PRINCIPAL.groupIds],
  }]
}

export function listLocalGovernanceGroups(): GovernanceGroup[] {
  return [{
    ...LOCAL_GOVERNANCE_ADMIN_GROUP,
    roles: [...LOCAL_GOVERNANCE_ADMIN_GROUP.roles],
  }]
}

export function governancePrincipalToAuditActor(principal: GovernancePrincipal): GovernanceAuditActor {
  return {
    kind: principal.kind,
    id: principal.id,
    displayName: principal.displayName,
  }
}

function hasRole(principal: GovernancePrincipal, role: GovernanceRole) {
  return principal.roles.includes(role)
}

function principalMatchesOwner(principal: GovernancePrincipal, owner?: GovernanceOwner | null) {
  if (!owner) return false
  if (principal.kind === owner.kind && principal.id === owner.id) return true
  return owner.kind === 'group' && principal.groupIds.includes(owner.id)
}

function ownsSubject(principal: GovernancePrincipal, owner?: GovernanceOwner | null) {
  return principalMatchesOwner(principal, owner)
}

function approvesSubject(principal: GovernancePrincipal, approvers: GovernanceOwner[] = []) {
  return approvers.some((approver) => principalMatchesOwner(principal, approver))
}

export function requiredRolesForGovernanceIncident(action: GovernanceIncidentControlKind): GovernanceRole[] {
  return [...INCIDENT_CONTROL_ROLES[action]]
}

export function decideGovernanceIncidentControl(input: {
  actor?: GovernancePrincipal | null
  action: GovernanceIncidentControlKind
  subjectKind: GovernanceSubjectKind
  subjectId: string
  owner?: GovernanceOwner | null
  approvers?: GovernanceOwner[]
}): GovernanceIncidentPolicyDecision {
  const actor = input.actor || LOCAL_GOVERNANCE_PRINCIPAL
  const requiredRoles = requiredRolesForGovernanceIncident(input.action)
  const allowed = hasRole(actor, 'admin')
    || (requiredRoles.includes('approver') && (hasRole(actor, 'approver') || approvesSubject(actor, input.approvers)))
    || (requiredRoles.includes('owner') && ownsSubject(actor, input.owner))
    || (requiredRoles.includes('viewer') && hasRole(actor, 'viewer'))

  return {
    schemaVersion: COWORK_GOVERNANCE_SCHEMA_VERSION,
    subjectKind: input.subjectKind,
    subjectId: input.subjectId,
    action: input.action,
    outcome: allowed ? 'allowed' : 'denied',
    reason: allowed
      ? 'Actor is authorized for this governance incident control.'
      : `Actor ${actor.id} is not authorized to ${input.action.replace(/_/g, ' ')}.`,
    requiredRoles,
    actor: governancePrincipalToAuditActor(actor),
    actorRoles: [...actor.roles],
  }
}

export function assertGovernanceIncidentControlAllowed(
  decision: GovernanceIncidentPolicyDecision,
) {
  if (decision.outcome === 'denied') throw new Error(decision.reason)
}
