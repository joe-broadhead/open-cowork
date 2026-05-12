import { createHash } from 'node:crypto'
import type {
  AgentCatalog,
  BuiltInAgentDetail,
  ChannelDefinition,
  CrewListPayload,
  CustomAgentSummary as SharedCustomAgentSummary,
  CustomMcpConfig,
  GovernanceDependency,
  GovernanceDependencyIndexEntry,
  GovernanceDependencyKind,
  GovernanceDependencySource,
  GovernanceIncidentControl,
  GovernanceLifecycleState,
  GovernanceRegistryPayload,
  GovernanceRegistrySubject,
  GovernanceRevokedTool,
  GovernanceScope,
  RuntimeContextOptions,
  SopListPayload,
} from '@open-cowork/shared'
import { COWORK_GOVERNANCE_SCHEMA_VERSION } from '@open-cowork/shared'

import { listBuiltInAgentDetails } from './built-in-agent-details.ts'
import {
  getConfiguredMcpsFromConfig,
  getConfiguredToolsFromConfig,
  getConfiguredToolPatterns,
} from './config-loader.ts'
import type { BundleMcp, ConfiguredTool } from './config-types.ts'
import { getCustomAgentCatalog, getCustomAgentSummaries } from './custom-agents.ts'
import { listCrewCatalog } from './crew-service.ts'
import { listChannelDefinitions } from './channel-store.ts'
import { listSopDefinitions } from './sop-service.ts'
import { listCustomMcps } from './native-customizations.ts'
import { listApplicableRevokedGovernanceTools } from './governance-tool-policy.ts'

export interface GovernanceRegistryBuildInput {
  builtinAgents: BuiltInAgentDetail[]
  customAgents: GovernanceCustomAgentSummary[]
  agentCatalog: AgentCatalog
  crewCatalog: CrewListPayload
  sopCatalog?: SopListPayload
  channels?: ChannelDefinition[]
  toolCredentialDependencies?: GovernanceToolCredentialDependency[]
  revokedTools?: GovernanceRevokedTool[]
  generatedAt?: string
}

type GovernanceCustomAgentSummary = Omit<SharedCustomAgentSummary, 'scope'> & {
  scope?: SharedCustomAgentSummary['scope']
}

export type GovernanceCustomAgentIdentity = {
  scope?: 'machine' | 'project' | null
  directory?: string | null
  name: string
}

export type GovernanceToolCredentialDependency = {
  toolId: string
  dependency: GovernanceDependency
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

export function customAgentGovernanceSubjectId(agent: GovernanceCustomAgentIdentity): string {
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

function agentNameKey(name: string | null | undefined): string {
  return name?.trim().toLowerCase() || ''
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
  const lifecycle = dependencyLifecycle(existing.lifecycle, dependency.lifecycle)
  dependencies.set(key, {
    ...existing,
    source: existing.source === 'direct' || dependency.source === 'direct' ? 'direct' : 'transitive',
    required: existing.required || dependency.required,
    ...(lifecycle ? { lifecycle } : {}),
  })
}

function createDependency(
  kind: GovernanceDependencyKind,
  id: string,
  label: string,
  source: GovernanceDependencySource,
  required = true,
  lifecycle?: GovernanceLifecycleState | null,
): GovernanceDependency {
  return {
    kind,
    id,
    label,
    source,
    required,
    ...(lifecycle ? { lifecycle } : {}),
  }
}

function dependencyLifecycle(existing?: GovernanceLifecycleState | null, next?: GovernanceLifecycleState | null) {
  if (existing === 'revoked' || next === 'revoked') return 'revoked'
  return existing || next || null
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

function createToolCredentialMap(entries: GovernanceToolCredentialDependency[] = []): Map<string, GovernanceDependency[]> {
  const map = new Map<string, GovernanceDependency[]>()
  for (const entry of entries) {
    if (!entry.toolId || !entry.dependency.id) continue
    const current = map.get(entry.toolId) || []
    current.push(entry.dependency)
    map.set(entry.toolId, current)
  }
  return map
}

function collectAgentDependencies(input: {
  toolIds: string[]
  skillNames: string[]
  toolLabels: Map<string, string>
  skillLabels: Map<string, string>
  skillTools: Map<string, string[]>
  toolCredentials: Map<string, GovernanceDependency[]>
  revokedTools: Map<string, GovernanceRevokedTool>
  supplemental?: GovernanceDependency[]
}): GovernanceDependency[] {
  const dependencies = new Map<string, GovernanceDependency>()
  for (const toolId of input.toolIds) {
    addDependency(
      dependencies,
      createDependency('tool', toolId, input.toolLabels.get(toolId) || toolId, 'direct', true, input.revokedTools.has(toolId) ? 'revoked' : null),
    )
    for (const credential of input.toolCredentials.get(toolId) || []) {
      addDependency(dependencies, { ...credential, source: 'direct' })
    }
  }
  for (const skillName of input.skillNames) {
    addDependency(dependencies, createDependency('skill', skillName, input.skillLabels.get(skillName) || skillName, 'direct'))
    for (const toolId of input.skillTools.get(skillName) || []) {
      addDependency(
        dependencies,
        createDependency('tool', toolId, input.toolLabels.get(toolId) || toolId, 'transitive', true, input.revokedTools.has(toolId) ? 'revoked' : null),
      )
      for (const credential of input.toolCredentials.get(toolId) || []) {
        addDependency(dependencies, { ...credential, source: 'transitive' })
      }
    }
  }
  for (const dependency of input.supplemental || []) {
    addDependency(dependencies, dependency)
  }
  return sortDependencies([...dependencies.values()])
}

function namespaceFromPattern(pattern: string): string | null {
  const match = pattern.match(/^mcp__([a-z0-9][a-z0-9_-]*)__[^/]+$/i)
  return match?.[1] || null
}

function namespaceForConfiguredTool(tool: ConfiguredTool): string | null {
  if (tool.namespace) return tool.namespace
  for (const pattern of getConfiguredToolPatterns(tool)) {
    const namespace = namespaceFromPattern(pattern)
    if (namespace) return namespace
  }
  return null
}

function builtInMcpCredentialDependency(mcp: BundleMcp): GovernanceDependency | null {
  const credentialFields = mcp.credentials || []
  const hasCredentialSurface = mcp.authMode !== 'none'
    || credentialFields.length > 0
    || Boolean(mcp.googleAuth)
    || Boolean(mcp.envSettings?.length)
    || Boolean(mcp.headerSettings?.length)
  if (!hasCredentialSurface) return null
  return createDependency(
    'credential',
    `integration:${mcp.name}`,
    `${mcp.name} integration credentials`,
    'direct',
    mcp.authMode !== 'none'
      || credentialFields.some((credential) => credential.required !== false)
      || Boolean(mcp.googleAuth)
      || Boolean(mcp.envSettings?.length)
      || Boolean(mcp.headerSettings?.length),
  )
}

function customMcpCredentialDependency(mcp: CustomMcpConfig): GovernanceDependency | null {
  const hasCredentialSurface = Boolean(mcp.googleAuth)
    || Object.keys(mcp.env || {}).length > 0
    || Object.keys(mcp.headers || {}).length > 0
  if (!hasCredentialSurface) return null
  return createDependency(
    'credential',
    `custom-mcp:${mcp.scope}:${mcp.name}`,
    `${mcp.label || mcp.name} custom MCP credentials`,
    'direct',
    true,
  )
}

export function buildGovernanceToolCredentialDependencies(input: {
  tools: ConfiguredTool[]
  mcps: BundleMcp[]
  customMcps?: CustomMcpConfig[]
}): GovernanceToolCredentialDependency[] {
  const builtinMcpsByName = new Map(input.mcps.map((mcp) => [mcp.name, mcp]))
  const customMcpsByName = new Map((input.customMcps || []).map((mcp) => [mcp.name, mcp]))
  const entries: GovernanceToolCredentialDependency[] = []
  for (const tool of input.tools) {
    const namespace = namespaceForConfiguredTool(tool)
    if (!namespace) continue
    const builtin = builtinMcpsByName.get(namespace)
    const custom = customMcpsByName.get(namespace)
    const dependency = builtin
      ? builtInMcpCredentialDependency(builtin)
      : custom
        ? customMcpCredentialDependency(custom)
        : null
    if (dependency) entries.push({ toolId: tool.id, dependency })
  }
  for (const custom of input.customMcps || []) {
    const dependency = customMcpCredentialDependency(custom)
    if (dependency) entries.push({ toolId: custom.name, dependency })
  }
  return entries.sort((left, right) => (
    left.toolId.localeCompare(right.toolId)
    || left.dependency.id.localeCompare(right.dependency.id)
  ))
}

export function customAgentGovernanceLifecycle(agent: Pick<GovernanceCustomAgentSummary, 'enabled' | 'valid'>): GovernanceLifecycleState {
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
  const lifecycle = customAgentGovernanceLifecycle(agent)
  return [
    {
      kind: 'pause_agent',
      label: lifecycle === 'active' ? 'Disable custom agent' : lifecycle === 'paused' ? 'Custom agent already disabled' : 'Custom agent not approved',
      available: lifecycle === 'active',
      requiresConfirmation: false,
      reason: lifecycle === 'active'
        ? null
        : lifecycle === 'paused'
          ? 'The agent is already paused.'
          : 'Only active custom agents can be paused.',
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
  const paused = lifecycle === 'paused'
  return [
    {
      kind: 'pause_crew',
      label: retired ? 'Crew retired' : paused ? 'Crew paused' : 'Pause crew',
      available: !retired && !paused,
      requiresConfirmation: true,
      reason: retired
        ? 'The crew is already retired.'
        : paused
          ? 'The crew is already paused.'
          : null,
    },
    {
      kind: 'retire_crew',
      label: retired ? 'Crew retired' : 'Retire crew',
      available: !retired,
      requiresConfirmation: true,
      reason: retired ? 'The crew is already retired.' : null,
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

function createAgentSupplementalDependencyMap(input: {
  sops?: SopListPayload
  channels?: ChannelDefinition[]
}): Map<string, GovernanceDependency[]> {
  const dependenciesByAgent = new Map<string, GovernanceDependency[]>()
  const activeSops = input.sops?.sops || []
  const channelsBySop = new Map<string, ChannelDefinition[]>()
  for (const channel of input.channels || []) {
    if (channel.route.activationMode !== 'run_sop' || !channel.route.targetSopId) continue
    const channels = channelsBySop.get(channel.route.targetSopId) || []
    channels.push(channel)
    channelsBySop.set(channel.route.targetSopId, channels)
  }

  const addForAgent = (agentName: string | null | undefined, dependency: GovernanceDependency) => {
    const normalized = agentNameKey(agentName)
    if (!normalized) return
    const current = dependenciesByAgent.get(normalized) || []
    current.push(dependency)
    dependenciesByAgent.set(normalized, current)
  }

  for (const sop of activeSops) {
    if (!sop.activeVersion || sop.definition.status === 'retired') continue
    const sopDependency = createDependency('sop', sop.definition.id, sop.definition.name, 'direct', false)
    const channelDependencies = (channelsBySop.get(sop.definition.id) || []).map((channel) => (
      createDependency('channel', channel.id, channel.name, 'transitive', false)
    ))
    for (const step of sop.activeVersion.workflow) {
      addForAgent(step.agentName, sopDependency)
      for (const channelDependency of channelDependencies) {
        addForAgent(step.agentName, channelDependency)
      }
    }
  }

  return dependenciesByAgent
}

function createCrewChannelDependencyMap(channels: ChannelDefinition[] = []): Map<string, GovernanceDependency[]> {
  const dependenciesByCrew = new Map<string, GovernanceDependency[]>()
  for (const channel of channels) {
    if (channel.route.activationMode !== 'run_crew' || !channel.route.targetCrewId) continue
    const current = dependenciesByCrew.get(channel.route.targetCrewId) || []
    current.push(createDependency('channel', channel.id, channel.name, 'direct', false))
    dependenciesByCrew.set(channel.route.targetCrewId, current)
  }
  return dependenciesByCrew
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
    subjectId: customAgentGovernanceSubjectId(agent),
    name: agent.name,
    displayName: agent.name,
    description: agent.description,
    owner: LOCAL_OWNER,
    lifecycle: customAgentGovernanceLifecycle(agent),
    scope: customAgentScope(agent),
    memoryBoundary: {
      kind: 'agent',
      id: customAgentGovernanceSubjectId(agent),
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
  supplementalDependencies?: GovernanceDependency[]
}): GovernanceRegistrySubject {
  const { definition, activeVersion } = input.crew
  const dependencies = new Map<string, GovernanceDependency>()
  for (const member of activeVersion?.members || []) {
    addDependency(dependencies, createDependency('agent', member.agentName, member.displayName || member.agentName, 'direct'))
    const agentSubject = input.agentSubjectsByName.get(agentNameKey(member.agentName))
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
  for (const dependency of input.supplementalDependencies || []) {
    addDependency(dependencies, dependency)
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
      const lifecycle = dependencyLifecycle(entry.dependency.lifecycle, dependency.lifecycle)
      entry.dependency = {
        ...entry.dependency,
        source: entry.dependency.source === 'direct' || dependency.source === 'direct' ? 'direct' : 'transitive',
        required: entry.dependency.required || dependency.required,
        ...(lifecycle ? { lifecycle } : {}),
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
  const toolCredentials = createToolCredentialMap(input.toolCredentialDependencies)
  const revokedTools = new Map((input.revokedTools || []).map((tool) => [tool.toolId, tool]))
  const agentSupplementalDependencies = createAgentSupplementalDependencyMap({
    sops: input.sopCatalog,
    channels: input.channels,
  })
  const crewChannelDependencies = createCrewChannelDependencyMap(input.channels)

  const agentSubjects = [
    ...input.builtinAgents.map((agent) => buildBuiltInAgentSubject(agent, collectAgentDependencies({
      toolIds: [...agent.nativeToolIds, ...agent.configuredToolIds],
      skillNames: agent.skills,
      toolLabels,
      skillLabels,
      skillTools,
      toolCredentials,
      revokedTools,
      supplemental: agentSupplementalDependencies.get(agentNameKey(agent.name)),
    }))),
    ...input.customAgents.map((agent) => buildCustomAgentSubject(agent, collectAgentDependencies({
      toolIds: agent.toolIds,
      skillNames: agent.skillNames,
      toolLabels,
      skillLabels,
      skillTools,
      toolCredentials,
      revokedTools,
      supplemental: agentSupplementalDependencies.get(agentNameKey(agent.name)),
    }))),
  ]

  const agentSubjectsByName = new Map<string, GovernanceRegistrySubject>()
  for (const subject of agentSubjects) {
    agentSubjectsByName.set(agentNameKey(subject.name), subject)
  }

  const crewSubjects = input.crewCatalog.crews.map((crew) => buildCrewSubject({
    crew,
    agentSubjectsByName,
    supplementalDependencies: crewChannelDependencies.get(crew.definition.id),
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
  const configuredTools = getConfiguredToolsFromConfig()
  return buildGovernanceRegistry({
    builtinAgents: listBuiltInAgentDetails(),
    customAgents,
    agentCatalog,
    crewCatalog: listCrewCatalog(),
    sopCatalog: listSopDefinitions(),
    channels: listChannelDefinitions(),
    toolCredentialDependencies: buildGovernanceToolCredentialDependencies({
      tools: configuredTools,
      mcps: getConfiguredMcpsFromConfig(),
      customMcps: listCustomMcps(options),
    }),
    revokedTools: listApplicableRevokedGovernanceTools(options),
  })
}
