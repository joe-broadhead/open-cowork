import type {
  CapabilitySkill,
  CapabilityTool,
  CustomAgentConfig,
  RuntimeToolDescriptor,
} from '@open-cowork/shared'
import { getBrandName } from '../../helpers/brand'
import { t } from '../../helpers/i18n'

export type Tab = 'map' | 'tools' | 'skills'
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

export function mergedRuntimeToolset(tool: CapabilityTool, runtimeTools: RuntimeToolDescriptor[]) {
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
