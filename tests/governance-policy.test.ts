import test from 'node:test'
import assert from 'node:assert/strict'
import type { GovernanceOwner, GovernancePrincipal } from '../packages/shared/src/governance.ts'
import {
  LOCAL_GOVERNANCE_PRINCIPAL,
  decideGovernanceIncidentControl,
  requiredRolesForGovernanceIncident,
} from '../apps/desktop/src/main/governance-policy.ts'

const owner: GovernanceOwner = {
  kind: 'user',
  id: 'owner-1',
  displayName: 'Owner 1',
}

const viewer: GovernancePrincipal = {
  kind: 'user',
  id: 'viewer-1',
  displayName: 'Viewer 1',
  roles: ['viewer'],
  groupIds: [],
}

test('default local governance principal can run incident controls', () => {
  const decision = decideGovernanceIncidentControl({
    action: 'revoke_tool',
    subjectKind: 'tool',
    subjectId: 'tool:warehouse',
    owner,
    approvers: [],
  })

  assert.equal(decision.outcome, 'allowed')
  assert.equal(decision.actor.id, LOCAL_GOVERNANCE_PRINCIPAL.id)
  assert.deepEqual(decision.requiredRoles, ['admin', 'approver'])
})

test('viewer role can export audit but cannot mutate incidents', () => {
  assert.equal(decideGovernanceIncidentControl({
    actor: viewer,
    action: 'export_audit',
    subjectKind: 'crew',
    subjectId: 'crew:analytics',
    owner,
    approvers: [],
  }).outcome, 'allowed')

  assert.equal(decideGovernanceIncidentControl({
    actor: viewer,
    action: 'pause_agent',
    subjectKind: 'agent',
    subjectId: 'agent:machine:data-analyst',
    owner,
    approvers: [],
  }).outcome, 'denied')
})

test('subject owners and approvers can run matching owner-scoped controls', () => {
  const subjectOwner: GovernancePrincipal = {
    ...owner,
    roles: ['viewer'],
    groupIds: [],
  }
  const subjectApprover: GovernancePrincipal = {
    kind: 'user',
    id: 'approver-1',
    displayName: 'Approver 1',
    roles: ['viewer'],
    groupIds: [],
  }

  assert.equal(decideGovernanceIncidentControl({
    actor: subjectOwner,
    action: 'pause_agent',
    subjectKind: 'agent',
    subjectId: 'agent:machine:data-analyst',
    owner,
    approvers: [],
  }).outcome, 'allowed')

  assert.equal(decideGovernanceIncidentControl({
    actor: subjectOwner,
    action: 'pause_agent',
    subjectKind: 'agent',
    subjectId: 'agent:machine:data-analyst',
    owner: { ...owner, id: 'different-owner' },
    approvers: [],
  }).outcome, 'denied')

  assert.equal(decideGovernanceIncidentControl({
    actor: subjectApprover,
    action: 'retire_crew',
    subjectKind: 'crew',
    subjectId: 'crew:analytics',
    owner,
    approvers: [subjectApprover],
  }).outcome, 'allowed')
})

test('subject group owners and approvers authorize matching user principals', () => {
  const groupMember: GovernancePrincipal = {
    kind: 'user',
    id: 'analyst-1',
    displayName: 'Analyst 1',
    roles: ['viewer'],
    groupIds: ['security'],
  }
  const securityGroup: GovernanceOwner = {
    kind: 'group',
    id: 'security',
    displayName: 'Security',
  }

  assert.equal(decideGovernanceIncidentControl({
    actor: groupMember,
    action: 'pause_agent',
    subjectKind: 'agent',
    subjectId: 'agent:machine:data-analyst',
    owner: securityGroup,
    approvers: [],
  }).outcome, 'allowed')

  assert.equal(decideGovernanceIncidentControl({
    actor: groupMember,
    action: 'revoke_tool',
    subjectKind: 'tool',
    subjectId: 'tool:warehouse',
    owner,
    approvers: [securityGroup],
  }).outcome, 'allowed')

  assert.equal(decideGovernanceIncidentControl({
    actor: groupMember,
    action: 'revoke_tool',
    subjectKind: 'tool',
    subjectId: 'tool:warehouse',
    owner,
    approvers: [{
      kind: 'group',
      id: 'finance',
      displayName: 'Finance',
    }],
  }).outcome, 'denied')
})

test('incident controls expose stable required roles', () => {
  assert.deepEqual(requiredRolesForGovernanceIncident('pause_agent'), ['admin', 'owner', 'approver'])
  assert.deepEqual(requiredRolesForGovernanceIncident('revoke_tool'), ['admin', 'approver'])
  assert.deepEqual(requiredRolesForGovernanceIncident('export_audit'), ['admin', 'approver', 'viewer'])
})
