import type {
  CapabilitySkill,
  CapabilityTool,
  RuntimeToolDescriptor,
} from '@open-cowork/shared'
import { getBrandName } from '../../helpers/brand.ts'
import { t } from '../../helpers/i18n.ts'

export type CapabilityLinkedTool = {
  id: string
  name: string
}

export type CapabilityMapGroup = {
  id: string
  type: 'tool' | 'standalone'
  tier: CapabilityMapTier
  label: string
  tool: CapabilityTool | null
  skills: CapabilitySkill[]
  matchedTool: boolean
  matchedSkillNames: Set<string>
}

export type CapabilityMapTier = 'custom' | 'builtin' | 'opencode'

export type CapabilityMapSection = {
  id: CapabilityMapTier
  label: string
  description: string
  groups: CapabilityMapGroup[]
}

export type CapabilityToolSection = Omit<CapabilityMapSection, 'groups'> & {
  tools: CapabilityTool[]
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

export function normalizeQuery(query: string) {
  return query.trim().toLowerCase()
}

export function compareLabel(a: string, b: string) {
  return a.localeCompare(b, undefined, { sensitivity: 'base' })
}

const CAPABILITY_MAP_TIER_RANK: Record<CapabilityMapTier, number> = {
  custom: 0,
  builtin: 1,
  opencode: 2,
}

export function capabilityToolTier(tool: CapabilityTool): CapabilityMapTier {
  if (tool.source === 'custom' || tool.origin === 'custom' || tool.scope === 'machine' || tool.scope === 'project') {
    return 'custom'
  }
  if (tool.origin === 'opencode') return 'opencode'
  return 'builtin'
}

export function capabilitySkillTier(skill: CapabilitySkill): CapabilityMapTier {
  if (skill.source === 'custom' || skill.origin === 'custom' || skill.scope === 'machine' || skill.scope === 'project') {
    return 'custom'
  }
  return 'builtin'
}

function mostSpecificMapTier(tiers: CapabilityMapTier[]): CapabilityMapTier {
  return tiers.reduce<CapabilityMapTier>((winner, tier) => (
    CAPABILITY_MAP_TIER_RANK[tier] < CAPABILITY_MAP_TIER_RANK[winner] ? tier : winner
  ), 'opencode')
}

function mapGroupTier(tool: CapabilityTool | null, skills: readonly CapabilitySkill[]) {
  if (tool) return capabilityToolTier(tool)
  return mostSpecificMapTier([
    ...skills.map(capabilitySkillTier),
  ])
}

function compareMapGroups(a: CapabilityMapGroup, b: CapabilityMapGroup) {
  return CAPABILITY_MAP_TIER_RANK[a.tier] - CAPABILITY_MAP_TIER_RANK[b.tier]
    || compareLabel(a.label, b.label)
}

function compareMapTools(a: CapabilityTool, b: CapabilityTool) {
  return CAPABILITY_MAP_TIER_RANK[capabilityToolTier(a)] - CAPABILITY_MAP_TIER_RANK[capabilityToolTier(b)]
    || compareLabel(a.name, b.name)
}

function standaloneLabelForTier(tier: CapabilityMapTier) {
  if (tier === 'custom') return t('capabilities.customStandaloneSkills', 'Custom standalone skills')
  if (tier === 'opencode') return t('capabilities.opencodeStandaloneSkills', 'OpenCode standalone skills')
  return t('capabilities.builtinStandaloneSkills', 'Built-in standalone skills')
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

function sortSkillsForCapabilityMap(skills: readonly CapabilitySkill[]) {
  return [...skills].sort((a, b) => (
    CAPABILITY_MAP_TIER_RANK[capabilitySkillTier(a)] - CAPABILITY_MAP_TIER_RANK[capabilitySkillTier(b)]
    || compareLabel(a.label, b.label)
  ))
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

function skillMatchesCapabilityQueryWithLinkedTools(
  skill: CapabilitySkill,
  linkedTools: readonly CapabilityLinkedTool[],
  normalizedQuery: string,
) {
  if (!normalizedQuery) return true
  return textMatches(normalizedQuery, [
    skill.name,
    skill.label,
    skill.description,
    ...skill.agentNames,
    ...linkedTools.flatMap((tool) => [tool.id, tool.name]),
  ])
}

function buildCapabilityMapIndex(
  tools: readonly CapabilityTool[],
  skills: readonly CapabilitySkill[],
) {
  const toolById = new Map(tools.map((tool) => [tool.id, tool]))
  const linkedSkillsByToolId = new Map<string, CapabilitySkill[]>()
  const linkedToolsBySkillName = new Map<string, CapabilityLinkedTool[]>()

  for (const skill of skills) {
    const seenToolIds = new Set<string>()
    const linkedTools: CapabilityLinkedTool[] = []
    for (const toolId of skill.toolIds || []) {
      if (seenToolIds.has(toolId)) continue
      seenToolIds.add(toolId)
      const tool = toolById.get(toolId)
      if (!tool) continue

      linkedTools.push({ id: tool.id, name: tool.name })
      const linkedSkills = linkedSkillsByToolId.get(tool.id) || []
      linkedSkills.push(skill)
      linkedSkillsByToolId.set(tool.id, linkedSkills)
    }
    linkedToolsBySkillName.set(skill.name, linkedTools.sort((a, b) => compareLabel(a.name, b.name)))
  }

  for (const [toolId, linkedSkills] of linkedSkillsByToolId.entries()) {
    linkedSkillsByToolId.set(toolId, sortSkillsForCapabilityMap(linkedSkills))
  }

  return { linkedSkillsByToolId, linkedToolsBySkillName }
}

export function buildCapabilityMapGroups(
  tools: readonly CapabilityTool[],
  skills: readonly CapabilitySkill[],
  query = '',
): CapabilityMapGroup[] {
  const normalized = normalizeQuery(query)
  const groups: CapabilityMapGroup[] = []
  const assignedSkillNames = new Set<string>()
  const sortedTools = [...tools].sort(compareMapTools)
  const { linkedSkillsByToolId, linkedToolsBySkillName } = buildCapabilityMapIndex(tools, skills)

  for (const tool of sortedTools) {
    const linkedSkills = linkedSkillsByToolId.get(tool.id) || []
    const matchedTool = toolDirectlyMatchesCapabilityQuery(tool, normalized)
    const matchedSkillNames = new Set(
      linkedSkills
        .filter((skill) => normalized && skillMatchesCapabilityQueryWithLinkedTools(
          skill,
          linkedToolsBySkillName.get(skill.name) || [],
          normalized,
        ))
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
      tier: mapGroupTier(tool, visibleSkills),
      label: tool.name,
      tool,
      skills: visibleSkills,
      matchedTool,
      matchedSkillNames,
    })
  }

  const standaloneSkillsByTier = new Map<CapabilityMapTier, CapabilitySkill[]>()
  const standaloneSkills = skills
    .filter((skill) => {
      if (assignedSkillNames.has(skill.name)) return false
      const linkedKnownTools = linkedToolsBySkillName.get(skill.name) || []
      if (linkedKnownTools.length > 0) return false
      return skillMatchesCapabilityQueryWithLinkedTools(skill, linkedKnownTools, normalized)
    })
  for (const skill of standaloneSkills) {
    const tier = capabilitySkillTier(skill)
    const list = standaloneSkillsByTier.get(tier) || []
    list.push(skill)
    standaloneSkillsByTier.set(tier, list)
  }

  for (const [tier, tierSkills] of Array.from(standaloneSkillsByTier.entries())
    .sort((a, b) => CAPABILITY_MAP_TIER_RANK[a[0]] - CAPABILITY_MAP_TIER_RANK[b[0]])) {
    groups.push({
      id: `standalone-skills:${tier}`,
      type: 'standalone',
      tier,
      label: standaloneLabelForTier(tier),
      tool: null,
      skills: sortSkillsForCapabilityMap(tierSkills),
      matchedTool: false,
      matchedSkillNames: new Set(normalized ? tierSkills.map((skill) => skill.name) : []),
    })
  }

  return groups.sort(compareMapGroups)
}

function createCapabilitySectionTemplates<T extends 'groups' | 'tools'>(
  collectionKey: T,
): Array<Omit<CapabilityMapSection, 'groups'> & Record<T, []>> {
  return [
    {
      id: 'custom',
      label: t('capabilities.mapSectionCustom', 'Custom'),
      description: t('capabilities.mapSectionCustomDescription', 'User-added tools, project skills, and custom workflow ingredients.'),
      [collectionKey]: [],
    },
    {
      id: 'builtin',
      label: t('capabilities.mapSectionBuiltin', 'Built-in'),
      description: t('capabilities.mapSectionBuiltinDescription', 'Open Cowork bundled tools and skills.'),
      [collectionKey]: [],
    },
    {
      id: 'opencode',
      label: t('capabilities.mapSectionOpencode', 'OpenCode defaults'),
      description: t('capabilities.mapSectionOpencodeDescription', 'Native OpenCode tools and default runtime capabilities.'),
      [collectionKey]: [],
    },
  ] as Array<Omit<CapabilityMapSection, 'groups'> & Record<T, []>>
}

export function buildCapabilityMapSections(groups: readonly CapabilityMapGroup[]): CapabilityMapSection[] {
  const sections = createCapabilitySectionTemplates('groups') as CapabilityMapSection[]
  const sectionById = new Map(sections.map((section) => [section.id, section]))
  for (const group of groups) {
    sectionById.get(group.tier)?.groups.push(group)
  }
  return sections.filter((section) => section.groups.length > 0)
}

export function buildCapabilityToolSections(tools: readonly CapabilityTool[]): CapabilityToolSection[] {
  const sections = createCapabilitySectionTemplates('tools') as CapabilityToolSection[]
  const sectionById = new Map(sections.map((section) => [section.id, section]))
  for (const tool of [...tools].sort(compareMapTools)) {
    sectionById.get(capabilityToolTier(tool))?.tools.push(tool)
  }
  return sections.filter((section) => section.tools.length > 0)
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
