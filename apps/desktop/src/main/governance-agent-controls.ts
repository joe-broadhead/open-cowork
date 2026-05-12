import type { CustomAgentConfig, GovernancePrincipal, RuntimeContextOptions, ScopedArtifactRef } from '@open-cowork/shared'
import { getCustomAgentSummaries, normalizeCustomAgent, type CustomAgentSummary } from './custom-agents.ts'
import {
  customAgentGovernanceLifecycle,
  customAgentGovernanceSubjectId,
} from './governance-registry.ts'
import { recordGovernanceAuditEvent } from './governance-audit-store.ts'
import { listCustomAgents, removeCustomAgent, saveCustomAgent } from './native-customizations.ts'
import {
  LOCAL_GOVERNANCE_OWNER,
  assertGovernanceIncidentControlAllowed,
  decideGovernanceIncidentControl,
  type GovernanceIncidentPolicyDecision,
} from './governance-policy.ts'

const MAX_INCIDENT_REASON_BYTES = 16 * 1024

export type GovernanceAgentIncidentControlRequest = {
  subjectId: string
  reason?: string | null
  context?: RuntimeContextOptions
}

export type GovernanceAgentIncidentControlDependencies = {
  buildCustomAgentPermission: (
    agent: CustomAgentConfig,
    options?: RuntimeContextOptions,
  ) => Promise<Record<string, unknown>>
  rebootRuntime: () => Promise<void>
  actor?: GovernancePrincipal | null
}

type ResolvedCustomAgent = CustomAgentSummary & {
  storageName: string
}

function boundedSubjectId(value: unknown) {
  if (typeof value !== 'string') throw new Error('Agent subject id must be a string.')
  const subjectId = value.trim()
  if (!subjectId) throw new Error('Agent subject id is required.')
  if (Buffer.byteLength(subjectId, 'utf8') > 1024) throw new Error('Agent subject id is too large.')
  return subjectId
}

function boundedReason(value: unknown, fallback: string) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') throw new Error('Agent incident reason must be a string.')
  const reason = value.trim()
  if (!reason) return fallback
  if (Buffer.byteLength(reason, 'utf8') > MAX_INCIDENT_REASON_BYTES) {
    throw new Error('Agent incident reason is too large.')
  }
  return reason
}

function agentTarget(agent: Pick<ResolvedCustomAgent, 'name' | 'scope' | 'directory' | 'storageName'>): ScopedArtifactRef {
  return {
    name: agent.storageName || agent.name,
    scope: agent.scope || 'machine',
    directory: agent.scope === 'project' ? agent.directory || null : null,
  }
}

function runtimeContextForAgent(agent: Pick<CustomAgentSummary, 'scope' | 'directory'>): RuntimeContextOptions {
  return {
    directory: agent.scope === 'project' ? agent.directory || null : null,
  }
}

async function findCustomAgentBySubjectId(
  subjectId: string,
  options?: RuntimeContextOptions,
): Promise<ResolvedCustomAgent | null> {
  const rawAgents = listCustomAgents(options)
  const storageName = rawAgents
    .find((agent) => customAgentGovernanceSubjectId(normalizeCustomAgent(agent)) === subjectId)
    ?.name
  const agents = await getCustomAgentSummaries(options)
  const agent = agents.find((candidate) => customAgentGovernanceSubjectId(candidate) === subjectId)
  return agent ? { ...agent, storageName: storageName || agent.name } : null
}

function auditAgentIncident(input: {
  agent: CustomAgentSummary
  action: 'pause_agent' | 'retire_agent'
  reason: string
  afterLifecycle: 'paused' | 'retired'
  policyDecision: GovernanceIncidentPolicyDecision
}) {
  const subjectId = customAgentGovernanceSubjectId(input.agent)
  recordGovernanceAuditEvent({
    subjectKind: 'agent',
    subjectId,
    action: input.action,
    actor: input.policyDecision.actor,
    beforeLifecycle: customAgentGovernanceLifecycle(input.agent),
    afterLifecycle: input.afterLifecycle,
    reason: input.reason,
    metadata: {
      agentName: input.agent.name,
      scope: input.agent.scope || 'machine',
      directory: input.agent.scope === 'project' ? input.agent.directory || null : null,
      policyDecision: input.policyDecision,
    },
  })
}

function authorizeAgentIncident(input: {
  agent: CustomAgentSummary
  action: 'pause_agent' | 'retire_agent'
  actor?: GovernancePrincipal | null
}) {
  const subjectId = customAgentGovernanceSubjectId(input.agent)
  const policyDecision = decideGovernanceIncidentControl({
    actor: input.actor,
    action: input.action,
    subjectKind: 'agent',
    subjectId,
    owner: LOCAL_GOVERNANCE_OWNER,
    approvers: [LOCAL_GOVERNANCE_OWNER],
  })
  if (policyDecision.outcome === 'denied') {
    recordGovernanceAuditEvent({
      subjectKind: 'agent',
      subjectId,
      action: input.action,
      outcome: 'failed',
      actor: policyDecision.actor,
      beforeLifecycle: customAgentGovernanceLifecycle(input.agent),
      afterLifecycle: null,
      reason: policyDecision.reason,
      metadata: {
        agentName: input.agent.name,
        scope: input.agent.scope || 'machine',
        directory: input.agent.scope === 'project' ? input.agent.directory || null : null,
        policyDecision,
      },
    })
    assertGovernanceIncidentControlAllowed(policyDecision)
  }
  return policyDecision
}

function assertControllableAgent(agent: ResolvedCustomAgent | null, subjectId: string): asserts agent is ResolvedCustomAgent {
  if (!agent) throw new Error(`No custom agent found for governance subject ${subjectId}.`)
}

export async function pauseGovernanceAgent(
  request: GovernanceAgentIncidentControlRequest,
  dependencies: GovernanceAgentIncidentControlDependencies,
) {
  const subjectId = boundedSubjectId(request.subjectId)
  const agent = await findCustomAgentBySubjectId(subjectId, request.context)
  assertControllableAgent(agent, subjectId)
  const beforeLifecycle = customAgentGovernanceLifecycle(agent)
  if (beforeLifecycle === 'paused') throw new Error(`Agent ${agent.name} is already paused.`)
  if (beforeLifecycle !== 'active') throw new Error(`Agent ${agent.name} cannot be paused from ${beforeLifecycle} state.`)

  const reason = boundedReason(request.reason, 'Agent paused through governance incident control.')
  const policyDecision = authorizeAgentIncident({
    agent,
    action: 'pause_agent',
    actor: dependencies.actor,
  })
  const updated = normalizeCustomAgent({ ...agent, enabled: false })
  const context = runtimeContextForAgent(agent)
  saveCustomAgent(updated, await dependencies.buildCustomAgentPermission(updated, context))
  auditAgentIncident({
    agent,
    action: 'pause_agent',
    reason,
    afterLifecycle: 'paused',
    policyDecision,
  })
  await dependencies.rebootRuntime()
  return true
}

export async function retireGovernanceAgent(
  request: GovernanceAgentIncidentControlRequest,
  dependencies: GovernanceAgentIncidentControlDependencies,
) {
  const subjectId = boundedSubjectId(request.subjectId)
  const agent = await findCustomAgentBySubjectId(subjectId, request.context)
  assertControllableAgent(agent, subjectId)
  const beforeLifecycle = customAgentGovernanceLifecycle(agent)
  if (beforeLifecycle === 'retired') throw new Error(`Agent ${agent.name} is already retired.`)

  const reason = boundedReason(request.reason, 'Agent retired through governance incident control.')
  const policyDecision = authorizeAgentIncident({
    agent,
    action: 'retire_agent',
    actor: dependencies.actor,
  })
  removeCustomAgent(agentTarget(agent))
  auditAgentIncident({
    agent,
    action: 'retire_agent',
    reason,
    afterLifecycle: 'retired',
    policyDecision,
  })
  await dependencies.rebootRuntime()
  return true
}
