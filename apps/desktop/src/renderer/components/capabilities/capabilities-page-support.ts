import type {
  CapabilitySkill,
  CapabilityTool,
  CustomAgentConfig,
  RuntimeToolDescriptor,
} from '@open-cowork/shared'
import { getBrandName } from '../../helpers/brand'
import { t } from '../../helpers/i18n'

export type Tab = 'tools' | 'skills'
export type Selection =
  | { type: 'tool'; id: string }
  | { type: 'skill'; name: string }
  | null

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
