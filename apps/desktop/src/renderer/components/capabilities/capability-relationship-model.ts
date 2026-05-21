import type {
  BuiltInAgentDetail,
  CapabilityAccessPolicy,
  CapabilityConsumer,
  CapabilityCredentialHealth,
  CapabilityRelationshipEdge,
  CapabilityRelationshipNode,
  CapabilityRiskLevel,
  CapabilityRiskMetadata,
  CapabilitySkill,
  CapabilityTool,
  CustomAgentSummary,
  RuntimeToolDescriptor,
  WorkflowListPayload,
} from '@open-cowork/shared'
import {
  compareLabel,
  linkedSkillsForTool,
  linkedToolsForSkill,
  mergedRuntimeToolset,
  normalizeQuery,
  prettyKind,
  prettySkillKind,
  prettySkillSource,
  safeText,
} from './capability-map-model.ts'

export type CapabilityRelationshipRow = {
  id: string
  type: 'tool' | 'skill'
  label: string
  description: string
  source: string
  risk: CapabilityRiskLevel
  riskReason: string
  credentialHealth: CapabilityCredentialHealth
  accessPolicy: CapabilityAccessPolicy
  consumers: CapabilityConsumer[]
  requiredCapabilities: string[]
  methodsCount: number
  writeCapable: boolean
  approvalRequired: boolean
  searchText: string
  node: CapabilityRelationshipNode
  edges: CapabilityRelationshipEdge[]
}

const RISK_RANK: Record<CapabilityRiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
}

function withSchema<T extends object>(value: T) {
  return { schemaVersion: 1, ...value }
}

function maxRiskLevel(levels: CapabilityRiskLevel[]) {
  return levels.reduce<CapabilityRiskLevel>((highest, next) => (
    RISK_RANK[next] > RISK_RANK[highest] ? next : highest
  ), 'low')
}

function riskForCapability(capabilityId: string, risks: readonly CapabilityRiskMetadata[]) {
  const rows = risks.filter((entry) => entry.capabilityId === capabilityId)
  const risk = maxRiskLevel(rows.map((entry) => entry.risk))
  return {
    rows,
    risk,
    writeCapable: rows.some((entry) => entry.writeCapable),
    approvalRequired: rows.some((entry) => entry.approvalRequired),
    reason: rows.map((entry) => entry.reason).find(Boolean) || 'No elevated risk metadata recorded.',
  }
}

function riskForTool(tool: CapabilityTool, risks: readonly CapabilityRiskMetadata[]) {
  const candidates = [
    `tool:${tool.id}`,
    tool.namespace ? `tool:${tool.namespace}` : '',
    `native:${tool.id}`,
    ...mergedToolPatterns(tool).map((pattern) => `native:${pattern}`),
  ].filter(Boolean)
  const rows = risks.filter((entry) => candidates.includes(entry.capabilityId))
  const risk = maxRiskLevel(rows.map((entry) => entry.risk))
  return {
    rows,
    risk,
    writeCapable: rows.some((entry) => entry.writeCapable),
    approvalRequired: rows.some((entry) => entry.approvalRequired),
    reason: rows.map((entry) => entry.reason).find(Boolean) || 'No elevated risk metadata recorded.',
  }
}

function mergedToolPatterns(tool: CapabilityTool) {
  return Array.from(new Set([
    ...(tool.patterns || []),
    ...(tool.availableTools || []).map((entry) => entry.id),
  ])).filter(Boolean)
}

function credentialHealthForTool(tool: CapabilityTool): CapabilityCredentialHealth {
  if (tool.credentials?.length) {
    if (tool.credentialReady === false) {
      return withSchema({
        state: 'missing' as const,
        label: 'Credential missing',
        detail: `${tool.credentials.length} required credential${tool.credentials.length === 1 ? '' : 's'} not ready.`,
      })
    }
    if (tool.credentialReady === true) {
      return withSchema({
        state: 'ready' as const,
        label: 'Credentials ready',
        detail: `${tool.credentials.length} credential field${tool.credentials.length === 1 ? '' : 's'} configured.`,
      })
    }
    return withSchema({
      state: 'unknown' as const,
      label: 'Credential state unknown',
      detail: 'This capability declares credentials, but readiness is not reported.',
    })
  }
  if (tool.authMode === 'oauth' && tool.enabled === false) {
    return withSchema({
      state: 'disabled' as const,
      label: 'Integration disabled',
      detail: 'OAuth integration must be enabled before this capability can run.',
    })
  }
  return withSchema({
    state: 'not_required' as const,
    label: 'No credentials required',
    detail: null,
  })
}

function defaultAccessPolicy(input: {
  credentialHealth: CapabilityCredentialHealth
  risk: CapabilityRiskLevel
  approvalRequired: boolean
}): CapabilityAccessPolicy {
  if (input.credentialHealth.state === 'missing' || input.credentialHealth.state === 'disabled') {
    return withSchema({
      state: 'credential_missing' as const,
      inheritedFrom: null,
      reason: input.credentialHealth.label,
    })
  }
  if (input.risk === 'high' && !input.approvalRequired) {
    return withSchema({
      state: 'unknown' as const,
      inheritedFrom: null,
      reason: 'High-risk access has no explicit approval metadata.',
    })
  }
  return withSchema({
    state: input.approvalRequired ? 'inherited' as const : 'allowed' as const,
    inheritedFrom: input.approvalRequired ? 'OpenCode approval policy' : null,
    reason: input.approvalRequired ? 'Mutating access is behind approval/ask policy.' : 'No blocking policy problem reported.',
  })
}

type CapabilityConsumerDraft = Omit<CapabilityConsumer, 'schemaVersion'>
type AgentNameIndex = Map<string, string | null>
type DisabledBuiltInAgentNameSet = Set<string>

function normalizedAgentName(name: string | null | undefined) {
  return safeText(name).trim().toLowerCase().replace(/[\s_]+/g, '-')
}

function addAgentNameAlias(
  index: AgentNameIndex,
  alias: string | null | undefined,
  canonicalName: string | null | undefined = alias,
) {
  const key = normalizedAgentName(alias)
  if (!key) return
  const value = safeText(canonicalName).trim()
  const existing = index.get(key)
  if (existing === undefined) {
    index.set(key, value)
    return
  }
  if (existing === null) return
  if (existing !== value) {
    index.set(key, null)
  }
}

function buildAgentNameIndex(input: {
  customAgents?: readonly CustomAgentSummary[]
  builtInAgents?: readonly BuiltInAgentDetail[]
}): AgentNameIndex {
  const index: AgentNameIndex = new Map()
  for (const agent of input.customAgents || []) {
    if (!agent.enabled || !agent.valid) continue
    addAgentNameAlias(index, agent.name)
  }
  for (const agent of input.builtInAgents || []) {
    if (agent.disabled) continue
    addAgentNameAlias(index, agent.name)
    addAgentNameAlias(index, agent.label, agent.name)
  }
  return index
}

function buildDisabledBuiltInAgentNameSet(input: {
  builtInAgents?: readonly BuiltInAgentDetail[]
}): DisabledBuiltInAgentNameSet {
  const disabledNames = new Set<string>()
  for (const agent of input.builtInAgents || []) {
    if (!agent.disabled) continue
    for (const alias of [agent.name, agent.label]) {
      const key = normalizedAgentName(alias)
      if (key) disabledNames.add(key)
    }
  }
  return disabledNames
}

function canonicalAgentName(name: string, agentNameIndex: AgentNameIndex) {
  const key = normalizedAgentName(name)
  const indexed = agentNameIndex.get(key)
  return indexed || key
}

function isDisabledBuiltInOnlyAgentName(
  name: string,
  agentNameIndex: AgentNameIndex,
  disabledBuiltInAgentNames: DisabledBuiltInAgentNameSet,
) {
  const key = normalizedAgentName(name)
  return !!key && disabledBuiltInAgentNames.has(key) && !agentNameIndex.has(key)
}

function agentConsumerFromName(
  agentName: string,
  source: string,
  agentNameIndex: AgentNameIndex,
): CapabilityConsumerDraft {
  const canonicalName = canonicalAgentName(agentName, agentNameIndex)
  return {
    id: `agent:${canonicalName}`,
    kind: 'agent',
    name: `Agent: ${canonicalName || safeText(agentName).trim()}`,
    source,
  }
}

function consumerKey(consumer: Pick<CapabilityConsumer, 'kind' | 'id'>) {
  return `${consumer.kind}:${consumer.id}`
}

function addConsumer(
  consumers: Map<string, CapabilityConsumer>,
  input: CapabilityConsumerDraft | CapabilityConsumer,
) {
  const key = consumerKey(input)
  if (consumers.has(key)) return
  consumers.set(key, withSchema(input))
}

function buildSearchText(values: Array<string | null | undefined>) {
  return values.map((value) => safeText(value).toLowerCase()).filter(Boolean).join(' ')
}

function filterRelationshipRows(rows: CapabilityRelationshipRow[], query: string) {
  const normalized = normalizeQuery(query)
  if (!normalized) return rows
  return rows.filter((row) => row.searchText.includes(normalized))
}

type CapabilityDependency = {
  toolIds: Set<string>
  skillNames: Set<string>
}

type ConsumerDependency = {
  consumer: CapabilityConsumer
  dependencies: CapabilityDependency
}

function emptyDependency(): CapabilityDependency {
  return { toolIds: new Set(), skillNames: new Set() }
}

function addDependency(target: CapabilityDependency, dependency: CapabilityDependency) {
  for (const toolId of dependency.toolIds) target.toolIds.add(toolId)
  for (const skillName of dependency.skillNames) target.skillNames.add(skillName)
}

function dependencyFromCapabilityRefs(input: {
  refs: readonly string[]
  toolsById: Map<string, CapabilityTool>
  skillsByName: Map<string, CapabilitySkill>
  skillsByToolId: Map<string, CapabilitySkill[]>
}) {
  const dependency = emptyDependency()
  for (const raw of input.refs) {
    const value = raw.trim()
    if (!value) continue
    const [prefix, ...rest] = value.split(':')
    const id = rest.length > 0 ? rest.join(':') : value
    if ((prefix === 'tool' || prefix === 'mcp') && input.toolsById.has(id)) {
      dependency.toolIds.add(id)
      continue
    }
    if (prefix === 'skill' && input.skillsByName.has(id)) {
      dependency.skillNames.add(id)
      continue
    }
    if (input.toolsById.has(value)) {
      dependency.toolIds.add(value)
      continue
    }
    if (input.skillsByName.has(value)) {
      dependency.skillNames.add(value)
      continue
    }
    for (const tool of input.toolsById.values()) {
      const patterns = mergedToolPatterns(tool)
      if (
        patterns.includes(value)
        || patterns.some((pattern) => pattern.endsWith('*') && value.startsWith(pattern.slice(0, -1)))
      ) {
        dependency.toolIds.add(tool.id)
      }
    }
  }

  for (const skillName of Array.from(dependency.skillNames)) {
    const skill = input.skillsByName.get(skillName)
    for (const toolId of skill?.toolIds || []) dependency.toolIds.add(toolId)
  }

  return dependency
}

function consumerDependencies(input: {
  tools: readonly CapabilityTool[]
  skills: readonly CapabilitySkill[]
  customAgents?: readonly CustomAgentSummary[]
  builtInAgents?: readonly BuiltInAgentDetail[]
  workflows?: WorkflowListPayload | null
  agentNameIndex?: AgentNameIndex
  disabledBuiltInAgentNames?: DisabledBuiltInAgentNameSet
}) {
  const agentNameIndex = input.agentNameIndex || buildAgentNameIndex(input)
  const disabledBuiltInAgentNames = input.disabledBuiltInAgentNames || buildDisabledBuiltInAgentNameSet(input)
  const toolsById = new Map(input.tools.map((tool) => [tool.id, tool]))
  const skillsByName = new Map(input.skills.map((skill) => [skill.name, skill]))
  const skillsByToolId = new Map<string, CapabilitySkill[]>()
  for (const skill of input.skills) {
    for (const toolId of skill.toolIds || []) {
      const list = skillsByToolId.get(toolId) || []
      list.push(skill)
      skillsByToolId.set(toolId, list)
    }
  }

  const agentDependencies = new Map<string, CapabilityDependency>()
  const consumers: ConsumerDependency[] = []

  const rememberAgent = (agentName: string, dependency: CapabilityDependency) => {
    const canonicalName = canonicalAgentName(agentName, agentNameIndex)
    if (!canonicalName) return
    const current = agentDependencies.get(canonicalName) || emptyDependency()
    addDependency(current, dependency)
    agentDependencies.set(canonicalName, current)
  }
  const push = (consumer: CapabilityConsumerDraft, dependency: CapabilityDependency) => {
    consumers.push({ consumer: withSchema(consumer), dependencies: dependency })
  }

  for (const tool of input.tools) {
    for (const agentName of tool.agentNames || []) {
      if (isDisabledBuiltInOnlyAgentName(agentName, agentNameIndex, disabledBuiltInAgentNames)) continue
      const dependency = emptyDependency()
      dependency.toolIds.add(tool.id)
      rememberAgent(agentName, dependency)
    }
  }
  for (const skill of input.skills) {
    for (const agentName of skill.agentNames || []) {
      if (isDisabledBuiltInOnlyAgentName(agentName, agentNameIndex, disabledBuiltInAgentNames)) continue
      const dependency = dependencyFromCapabilityRefs({
        refs: [`skill:${skill.name}`],
        toolsById,
        skillsByName,
        skillsByToolId,
      })
      rememberAgent(agentName, dependency)
    }
  }

  for (const agent of input.customAgents || []) {
    if (!agent.enabled || !agent.valid) continue
    const dependency = dependencyFromCapabilityRefs({
      refs: [
        ...(agent.toolIds || []).map((toolId) => `tool:${toolId}`),
        ...(agent.skillNames || []).map((skillName) => `skill:${skillName}`),
      ],
      toolsById,
      skillsByName,
      skillsByToolId,
    })
    rememberAgent(agent.name, dependency)
    push(agentConsumerFromName(agent.name, 'Custom agent loadout', agentNameIndex), dependency)
  }

  for (const agent of input.builtInAgents || []) {
    if (agent.disabled) continue
    const dependency = dependencyFromCapabilityRefs({
      refs: [
        ...(agent.configuredToolIds || []).map((toolId) => `tool:${toolId}`),
        ...(agent.nativeToolIds || []),
        ...(agent.skills || []).map((skillName) => `skill:${skillName}`),
      ],
      toolsById,
      skillsByName,
      skillsByToolId,
    })
    rememberAgent(agent.name, dependency)
    push({
      ...agentConsumerFromName(agent.name, 'Built-in agent loadout', agentNameIndex),
      name: `Agent: ${agent.label || canonicalAgentName(agent.name, agentNameIndex)}`,
    }, dependency)
  }

  for (const workflow of input.workflows?.workflows || []) {
    const dependency = emptyDependency()
    const agentDependency = agentDependencies.get(canonicalAgentName(workflow.agentName, agentNameIndex))
    if (agentDependency) addDependency(dependency, agentDependency)
    for (const skillName of workflow.skillNames || []) dependency.skillNames.add(skillName)
    for (const toolId of workflow.toolIds || []) dependency.toolIds.add(toolId)
    push({
      id: `workflow:${workflow.id}`,
      kind: 'workflow',
      name: `Workflow: ${workflow.title}`,
      source: 'Workflow execution plan',
    }, dependency)
  }

  return consumers
}

export function buildCapabilityRelationshipRows(input: {
  tools: readonly CapabilityTool[]
  skills: readonly CapabilitySkill[]
  runtimeTools: readonly RuntimeToolDescriptor[]
  capabilityRisks: readonly CapabilityRiskMetadata[]
  customAgents?: readonly CustomAgentSummary[]
  builtInAgents?: readonly BuiltInAgentDetail[]
  workflows?: WorkflowListPayload | null
  query?: string
}): CapabilityRelationshipRow[] {
  const rows: CapabilityRelationshipRow[] = []
  const agentNameIndex = buildAgentNameIndex(input)
  const disabledBuiltInAgentNames = buildDisabledBuiltInAgentNameSet(input)
  const projectedConsumers = consumerDependencies({
    ...input,
    agentNameIndex,
    disabledBuiltInAgentNames,
  })

  for (const tool of input.tools) {
    const risk = riskForTool(tool, input.capabilityRisks)
    const credentialHealth = credentialHealthForTool(tool)
    const accessPolicy = defaultAccessPolicy({
      credentialHealth,
      risk: risk.risk,
      approvalRequired: risk.approvalRequired,
    })
    const consumers = new Map<string, CapabilityConsumer>()
    for (const agentName of tool.agentNames || []) {
      if (isDisabledBuiltInOnlyAgentName(agentName, agentNameIndex, disabledBuiltInAgentNames)) continue
      addConsumer(consumers, agentConsumerFromName(agentName, 'Agent tool loadout', agentNameIndex))
    }
    for (const skill of linkedSkillsForTool(tool, input.skills)) {
      addConsumer(consumers, { id: `skill:${skill.name}`, kind: 'skill', name: `Skill: ${skill.label}`, source: 'Skill requires tool' })
    }
    for (const projected of projectedConsumers) {
      if (!projected.dependencies.toolIds.has(tool.id)) continue
      addConsumer(consumers, projected.consumer)
    }
    const methodsCount = mergedRuntimeToolset(tool, input.runtimeTools).length
    const consumerList = Array.from(consumers.values()).sort((a, b) => compareLabel(a.name, b.name))
    const node = withSchema({
      id: `tool:${tool.id}`,
      kind: (tool.kind === 'mcp' ? 'mcp' : 'tool') as CapabilityRelationshipNode['kind'],
      label: tool.name,
      risk: risk.risk,
      credentialHealth,
      accessPolicy,
    })
    const edges = consumerList.map((consumer) => withSchema({
      fromId: consumer.id,
      toId: node.id,
      kind: 'uses' as const,
      label: consumer.source,
    }))
    rows.push({
      id: node.id,
      type: 'tool',
      label: tool.name,
      description: tool.description,
      source: prettyKind(tool),
      risk: risk.risk,
      riskReason: risk.reason,
      credentialHealth,
      accessPolicy,
      consumers: consumerList,
      requiredCapabilities: [],
      methodsCount,
      writeCapable: risk.writeCapable,
      approvalRequired: risk.approvalRequired,
      searchText: buildSearchText([
        tool.id,
        tool.name,
        tool.description,
        tool.namespace,
        risk.risk,
        risk.reason,
        credentialHealth.label,
        accessPolicy.reason,
        ...consumerList.flatMap((consumer) => [consumer.name, consumer.kind, consumer.source]),
      ]),
      node,
      edges,
    })
  }

  for (const skill of input.skills) {
    const risk = riskForCapability(`skill:${skill.name}`, input.capabilityRisks)
    const credentialHealth = withSchema({
      state: 'not_required' as const,
      label: 'Inherits tool credentials',
      detail: (skill.toolIds || []).length > 0 ? 'Credential health is shown on linked tools.' : 'No linked tools recorded.',
    })
    const accessPolicy = defaultAccessPolicy({
      credentialHealth,
      risk: risk.risk,
      approvalRequired: risk.approvalRequired,
    })
    const consumers = new Map<string, CapabilityConsumer>()
    for (const agentName of skill.agentNames || []) {
      if (isDisabledBuiltInOnlyAgentName(agentName, agentNameIndex, disabledBuiltInAgentNames)) continue
      addConsumer(consumers, agentConsumerFromName(agentName, 'Agent skill loadout', agentNameIndex))
    }
    for (const projected of projectedConsumers) {
      if (!projected.dependencies.skillNames.has(skill.name)) continue
      addConsumer(consumers, projected.consumer)
    }
    const linkedTools = linkedToolsForSkill(skill, input.tools)
    const requiredCapabilities = linkedTools.map((tool) => tool.name)
    const consumerList = Array.from(consumers.values()).sort((a, b) => compareLabel(a.name, b.name))
    const node = withSchema({
      id: `skill:${skill.name}`,
      kind: 'skill' as const,
      label: skill.label,
      risk: risk.risk,
      credentialHealth,
      accessPolicy,
    })
    const edges = [
      ...consumerList.map((consumer) => withSchema({
        fromId: consumer.id,
        toId: node.id,
        kind: 'uses' as const,
        label: consumer.source,
      })),
      ...linkedTools.map((tool) => withSchema({
        fromId: node.id,
        toId: `tool:${tool.id}`,
        kind: 'requires' as const,
        label: 'Requires tool',
      })),
    ]
    rows.push({
      id: node.id,
      type: 'skill',
      label: skill.label,
      description: skill.description,
      source: `${prettySkillKind(skill)} · ${prettySkillSource(skill)}`,
      risk: risk.risk,
      riskReason: risk.reason,
      credentialHealth,
      accessPolicy,
      consumers: consumerList,
      requiredCapabilities,
      methodsCount: (skill.toolIds || []).length,
      writeCapable: risk.writeCapable,
      approvalRequired: risk.approvalRequired,
      searchText: buildSearchText([
        skill.name,
        skill.label,
        skill.description,
        risk.risk,
        risk.reason,
        credentialHealth.label,
        accessPolicy.reason,
        ...requiredCapabilities,
        ...consumerList.flatMap((consumer) => [consumer.name, consumer.kind, consumer.source]),
      ]),
      node,
      edges,
    })
  }

  return filterRelationshipRows(rows, input.query || '')
    .sort((a, b) => RISK_RANK[b.risk] - RISK_RANK[a.risk] || b.consumers.length - a.consumers.length || compareLabel(a.label, b.label))
}
