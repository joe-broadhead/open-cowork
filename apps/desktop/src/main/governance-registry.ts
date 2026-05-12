import { createHash } from 'node:crypto'
import type {
  AgentCatalog,
  AgentMemoryEntry,
  BuiltInAgentDetail,
  ChannelDefinition,
  CrewListPayload,
  CustomAgentSummary as SharedCustomAgentSummary,
  CustomMcpConfig,
  EvalSuite,
  GovernanceCredentialBinding,
  GovernanceDependency,
  GovernanceDependencyIndexEntry,
  GovernanceDependencyKind,
  GovernanceDependencySource,
  GovernanceExecutionNode,
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
import { listEvalSuites } from './crew-store.ts'
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
import { listAgentMemoryEntries } from './improvement-store.ts'
import { listApplicableRevokedGovernanceTools } from './governance-tool-policy.ts'
import {
  LOCAL_GOVERNANCE_APPROVERS,
  LOCAL_GOVERNANCE_ORGANIZATION,
  LOCAL_GOVERNANCE_OWNER,
  SYSTEM_GOVERNANCE_OWNER,
  listLocalGovernanceGroups,
  listLocalGovernancePrincipals,
  requiredRolesForGovernanceIncident,
} from './governance-policy.ts'

export interface GovernanceRegistryBuildInput {
  builtinAgents: BuiltInAgentDetail[]
  customAgents: GovernanceCustomAgentSummary[]
  agentCatalog: AgentCatalog
  crewCatalog: CrewListPayload
  evalSuites?: EvalSuite[]
  memoryEntries?: AgentMemoryEntry[]
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

function credentialBindingsFromDependencies(dependencies: GovernanceDependency[]): GovernanceCredentialBinding[] {
  return sortDependencies(dependencies.filter((dependency) => dependency.kind === 'credential'))
    .map((dependency) => ({
      id: dependency.id,
      label: dependency.label,
      source: dependency.source,
      required: dependency.required,
      ...(dependency.lifecycle ? { lifecycle: dependency.lifecycle } : {}),
    }))
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
      requiredRoles: requiredRolesForGovernanceIncident('pause_agent'),
      reason: agent.source === 'opencode'
        ? 'OpenCode-owned built-in agents require config overrides rather than a local destructive action.'
        : 'Configured built-ins are controlled by Open Cowork configuration.',
    },
    {
      kind: 'retire_agent',
      label: 'Retire built-in agent',
      available: false,
      requiresConfirmation: true,
      requiredRoles: requiredRolesForGovernanceIncident('retire_agent'),
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
      requiredRoles: requiredRolesForGovernanceIncident('pause_agent'),
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
      requiredRoles: requiredRolesForGovernanceIncident('retire_agent'),
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
      requiredRoles: requiredRolesForGovernanceIncident('pause_crew'),
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
      requiredRoles: requiredRolesForGovernanceIncident('retire_crew'),
      reason: retired ? 'The crew is already retired.' : null,
    },
    {
      kind: 'export_audit',
      label: 'Export crew run trace',
      available: true,
      requiresConfirmation: false,
      requiredRoles: requiredRolesForGovernanceIncident('export_audit'),
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

function createEvalSuiteMap(evalSuites: EvalSuite[] = []): Map<string, EvalSuite> {
  return new Map(evalSuites.map((suite) => [suite.id, suite]))
}

function evalSuiteGovernanceLifecycle(status: EvalSuite['status']): GovernanceLifecycleState {
  if (status === 'active') return 'active'
  if (status === 'archived') return 'retired'
  return 'draft'
}

function memoryGovernanceSubjectId(entry: Pick<AgentMemoryEntry, 'id'>): string {
  return `memory:${idSegment(entry.id)}`
}

function memoryGovernanceLifecycle(entry: Pick<AgentMemoryEntry, 'status'>): GovernanceLifecycleState {
  if (entry.status === 'proposed') return 'review'
  if (entry.status === 'approved') return 'approved'
  if (entry.status === 'quarantined') return 'quarantined'
  return 'retired'
}

function memoryDependency(entry: AgentMemoryEntry): GovernanceDependency {
  const lifecycle = memoryGovernanceLifecycle(entry)
  return createDependency(
    'memory',
    memoryGovernanceSubjectId(entry),
    entry.title || entry.summary || entry.id,
    'direct',
    entry.status === 'approved',
    lifecycle,
  )
}

function memoryEntryCanBeRuntimeDependency(entry: AgentMemoryEntry): boolean {
  return entry.status === 'approved' || entry.status === 'quarantined'
}

function memoryMatchesAgent(entry: AgentMemoryEntry, agent: GovernanceCustomAgentSummary | BuiltInAgentDetail): boolean {
  if (!memoryEntryCanBeRuntimeDependency(entry)) return false
  if (entry.scopeKind === 'agent') return agentNameKey(entry.scopeId) === agentNameKey(agent.name)
  if ('scope' in agent && entry.scopeKind === 'project') {
    return agent.scope === 'project' && Boolean(agent.directory) && entry.scopeId === agent.directory
  }
  return false
}

function memoryMatchesCrew(entry: AgentMemoryEntry, crew: CrewListPayload['crews'][number]): boolean {
  return memoryEntryCanBeRuntimeDependency(entry)
    && entry.scopeKind === 'crew'
    && entry.scopeId === crew.definition.id
}

function agentMemoryDependencies(
  agent: GovernanceCustomAgentSummary | BuiltInAgentDetail,
  memoryEntries: AgentMemoryEntry[] = [],
): GovernanceDependency[] {
  return memoryEntries
    .filter((entry) => memoryMatchesAgent(entry, agent))
    .map(memoryDependency)
}

function crewMemoryDependencies(
  crew: CrewListPayload['crews'][number],
  memoryEntries: AgentMemoryEntry[] = [],
): GovernanceDependency[] {
  return memoryEntries
    .filter((entry) => memoryMatchesCrew(entry, crew))
    .map(memoryDependency)
}

function memoryScope(entry: AgentMemoryEntry): GovernanceScope {
  if (entry.scopeKind === 'project') {
    const directory = entry.scopeId || null
    return {
      kind: 'project',
      id: directory ? `project:${shortHash(directory)}` : 'project:unbound',
      label: directory || 'Project memory',
      directory,
    }
  }
  const labelPrefix = entry.scopeKind === 'agent'
    ? 'Agent memory'
    : entry.scopeKind === 'crew'
      ? 'Crew memory'
      : 'Machine memory'
  return {
    kind: 'machine',
    id: `memory:${entry.scopeKind}:${entry.scopeId ? idSegment(entry.scopeId) : '*'}`,
    label: entry.scopeId ? `${labelPrefix}: ${entry.scopeId}` : labelPrefix,
    directory: null,
  }
}

function memoryBoundary(entry: AgentMemoryEntry) {
  if (entry.scopeKind === 'agent') {
    return {
      kind: 'agent' as const,
      id: entry.scopeId,
      label: entry.scopeId
        ? `Available to the ${entry.scopeId} agent memory scope.`
        : 'Available to an agent memory scope.',
    }
  }
  if (entry.scopeKind === 'crew') {
    return {
      kind: 'crew' as const,
      id: entry.scopeId,
      label: entry.scopeId
        ? `Available to the ${entry.scopeId} crew memory scope.`
        : 'Available to a crew memory scope.',
    }
  }
  if (entry.scopeKind === 'project') {
    return {
      kind: 'workspace' as const,
      id: entry.scopeId,
      label: entry.scopeId
        ? `Available inside project memory scope ${entry.scopeId}.`
        : 'Available inside a project memory scope.',
    }
  }
  return {
    kind: 'none' as const,
    id: null,
    label: 'Machine-scoped governed learning memory.',
  }
}

function memoryControls(entry: AgentMemoryEntry): GovernanceIncidentControl[] {
  const lifecycle = memoryGovernanceLifecycle(entry)
  return [{
    kind: 'quarantine_memory',
    label: lifecycle === 'approved' ? 'Quarantine memory' : lifecycle === 'quarantined' ? 'Memory quarantined' : 'Memory not approved',
    available: lifecycle === 'approved',
    requiresConfirmation: true,
    requiredRoles: requiredRolesForGovernanceIncident('quarantine_memory'),
    reason: lifecycle === 'approved'
      ? null
      : lifecycle === 'quarantined'
        ? 'The memory entry is already quarantined.'
        : 'Only approved memory can be quarantined.',
  }]
}

function buildMemorySubject(entry: AgentMemoryEntry): GovernanceRegistrySubject {
  return {
    schemaVersion: COWORK_GOVERNANCE_SCHEMA_VERSION,
    subjectKind: 'memory',
    subjectId: memoryGovernanceSubjectId(entry),
    name: entry.id,
    displayName: entry.title || entry.id,
    description: entry.summary || entry.title || 'Governed learning memory entry.',
    owner: LOCAL_GOVERNANCE_OWNER,
    approvers: LOCAL_GOVERNANCE_APPROVERS,
    lifecycle: memoryGovernanceLifecycle(entry),
    scope: memoryScope(entry),
    memoryBoundary: memoryBoundary(entry),
    evalSuiteId: null,
    offboardingPath: 'Quarantine unsafe approved memory, or archive memory through the governed improvement review workflow.',
    credentialBindings: [],
    dependencies: [],
    incidentControls: memoryControls(entry),
  }
}

function buildLocalDesktopExecutionNode(lastSeenAt: string): GovernanceExecutionNode {
  return {
    schemaVersion: COWORK_GOVERNANCE_SCHEMA_VERSION,
    id: 'execution-node:local-desktop',
    kind: 'desktop',
    label: 'Local desktop runtime',
    status: 'active',
    scope: {
      kind: 'machine',
      id: 'machine',
      label: 'This device',
      directory: null,
    },
    capabilities: [
      {
        kind: 'scheduling',
        label: 'Durable local scheduling',
        available: true,
        reason: null,
      },
      {
        kind: 'queue_recovery',
        label: 'Queue recovery after app restart',
        available: true,
        reason: null,
      },
      {
        kind: 'trigger_execution',
        label: 'Channel and manual trigger dispatch',
        available: true,
        reason: null,
      },
      {
        kind: 'cost_governance',
        label: 'Run-level cost and token accounting',
        available: true,
        reason: null,
      },
      {
        kind: 'background_execution',
        label: 'Execution independent of this desktop app',
        available: false,
        reason: 'Requires a future managed worker or durable service plane.',
      },
    ],
    limitations: [
      'Scheduled and channel-triggered execution requires the desktop app and managed OpenCode runtime to be running.',
      'No remote managed worker is registered for laptop-independent background execution yet.',
    ],
    lastSeenAt,
  }
}

function buildPlannedManagedWorkerExecutionNode(): GovernanceExecutionNode {
  return {
    schemaVersion: COWORK_GOVERNANCE_SCHEMA_VERSION,
    id: 'execution-node:managed-worker',
    kind: 'managed_worker',
    label: 'Managed worker plane',
    status: 'planned',
    scope: {
      kind: 'system',
      id: 'managed-worker-plane',
      label: 'Future managed service plane',
      directory: null,
    },
    capabilities: [
      {
        kind: 'background_execution',
        label: 'Execution independent of this desktop app',
        available: false,
        reason: 'No managed worker is registered yet.',
      },
      {
        kind: 'scheduling',
        label: 'Server-side scheduling',
        available: false,
        reason: 'Scheduled work is currently coordinated by the desktop runtime.',
      },
      {
        kind: 'queue_recovery',
        label: 'Server-side queue recovery',
        available: false,
        reason: 'Queue recovery is currently local to this device.',
      },
      {
        kind: 'trigger_execution',
        label: 'Remote trigger dispatch',
        available: false,
        reason: 'Channel and manual triggers still dispatch through the local desktop runtime.',
      },
      {
        kind: 'cost_governance',
        label: 'Organization-wide worker cost governance',
        available: false,
        reason: 'Cost governance is currently recorded at local run boundaries.',
      },
    ],
    limitations: [
      'This node is a roadmap placeholder, not an active execution backend.',
      'Do not route OpenCode execution here until a managed worker or durable service plane is implemented.',
    ],
    lastSeenAt: null,
  }
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
    owner: SYSTEM_GOVERNANCE_OWNER,
    approvers: LOCAL_GOVERNANCE_APPROVERS,
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
    credentialBindings: credentialBindingsFromDependencies(dependencies),
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
    owner: LOCAL_GOVERNANCE_OWNER,
    approvers: LOCAL_GOVERNANCE_APPROVERS,
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
    credentialBindings: credentialBindingsFromDependencies(dependencies),
    dependencies,
    incidentControls: customAgentControls(agent),
  }
}

function buildCrewSubject(input: {
  crew: CrewListPayload['crews'][number]
  agentSubjectsByName: Map<string, GovernanceRegistrySubject>
  evalSuitesById?: Map<string, EvalSuite>
  supplementalDependencies?: GovernanceDependency[]
}): GovernanceRegistrySubject {
  const { definition, activeVersion } = input.crew
  const dependencies = new Map<string, GovernanceDependency>()
  for (const member of activeVersion?.members || []) {
    addDependency(dependencies, createDependency('agent', member.agentName, member.displayName || member.agentName, 'direct'))
    const agentSubject = input.agentSubjectsByName.get(agentNameKey(member.agentName))
    if (!agentSubject) continue
    for (const dependency of agentSubject.dependencies) {
      if (
        dependency.kind !== 'tool'
        && dependency.kind !== 'skill'
        && dependency.kind !== 'credential'
        && dependency.kind !== 'memory'
      ) continue
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
    const suite = input.evalSuitesById?.get(activeVersion.evalSuiteId)
    addDependency(
      dependencies,
      createDependency(
        'eval_suite',
        activeVersion.evalSuiteId,
        suite?.name || activeVersion.evalSuiteId,
        'direct',
        true,
        suite ? evalSuiteGovernanceLifecycle(suite.status) : null,
      ),
    )
  }
  for (const dependency of input.supplementalDependencies || []) {
    addDependency(dependencies, dependency)
  }
  const sortedDependencies = sortDependencies([...dependencies.values()])

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
    owner: LOCAL_GOVERNANCE_OWNER,
    approvers: LOCAL_GOVERNANCE_APPROVERS,
    lifecycle: definition.status,
    scope,
    memoryBoundary: {
      kind: 'crew',
      id: definition.id,
      label: 'Crew runs keep durable traces, approvals, policy decisions, evals, and OpenCode child-session links.',
    },
    evalSuiteId: activeVersion?.evalSuiteId || null,
    offboardingPath: 'Pause or retire the crew before revoking its workspace profile, member agents, or eval suite.',
    credentialBindings: credentialBindingsFromDependencies(sortedDependencies),
    dependencies: sortedDependencies,
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
  const generatedAt = input.generatedAt || new Date().toISOString()
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
  const evalSuitesById = createEvalSuiteMap(input.evalSuites)
  const memoryEntries = input.memoryEntries || []

  const agentSubjects = [
    ...input.builtinAgents.map((agent) => buildBuiltInAgentSubject(agent, collectAgentDependencies({
      toolIds: [...agent.nativeToolIds, ...agent.configuredToolIds],
      skillNames: agent.skills,
      toolLabels,
      skillLabels,
      skillTools,
      toolCredentials,
      revokedTools,
      supplemental: [
        ...(agentSupplementalDependencies.get(agentNameKey(agent.name)) || []),
        ...agentMemoryDependencies(agent, memoryEntries),
      ],
    }))),
    ...input.customAgents.map((agent) => buildCustomAgentSubject(agent, collectAgentDependencies({
      toolIds: agent.toolIds,
      skillNames: agent.skillNames,
      toolLabels,
      skillLabels,
      skillTools,
      toolCredentials,
      revokedTools,
      supplemental: [
        ...(agentSupplementalDependencies.get(agentNameKey(agent.name)) || []),
        ...agentMemoryDependencies(agent, memoryEntries),
      ],
    }))),
  ]

  const agentSubjectsByName = new Map<string, GovernanceRegistrySubject>()
  for (const subject of agentSubjects) {
    agentSubjectsByName.set(agentNameKey(subject.name), subject)
  }

  const crewSubjects = input.crewCatalog.crews.map((crew) => buildCrewSubject({
    crew,
    agentSubjectsByName,
    evalSuitesById,
    supplementalDependencies: [
      ...(crewChannelDependencies.get(crew.definition.id) || []),
      ...crewMemoryDependencies(crew, memoryEntries),
    ],
  }))
  const memorySubjects = memoryEntries.map(buildMemorySubject)
  const subjects = [...agentSubjects, ...crewSubjects, ...memorySubjects].sort((left, right) => (
    left.subjectKind.localeCompare(right.subjectKind)
    || left.displayName.localeCompare(right.displayName)
    || left.subjectId.localeCompare(right.subjectId)
  ))
  return {
    schemaVersion: COWORK_GOVERNANCE_SCHEMA_VERSION,
    generatedAt,
    organization: LOCAL_GOVERNANCE_ORGANIZATION,
    principals: listLocalGovernancePrincipals(),
    groups: listLocalGovernanceGroups(),
    executionNodes: [
      buildLocalDesktopExecutionNode(generatedAt),
      buildPlannedManagedWorkerExecutionNode(),
    ],
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
    evalSuites: listEvalSuites(),
    memoryEntries: listAgentMemoryEntries(),
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
