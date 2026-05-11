import { createHash } from 'node:crypto'
import type {
  AgentCatalog,
  BuiltInAgentDetail,
  CrewListPayload,
  CustomAgentSummary as SharedCustomAgentSummary,
  GovernanceDependency,
  GovernanceDependencyIndexEntry,
  GovernanceDependencyKind,
  GovernanceDependencySource,
  GovernanceIncidentControl,
  GovernanceLifecycleState,
  GovernanceRegistryPayload,
  GovernanceRegistrySubject,
  GovernanceScope,
  RuntimeContextOptions,
} from '@open-cowork/shared'
import { COWORK_GOVERNANCE_SCHEMA_VERSION } from '@open-cowork/shared'

import { listBuiltInAgentDetails } from './built-in-agent-details.ts'
import { getCustomAgentCatalog, getCustomAgentSummaries } from './custom-agents.ts'
import { listCrewCatalog } from './crew-service.ts'

export interface GovernanceRegistryBuildInput {
  builtinAgents: BuiltInAgentDetail[]
  customAgents: GovernanceCustomAgentSummary[]
  agentCatalog: AgentCatalog
  crewCatalog: CrewListPayload
  generatedAt?: string
}

type GovernanceCustomAgentSummary = Omit<SharedCustomAgentSummary, 'scope'> & {
  scope?: SharedCustomAgentSummary['scope']
}

const LOCAL_OWNER = {
  kind: 'user' as const,
  id: 'local-user',
  displayName: 'Local user',
}

const SYSTEM_OWNER = {
  kind: 'system' as const,
  id: 'open-cowork',
  displayName: 'Open Cowork',
}

function idSegment(value: string): string {
  return encodeURIComponent(value)
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

function customAgentSubjectId(agent: GovernanceCustomAgentSummary): string {
  if (agent.scope === 'project') {
    const directoryKey = shortHash(agent.directory || 'unknown-project')
    return `agent:project:${directoryKey}:${idSegment(agent.name)}`
  }
  return `agent:machine:${idSegment(agent.name)}`
}

function builtInAgentSubjectId(agent: BuiltInAgentDetail): string {
  return `agent:system:${idSegment(agent.name)}`
}

function crewSubjectId(crewId: string): string {
  return `crew:${idSegment(crewId)}`
}

function dependencyKey(dependency: Pick<GovernanceDependency, 'kind' | 'id'>): string {
  return `${dependency.kind}:${dependency.id}`
}

function sortDependencies(dependencies: GovernanceDependency[]): GovernanceDependency[] {
  return [...dependencies].sort((left, right) => (
    left.kind.localeCompare(right.kind)
    || left.label.localeCompare(right.label)
    || left.id.localeCompare(right.id)
    || left.source.localeCompare(right.source)
  ))
}

function addDependency(
  dependencies: Map<string, GovernanceDependency>,
  dependency: GovernanceDependency,
) {
  const key = dependencyKey(dependency)
  const existing = dependencies.get(key)
  if (!existing) {
    dependencies.set(key, dependency)
    return
  }
  dependencies.set(key, {
    ...existing,
    source: existing.source === 'direct' || dependency.source === 'direct' ? 'direct' : 'transitive',
    required: existing.required || dependency.required,
  })
}

function createDependency(
  kind: GovernanceDependencyKind,
  id: string,
  label: string,
  source: GovernanceDependencySource,
  required = true,
): GovernanceDependency {
  return { kind, id, label, source, required }
}

function createToolLabelMap(catalog: AgentCatalog): Map<string, string> {
  return new Map(catalog.tools.map((tool) => [tool.id, tool.name]))
}

function createSkillLabelMap(catalog: AgentCatalog): Map<string, string> {
  return new Map(catalog.skills.map((skill) => [skill.name, skill.label || skill.name]))
}

function createSkillToolMap(catalog: AgentCatalog): Map<string, string[]> {
  return new Map(catalog.skills.map((skill) => [skill.name, skill.toolIds || []]))
}

function collectAgentDependencies(input: {
  toolIds: string[]
  skillNames: string[]
  toolLabels: Map<string, string>
  skillLabels: Map<string, string>
  skillTools: Map<string, string[]>
}): GovernanceDependency[] {
  const dependencies = new Map<string, GovernanceDependency>()
  for (const toolId of input.toolIds) {
    addDependency(dependencies, createDependency('tool', toolId, input.toolLabels.get(toolId) || toolId, 'direct'))
  }
  for (const skillName of input.skillNames) {
    addDependency(dependencies, createDependency('skill', skillName, input.skillLabels.get(skillName) || skillName, 'direct'))
    for (const toolId of input.skillTools.get(skillName) || []) {
      addDependency(dependencies, createDependency('tool', toolId, input.toolLabels.get(toolId) || toolId, 'transitive'))
    }
  }
  return sortDependencies([...dependencies.values()])
}

function customAgentLifecycle(agent: GovernanceCustomAgentSummary): GovernanceLifecycleState {
  if (!agent.valid) return 'draft'
  return agent.enabled ? 'active' : 'paused'
}

function customAgentScope(agent: GovernanceCustomAgentSummary): GovernanceScope {
  if (agent.scope === 'project') {
    const directory = agent.directory || null
    return {
      kind: 'project',
      id: directory ? `project:${shortHash(directory)}` : 'project:unbound',
      label: directory || 'Project scope',
      directory,
    }
  }
  return {
    kind: 'machine',
    id: 'machine',
    label: 'This device',
    directory: null,
  }
}

function builtInAgentControls(agent: BuiltInAgentDetail): GovernanceIncidentControl[] {
  return [
    {
      kind: 'pause_agent',
      label: 'Disable through built-in agent override',
      available: false,
      requiresConfirmation: true,
      reason: agent.source === 'opencode'
        ? 'OpenCode-owned built-in agents require config overrides rather than a local destructive action.'
        : 'Configured built-ins are controlled by Open Cowork configuration.',
    },
    {
      kind: 'retire_agent',
      label: 'Retire built-in agent',
      available: false,
      requiresConfirmation: true,
      reason: 'Built-in agents are part of the configured runtime contract and cannot be deleted from user data.',
    },
  ]
}

function customAgentControls(agent: GovernanceCustomAgentSummary): GovernanceIncidentControl[] {
  return [
    {
      kind: 'pause_agent',
      label: agent.enabled ? 'Disable custom agent' : 'Custom agent already disabled',
      available: agent.enabled,
      requiresConfirmation: false,
      reason: agent.enabled ? null : 'The agent is already paused.',
    },
    {
      kind: 'retire_agent',
      label: 'Remove custom agent',
      available: true,
      requiresConfirmation: true,
      reason: null,
    },
  ]
}

function crewControls(lifecycle: GovernanceLifecycleState): GovernanceIncidentControl[] {
  const retired = lifecycle === 'retired'
  return [
    {
      kind: 'pause_crew',
      label: retired ? 'Crew retired' : 'Pause crew',
      available: false,
      requiresConfirmation: true,
      reason: retired
        ? 'The crew is already retired.'
        : 'Crew lifecycle metadata exists; the admin action surface lands in a later governance slice.',
    },
    {
      kind: 'retire_crew',
      label: retired ? 'Crew retired' : 'Retire crew',
      available: false,
      requiresConfirmation: true,
      reason: retired
        ? 'The crew is already retired.'
        : 'Crew lifecycle metadata exists; the admin action surface lands in a later governance slice.',
    },
    {
      kind: 'export_audit',
      label: 'Export crew run trace',
      available: true,
      requiresConfirmation: false,
      reason: null,
    },
  ]
}

function buildBuiltInAgentSubject(
  agent: BuiltInAgentDetail,
  dependencies: GovernanceDependency[],
): GovernanceRegistrySubject {
  const displayName = agent.label || agent.name
  return {
    schemaVersion: COWORK_GOVERNANCE_SCHEMA_VERSION,
    subjectKind: 'agent',
    subjectId: builtInAgentSubjectId(agent),
    name: agent.name,
    displayName,
    description: agent.description,
    owner: SYSTEM_OWNER,
    lifecycle: agent.disabled ? 'paused' : 'active',
    scope: {
      kind: 'system',
      id: 'open-cowork-runtime',
      label: agent.source === 'opencode' ? 'OpenCode runtime' : 'Open Cowork runtime config',
      directory: null,
    },
    memoryBoundary: {
      kind: 'session',
      id: agent.name,
      label: `${displayName} uses OpenCode session context; no shared organization memory boundary is attached.`,
    },
    evalSuiteId: null,
    offboardingPath: agent.source === 'opencode'
      ? 'Disable or retune through built-in agent overrides; do not delete OpenCode-owned runtime agents.'
      : 'Remove or disable the configured agent in Open Cowork configuration.',
    dependencies,
    incidentControls: builtInAgentControls(agent),
  }
}

function buildCustomAgentSubject(
  agent: GovernanceCustomAgentSummary,
  dependencies: GovernanceDependency[],
): GovernanceRegistrySubject {
  return {
    schemaVersion: COWORK_GOVERNANCE_SCHEMA_VERSION,
    subjectKind: 'agent',
    subjectId: customAgentSubjectId(agent),
    name: agent.name,
    displayName: agent.name,
    description: agent.description,
    owner: LOCAL_OWNER,
    lifecycle: customAgentLifecycle(agent),
    scope: customAgentScope(agent),
    memoryBoundary: {
      kind: 'agent',
      id: customAgentSubjectId(agent),
      label: 'Agent-scoped OpenCode session context; no shared organization memory store is configured.',
    },
    evalSuiteId: null,
    offboardingPath: agent.scope === 'project'
      ? 'Disable or remove the project custom agent from the Agents surface.'
      : 'Disable or remove the machine custom agent from the Agents surface.',
    dependencies,
    incidentControls: customAgentControls(agent),
  }
}

function buildCrewSubject(input: {
  crew: CrewListPayload['crews'][number]
  agentSubjectsByName: Map<string, GovernanceRegistrySubject>
}): GovernanceRegistrySubject {
  const { definition, activeVersion } = input.crew
  const dependencies = new Map<string, GovernanceDependency>()
  for (const member of activeVersion?.members || []) {
    addDependency(dependencies, createDependency('agent', member.agentName, member.displayName || member.agentName, 'direct'))
    const agentSubject = input.agentSubjectsByName.get(member.agentName)
    if (!agentSubject) continue
    for (const dependency of agentSubject.dependencies) {
      if (dependency.kind !== 'tool' && dependency.kind !== 'skill' && dependency.kind !== 'credential') continue
      addDependency(dependencies, {
        ...dependency,
        source: 'transitive',
      })
    }
  }
  if (activeVersion?.workspaceProfileId) {
    addDependency(
      dependencies,
      createDependency('workspace_profile', activeVersion.workspaceProfileId, activeVersion.workspaceProfileId, 'direct'),
    )
  }
  if (activeVersion?.evalSuiteId) {
    addDependency(dependencies, createDependency('eval_suite', activeVersion.evalSuiteId, activeVersion.evalSuiteId, 'direct'))
  }

  const scope: GovernanceScope = activeVersion?.workspaceProfileId
    ? {
        kind: 'workspace_profile',
        id: activeVersion.workspaceProfileId,
        label: activeVersion.workspaceProfileId,
        directory: null,
      }
    : {
        kind: 'machine',
        id: 'machine',
        label: 'This device',
        directory: null,
      }

  return {
    schemaVersion: COWORK_GOVERNANCE_SCHEMA_VERSION,
    subjectKind: 'crew',
    subjectId: crewSubjectId(definition.id),
    name: definition.id,
    displayName: definition.name,
    description: definition.description,
    owner: LOCAL_OWNER,
    lifecycle: definition.status,
    scope,
    memoryBoundary: {
      kind: 'crew',
      id: definition.id,
      label: 'Crew runs keep durable traces, approvals, policy decisions, evals, and OpenCode child-session links.',
    },
    evalSuiteId: activeVersion?.evalSuiteId || null,
    offboardingPath: 'Pause or retire the crew before revoking its workspace profile, member agents, or eval suite.',
    dependencies: sortDependencies([...dependencies.values()]),
    incidentControls: crewControls(definition.status),
  }
}

function buildDependencyIndex(subjects: GovernanceRegistrySubject[]): GovernanceDependencyIndexEntry[] {
  const entries = new Map<string, { dependency: GovernanceDependency, subjectIds: Set<string> }>()
  for (const subject of subjects) {
    for (const dependency of subject.dependencies) {
      const key = dependencyKey(dependency)
      const entry = entries.get(key)
      if (!entry) {
        entries.set(key, { dependency, subjectIds: new Set([subject.subjectId]) })
        continue
      }
      entry.subjectIds.add(subject.subjectId)
      entry.dependency = {
        ...entry.dependency,
        source: entry.dependency.source === 'direct' || dependency.source === 'direct' ? 'direct' : 'transitive',
        required: entry.dependency.required || dependency.required,
      }
    }
  }
  return [...entries.values()]
    .map((entry) => ({
      dependency: entry.dependency,
      subjectIds: [...entry.subjectIds].sort(),
    }))
    .sort((left, right) => (
      left.dependency.kind.localeCompare(right.dependency.kind)
      || left.dependency.label.localeCompare(right.dependency.label)
      || left.dependency.id.localeCompare(right.dependency.id)
    ))
}

export function buildGovernanceRegistry(input: GovernanceRegistryBuildInput): GovernanceRegistryPayload {
  const toolLabels = createToolLabelMap(input.agentCatalog)
  const skillLabels = createSkillLabelMap(input.agentCatalog)
  const skillTools = createSkillToolMap(input.agentCatalog)

  const agentSubjects = [
    ...input.builtinAgents.map((agent) => buildBuiltInAgentSubject(agent, collectAgentDependencies({
      toolIds: [...agent.nativeToolIds, ...agent.configuredToolIds],
      skillNames: agent.skills,
      toolLabels,
      skillLabels,
      skillTools,
    }))),
    ...input.customAgents.map((agent) => buildCustomAgentSubject(agent, collectAgentDependencies({
      toolIds: agent.toolIds,
      skillNames: agent.skillNames,
      toolLabels,
      skillLabels,
      skillTools,
    }))),
  ]

  const agentSubjectsByName = new Map<string, GovernanceRegistrySubject>()
  for (const subject of agentSubjects) {
    agentSubjectsByName.set(subject.name, subject)
  }

  const crewSubjects = input.crewCatalog.crews.map((crew) => buildCrewSubject({
    crew,
    agentSubjectsByName,
  }))
  const subjects = [...agentSubjects, ...crewSubjects].sort((left, right) => (
    left.subjectKind.localeCompare(right.subjectKind)
    || left.displayName.localeCompare(right.displayName)
    || left.subjectId.localeCompare(right.subjectId)
  ))
  return {
    schemaVersion: COWORK_GOVERNANCE_SCHEMA_VERSION,
    generatedAt: input.generatedAt || new Date().toISOString(),
    subjects,
    dependencyIndex: buildDependencyIndex(subjects),
  }
}

export async function getGovernanceRegistry(options?: RuntimeContextOptions): Promise<GovernanceRegistryPayload> {
  const [agentCatalog, customAgents] = await Promise.all([
    getCustomAgentCatalog(options),
    getCustomAgentSummaries(options),
  ])
  return buildGovernanceRegistry({
    builtinAgents: listBuiltInAgentDetails(),
    customAgents,
    agentCatalog,
    crewCatalog: listCrewCatalog(),
  })
}
