import type {
  AutomationListPayload,
  BuiltInAgentDetail,
  ChannelListPayload,
  CapabilityAccessPolicy,
  CapabilityConsumer,
  CapabilityCredentialHealth,
  CapabilityRelationshipEdge,
  CapabilityRelationshipNode,
  CapabilityRiskLevel,
  CapabilityRiskMetadata,
  CapabilitySkill,
  CapabilityTool,
  CrewListPayload,
  CustomAgentConfig,
  CustomAgentSummary,
  GovernanceRegistryPayload,
  GovernanceRegistrySubject,
  RuntimeToolDescriptor,
} from '@open-cowork/shared'
import { getBrandName } from '../../helpers/brand.ts'
import { t } from '../../helpers/i18n.ts'

export type Tab = 'map' | 'relationships' | 'tools' | 'skills'
export const CAPABILITY_RELATIONSHIP_FEATURE_GATE_KEY = 'open-cowork.feature.capabilityRelationshipGraph'

export type Selection =
  | { type: 'tool'; id: string }
  | { type: 'skill'; name: string }
  | null

export type CapabilityLinkedTool = {
  id: string
  name: string
}

export type CapabilityMapGroup = {
  id: string
  type: 'tool' | 'standalone'
  label: string
  tool: CapabilityTool | null
  skills: CapabilitySkill[]
  matchedTool: boolean
  matchedSkillNames: Set<string>
}

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

function storageOrNull(storage?: Storage | null) {
  if (storage) return storage
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function isCapabilityRelationshipGraphEnabled(storage?: Storage | null) {
  const target = storageOrNull(storage)
  if (!target) return false
  try {
    return target.getItem(CAPABILITY_RELATIONSHIP_FEATURE_GATE_KEY) === 'true'
  } catch {
    return false
  }
}

export function stripFrontmatter(content: string) {
  return content.replace(/^---[\s\S]*?---\n?/, '').trim()
}

export function prettyKind(tool: CapabilityTool) {
  if (tool.origin === 'opencode') return t('capabilities.kindOpencodeTool', 'OpenCode tool')
  if (tool.source === 'custom') return t('capabilities.kindCustomMcp', 'Custom MCP')
  return tool.kind === 'built-in' ? t('capabilities.kindBuiltinTool', 'Built-in tool') : t('capabilities.kindMcpTool', 'MCP tool')
}

export function prettySkillKind(skill: CapabilitySkill) {
  if (skill.source === 'custom') return t('capabilities.kindCustomSkill', 'Custom skill')
  return t('capabilities.kindBuiltinSkill', 'Built-in skill')
}

export function prettySkillSource(skill: CapabilitySkill) {
  if (skill.origin === 'open-cowork') return t('capabilities.skillSourceBundled', '{{brand}} bundled skill', { brand: getBrandName() })
  if (skill.scope === 'project') return t('capabilities.skillSourceProject', 'Project skill')
  if (skill.scope === 'machine') return t('capabilities.skillSourceMachine', 'Machine skill')
  return t('capabilities.skillSourceBundle', 'Skill bundle')
}

function toolPrefixes(tool: CapabilityTool) {
  const prefixes = new Set<string>()

  if (tool.namespace) {
    prefixes.add(`mcp__${tool.namespace}__`)
    prefixes.add(`${tool.namespace}_`)
  }

  prefixes.add(`mcp__${tool.id}__`)
  prefixes.add(`${tool.id}_`)

  return Array.from(prefixes)
}

export function safeText(value: string | null | undefined) {
  return typeof value === 'string' ? value : ''
}

function normalizeQuery(query: string) {
  return query.trim().toLowerCase()
}

function compareLabel(a: string, b: string) {
  return a.localeCompare(b, undefined, { sensitivity: 'base' })
}

function textMatches(query: string, values: Array<string | null | undefined>) {
  if (!query) return true
  return values.some((value) => safeText(value).toLowerCase().includes(query))
}

export function linkedToolsForSkill(
  skill: CapabilitySkill,
  tools: readonly CapabilityTool[],
): CapabilityLinkedTool[] {
  const toolMap = new Map(tools.map((tool) => [tool.id, tool]))
  const seen = new Set<string>()
  const linked: CapabilityLinkedTool[] = []
  for (const toolId of skill.toolIds || []) {
    if (seen.has(toolId)) continue
    seen.add(toolId)
    const tool = toolMap.get(toolId)
    if (!tool) continue
    linked.push({ id: tool.id, name: tool.name })
  }
  return linked.sort((a, b) => compareLabel(a.name, b.name))
}

export function linkedSkillsForTool(
  tool: CapabilityTool,
  skills: readonly CapabilitySkill[],
): CapabilitySkill[] {
  return skills
    .filter((skill) => (skill.toolIds || []).includes(tool.id))
    .sort((a, b) => compareLabel(a.label, b.label))
}

export function skillMatchesCapabilityQuery(
  skill: CapabilitySkill,
  tools: readonly CapabilityTool[],
  query: string,
) {
  const normalized = normalizeQuery(query)
  if (!normalized) return true
  const linkedTools = linkedToolsForSkill(skill, tools)
  return textMatches(normalized, [
    skill.name,
    skill.label,
    skill.description,
    ...skill.agentNames,
    ...linkedTools.flatMap((tool) => [tool.id, tool.name]),
  ])
}

export function toolMatchesCapabilityQuery(
  tool: CapabilityTool,
  skills: readonly CapabilitySkill[],
  query: string,
) {
  const normalized = normalizeQuery(query)
  if (!normalized) return true
  const linkedSkills = linkedSkillsForTool(tool, skills)
  return textMatches(normalized, [
    tool.id,
    tool.name,
    tool.description,
    tool.namespace || '',
    ...tool.agentNames,
    ...linkedSkills.flatMap((skill) => [skill.name, skill.label, skill.description, ...skill.agentNames]),
  ])
}

function toolDirectlyMatchesCapabilityQuery(tool: CapabilityTool, query: string) {
  const normalized = normalizeQuery(query)
  if (!normalized) return true
  return textMatches(normalized, [
    tool.id,
    tool.name,
    tool.description,
    tool.namespace || '',
    ...tool.agentNames,
  ])
}

export function buildCapabilityMapGroups(
  tools: readonly CapabilityTool[],
  skills: readonly CapabilitySkill[],
  query = '',
): CapabilityMapGroup[] {
  const normalized = normalizeQuery(query)
  const groups: CapabilityMapGroup[] = []
  const assignedSkillNames = new Set<string>()
  const sortedTools = [...tools].sort((a, b) => compareLabel(a.name, b.name))

  for (const tool of sortedTools) {
    const linkedSkills = linkedSkillsForTool(tool, skills)
    const matchedTool = toolDirectlyMatchesCapabilityQuery(tool, normalized)
    const matchedSkillNames = new Set(
      linkedSkills
        .filter((skill) => normalized && skillMatchesCapabilityQuery(skill, tools, normalized))
        .map((skill) => skill.name),
    )
    const visibleSkills = normalized && !matchedTool
      ? linkedSkills.filter((skill) => matchedSkillNames.has(skill.name))
      : linkedSkills

    if (normalized && !matchedTool && visibleSkills.length === 0) continue

    for (const skill of visibleSkills) {
      assignedSkillNames.add(skill.name)
    }
    groups.push({
      id: `tool:${tool.id}`,
      type: 'tool',
      label: tool.name,
      tool,
      skills: visibleSkills,
      matchedTool,
      matchedSkillNames,
    })
  }

  const standaloneSkills = skills
    .filter((skill) => {
      if (assignedSkillNames.has(skill.name)) return false
      const linkedKnownTools = linkedToolsForSkill(skill, tools)
      if (linkedKnownTools.length > 0) return false
      return skillMatchesCapabilityQuery(skill, tools, normalized)
    })
    .sort((a, b) => compareLabel(a.label, b.label))

  if (standaloneSkills.length > 0) {
    groups.push({
      id: 'standalone-skills',
      type: 'standalone',
      label: 'Standalone skills',
      tool: null,
      skills: standaloneSkills,
      matchedTool: false,
      matchedSkillNames: new Set(normalized ? standaloneSkills.map((skill) => skill.name) : []),
    })
  }

  return groups
}

export function mergedRuntimeToolset(tool: CapabilityTool, runtimeTools: readonly RuntimeToolDescriptor[]) {
  const prefixes = toolPrefixes(tool)
  const discovered = runtimeTools.filter((entry) => {
    const id = entry.id || entry.name || ''
    return id === tool.id || prefixes.some((prefix) => id.startsWith(prefix))
  })

  if (discovered.length > 0) {
    return discovered.map((entry) => ({
      id: entry.id || entry.name || 'unknown',
      description: entry.description || 'No description available for this MCP method.',
    }))
  }

  return tool.availableTools || []
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
type GovernanceSubjectIndex = Map<string, GovernanceRegistrySubject | null>
type AgentNameIndex = Map<string, string | null>
type DisabledBuiltInAgentNameSet = Set<string>

function normalizedConsumerLabel(name: string | null | undefined) {
  return safeText(name).replace(/^[^:]+:\s*/, '').trim().toLowerCase()
}

function normalizedAgentName(name: string | null | undefined) {
  return safeText(name).trim().toLowerCase()
}

function addAgentNameAlias(index: AgentNameIndex, name: string | null | undefined) {
  const key = normalizedAgentName(name)
  if (!key) return
  const value = safeText(name).trim()
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
  }
  return index
}

function buildDisabledBuiltInAgentNameSet(input: {
  builtInAgents?: readonly BuiltInAgentDetail[]
}): DisabledBuiltInAgentNameSet {
  const disabledNames = new Set<string>()
  for (const agent of input.builtInAgents || []) {
    if (!agent.disabled) continue
    const key = normalizedAgentName(agent.name)
    if (key) disabledNames.add(key)
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

function governanceSubjectIdKey(kind: string, id: string) {
  return `${kind}:id:${id}`
}

function governanceSubjectNameKey(kind: string, name: string | null | undefined) {
  const label = normalizedConsumerLabel(name)
  return label ? `${kind}:name:${label}` : null
}

function addGovernanceSubjectAlias(
  index: GovernanceSubjectIndex,
  key: string | null,
  subject: GovernanceRegistrySubject,
) {
  if (!key) return
  const existing = index.get(key)
  if (existing === undefined) {
    index.set(key, subject)
    return
  }
  if (existing === null) return
  if (existing.subjectId !== subject.subjectId) {
    index.set(key, null)
  }
}

function buildGovernanceSubjectIndex(registry: GovernanceRegistryPayload | null): GovernanceSubjectIndex {
  const index: GovernanceSubjectIndex = new Map()
  for (const subject of registry?.subjects || []) {
    if (subject.subjectKind !== 'agent' && subject.subjectKind !== 'crew') continue
    addGovernanceSubjectAlias(index, governanceSubjectIdKey(subject.subjectKind, subject.subjectId), subject)
    addGovernanceSubjectAlias(index, governanceSubjectNameKey(subject.subjectKind, subject.name), subject)
    addGovernanceSubjectAlias(index, governanceSubjectNameKey(subject.subjectKind, subject.displayName), subject)
  }
  return index
}

function canonicalConsumer(
  consumer: CapabilityConsumerDraft | CapabilityConsumer,
  governanceSubjects: GovernanceSubjectIndex | null,
): CapabilityConsumerDraft | CapabilityConsumer {
  if (!governanceSubjects || (consumer.kind !== 'agent' && consumer.kind !== 'crew')) return consumer
  const subject = governanceSubjects.get(governanceSubjectIdKey(consumer.kind, consumer.id))
    || governanceSubjects.get(governanceSubjectNameKey(consumer.kind, consumer.name) || '')
  if (!subject) return consumer
  return {
    ...consumer,
    id: subject.subjectId,
    name: subjectLabel(subject) || consumer.name,
  }
}

function addConsumer(
  consumers: Map<string, CapabilityConsumer>,
  input: CapabilityConsumerDraft | CapabilityConsumer,
  governanceSubjects: GovernanceSubjectIndex | null = null,
) {
  const consumer = canonicalConsumer(input, governanceSubjects)
  const key = consumerKey(consumer)
  if (consumers.has(key)) return
  consumers.set(key, withSchema(consumer))
}

function subjectLabel(subject: GovernanceRegistrySubject | undefined) {
  if (!subject) return null
  const prefix = subject.subjectKind === 'crew' ? 'Crew' : subject.subjectKind === 'tool' ? 'Tool' : subject.subjectKind === 'memory' ? 'Memory' : 'Agent'
  return `${prefix}: ${subject.displayName || subject.name}`
}

function governanceConsumersForDependency(input: {
  dependencyKind: 'tool' | 'skill'
  dependencyIds: string[]
  governanceRegistry: GovernanceRegistryPayload | null
}) {
  const registry = input.governanceRegistry
  if (!registry) return []
  const subjectsById = new Map(registry.subjects.map((subject) => [subject.subjectId, subject]))
  const ids = new Set(input.dependencyIds)
  const consumers = new Map<string, CapabilityConsumer>()

  for (const entry of registry.dependencyIndex) {
    if (entry.dependency.kind !== input.dependencyKind || !ids.has(entry.dependency.id)) continue
    for (const subjectId of entry.subjectIds) {
      const subject = subjectsById.get(subjectId)
      if (!subject || (subject.subjectKind !== 'agent' && subject.subjectKind !== 'crew')) continue
      addConsumer(consumers, {
        id: subject.subjectId,
        kind: subject.subjectKind,
        name: subjectLabel(subject) || subject.subjectId,
        source: entry.dependency.source === 'transitive' ? 'Governance dependency (transitive)' : 'Governance dependency',
      })
    }
  }

  return Array.from(consumers.values())
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
  crews?: CrewListPayload | null
  automations?: AutomationListPayload | null
  channels?: ChannelListPayload | null
  governanceSubjectIndex?: GovernanceSubjectIndex
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
  const crewDependencies = new Map<string, CapabilityDependency>()
  const consumers: ConsumerDependency[] = []

  const rememberAgent = (agentName: string, dependency: CapabilityDependency) => {
    const canonicalName = canonicalAgentName(agentName, agentNameIndex)
    if (!canonicalName) return
    const current = agentDependencies.get(canonicalName) || emptyDependency()
    addDependency(current, dependency)
    agentDependencies.set(canonicalName, current)
  }
  const push = (consumer: CapabilityConsumerDraft, dependency: CapabilityDependency) => {
    const withVersion = withSchema(canonicalConsumer(consumer, input.governanceSubjectIndex || null))
    consumers.push({ consumer: withVersion, dependencies: dependency })
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

  for (const crew of input.crews?.crews || []) {
    const dependency = emptyDependency()
    for (const member of crew.activeVersion?.members || []) {
      const memberDependency = agentDependencies.get(canonicalAgentName(member.agentName, agentNameIndex))
      if (memberDependency) addDependency(dependency, memberDependency)
    }
    push({
      id: `crew:${crew.definition.id}`,
      kind: 'crew',
      name: `Crew: ${crew.definition.name}`,
      source: 'Crew member assignment',
    }, dependency)
    crewDependencies.set(crew.definition.id, dependency)
  }

  for (const automation of input.automations?.automations || []) {
    const dependency = emptyDependency()
    for (const agentName of automation.preferredAgentNames || []) {
      const agentDependency = agentDependencies.get(canonicalAgentName(agentName, agentNameIndex))
      if (agentDependency) addDependency(dependency, agentDependency)
    }
    push({
      id: `automation:${automation.id}`,
      kind: 'automation',
      name: `Automation: ${automation.title}`,
      source: 'Automation preferred agents',
    }, dependency)
  }

  for (const channel of input.channels?.channels || []) {
    const dependency = dependencyFromCapabilityRefs({
      refs: channel.allowedCapabilityIds || [],
      toolsById,
      skillsByName,
      skillsByToolId,
    })
    if (channel.route.targetCrewId) {
      const routedCrewDependency = crewDependencies.get(channel.route.targetCrewId)
      if (routedCrewDependency) addDependency(dependency, routedCrewDependency)
    }
    push({
      id: `channel:${channel.id}`,
      kind: 'channel',
      name: `Channel: ${channel.name}`,
      source: channel.enabled ? 'Channel allowed capabilities' : 'Disabled channel policy',
    }, dependency)
  }

  return consumers
}

export function buildCapabilityRelationshipRows(input: {
  tools: readonly CapabilityTool[]
  skills: readonly CapabilitySkill[]
  runtimeTools: readonly RuntimeToolDescriptor[]
  capabilityRisks: readonly CapabilityRiskMetadata[]
  governanceRegistry: GovernanceRegistryPayload | null
  customAgents?: readonly CustomAgentSummary[]
  builtInAgents?: readonly BuiltInAgentDetail[]
  crews?: CrewListPayload | null
  automations?: AutomationListPayload | null
  channels?: ChannelListPayload | null
  query?: string
}): CapabilityRelationshipRow[] {
  const rows: CapabilityRelationshipRow[] = []
  const governanceSubjectIndex = buildGovernanceSubjectIndex(input.governanceRegistry)
  const agentNameIndex = buildAgentNameIndex(input)
  const disabledBuiltInAgentNames = buildDisabledBuiltInAgentNameSet(input)
  const projectedConsumers = consumerDependencies({
    ...input,
    agentNameIndex,
    governanceSubjectIndex,
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
      addConsumer(consumers, agentConsumerFromName(agentName, 'Agent tool loadout', agentNameIndex), governanceSubjectIndex)
    }
    for (const skill of linkedSkillsForTool(tool, input.skills)) {
      addConsumer(consumers, { id: `skill:${skill.name}`, kind: 'skill', name: `Skill: ${skill.label}`, source: 'Skill requires tool' })
    }
    for (const consumer of governanceConsumersForDependency({
      dependencyKind: 'tool',
      dependencyIds: [tool.id, tool.namespace || ''].filter(Boolean),
      governanceRegistry: input.governanceRegistry,
    })) {
      addConsumer(consumers, consumer, governanceSubjectIndex)
    }
    for (const projected of projectedConsumers) {
      if (!projected.dependencies.toolIds.has(tool.id)) continue
      addConsumer(consumers, projected.consumer, governanceSubjectIndex)
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
      addConsumer(consumers, agentConsumerFromName(agentName, 'Agent skill loadout', agentNameIndex), governanceSubjectIndex)
    }
    for (const consumer of governanceConsumersForDependency({
      dependencyKind: 'skill',
      dependencyIds: [skill.name],
      governanceRegistry: input.governanceRegistry,
    })) {
      addConsumer(consumers, consumer, governanceSubjectIndex)
    }
    for (const projected of projectedConsumers) {
      if (!projected.dependencies.skillNames.has(skill.name)) continue
      addConsumer(consumers, projected.consumer, governanceSubjectIndex)
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

function suggestAgentId(value: string) {
  return `${value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'new'}-agent`
}

export function buildAgentSeedFromTool(tool: CapabilityTool): Partial<CustomAgentConfig> {
  return {
    name: suggestAgentId(tool.id),
    description: tool.description,
    toolIds: [tool.id],
    instructions: '',
    skillNames: [],
    enabled: true,
    color: 'accent',
  }
}

export function buildAgentSeedFromSkill(skill: CapabilitySkill): Partial<CustomAgentConfig> {
  return {
    name: suggestAgentId(skill.name),
    description: skill.description,
    toolIds: [...(skill.toolIds || [])],
    instructions: '',
    skillNames: [skill.name],
    enabled: true,
    color: 'accent',
  }
}
