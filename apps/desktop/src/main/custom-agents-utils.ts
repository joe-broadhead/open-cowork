import {
  getConfiguredSkillsFromConfig,
  getConfiguredToolAllowPatterns,
  getConfiguredToolAskPatterns,
  getConfiguredToolsFromConfig,
  type ConfiguredSkill,
  type ConfiguredTool,
} from './config-loader.ts'

export type AgentColor = 'primary' | 'warning' | 'accent' | 'success' | 'info' | 'secondary'

export type CustomSkillLike = {
  name: string
  content: string
}

export type CustomAgentLike = {
  name: string
  description: string
  instructions: string
  skillNames: string[]
  toolIds: string[]
  enabled: boolean
  color: AgentColor
}

export type SettingsLike = {
  customMcps?: Array<{ name: string; label?: string; description?: string }>
  customSkills: CustomSkillLike[]
  customAgents: CustomAgentLike[]
  [key: string]: unknown
}

export type CustomAgentIssue = {
  code: string
  message: string
}

export type CustomAgentCatalogTool = {
  id: string
  name: string
  icon: string
  description: string
  supportsWrite: boolean
  source: 'builtin' | 'custom'
  patterns: string[]
  allowPatterns: string[]
  askPatterns: string[]
}

export type CustomAgentCatalogSkill = {
  name: string
  label: string
  description: string
  source: 'builtin' | 'custom'
  toolIds?: string[]
}

export type CustomAgentCatalog = {
  tools: CustomAgentCatalogTool[]
  skills: CustomAgentCatalogSkill[]
  reservedNames: string[]
  colors: AgentColor[]
}

export type CustomAgentSummary = CustomAgentLike & {
  writeAccess: boolean
  valid: boolean
  issues: CustomAgentIssue[]
}

export type RuntimeCustomAgent = {
  name: string
  description: string
  instructions: string
  skillNames: string[]
  toolNames: string[]
  writeAccess: boolean
  color: AgentColor
  allowPatterns: string[]
  askPatterns: string[]
}

export const CUSTOM_AGENT_COLORS: AgentColor[] = [
  'accent',
  'primary',
  'success',
  'info',
  'warning',
  'secondary',
]

export const RESERVED_AGENT_NAMES = [
  'plan',
  'explore',
  'build',
  'general',
  'title',
  'summary',
  'compaction',
]

const VALID_AGENT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function unique(values: string[]) {
  return Array.from(new Set(values))
}

function humanize(value: string) {
  return value
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function extractFrontmatterDescription(content: string) {
  const match = content.match(/^---\n[\s\S]*?\ndescription:\s*["']?(.+?)["']?\s*(?:\n|$)/m)
  if (!match?.[1]) return null
  return match[1].trim()
}

function extractFrontmatterName(content: string) {
  const match = content.match(/^---\n[\s\S]*?\n(?:title|name):\s*["']?(.+?)["']?\s*(?:\n|$)/m)
  if (!match?.[1]) return null
  return match[1].trim()
}

export function normalizeCustomAgent(input: CustomAgentLike): CustomAgentLike {
  return {
    name: (input.name || '').trim().toLowerCase(),
    description: (input.description || '').trim(),
    instructions: (input.instructions || '').trim(),
    skillNames: unique((input.skillNames || []).map((value) => value.trim()).filter(Boolean)),
    toolIds: unique((input.toolIds || []).map((value) => value.trim()).filter(Boolean)),
    enabled: input.enabled !== false,
    color: CUSTOM_AGENT_COLORS.includes(input.color) ? input.color : 'accent',
  }
}

function buildBuiltinToolCatalogEntry(tool: ConfiguredTool): CustomAgentCatalogTool {
  const allowPatterns = getConfiguredToolAllowPatterns(tool)
  const askPatterns = getConfiguredToolAskPatterns(tool)
  const patterns = Array.from(new Set([
    ...allowPatterns,
    ...askPatterns,
    ...(tool.patterns || []),
  ]))

  return {
    id: tool.id,
    name: tool.name,
    icon: tool.icon || tool.id,
    description: tool.description,
    supportsWrite: askPatterns.length > 0,
    source: 'builtin',
    patterns,
    allowPatterns,
    askPatterns,
  }
}

function buildBuiltinSkillCatalogEntry(skill: ConfiguredSkill): CustomAgentCatalogSkill {
  return {
    name: skill.sourceName,
    label: skill.name,
    description: skill.description,
    source: 'builtin',
    toolIds: [...(skill.toolIds || [])],
  }
}

export function buildCustomAgentCatalog(input: {
  builtinTools?: ConfiguredTool[]
  builtinSkills?: ConfiguredSkill[]
  customMcps: Array<{ name: string; label?: string; description?: string }>
  customSkills: CustomSkillLike[]
  settings: SettingsLike
}): CustomAgentCatalog {
  const builtinTools = input.builtinTools || getConfiguredToolsFromConfig()
  const builtinSkills = input.builtinSkills || getConfiguredSkillsFromConfig()

  const tools: CustomAgentCatalogTool[] = builtinTools
    .map(buildBuiltinToolCatalogEntry)
    .sort((a, b) => a.name.localeCompare(b.name))

  for (const mcp of input.customMcps || []) {
    if (!mcp.name) continue
    tools.push({
      id: mcp.name,
      name: mcp.label?.trim() || humanize(mcp.name),
      icon: mcp.name,
      description: mcp.description?.trim() || 'Custom MCP server',
      supportsWrite: true,
      source: 'custom',
      patterns: [`mcp__${mcp.name}__*`],
      allowPatterns: [],
      askPatterns: [`mcp__${mcp.name}__*`],
    })
  }

  const skills = new Map<string, CustomAgentCatalogSkill>()
  for (const skill of builtinSkills) {
    skills.set(skill.sourceName, buildBuiltinSkillCatalogEntry(skill))
  }

  for (const skill of input.customSkills) {
    skills.set(skill.name, {
      name: skill.name,
      label: humanize(extractFrontmatterName(skill.content) || skill.name),
      description: extractFrontmatterDescription(skill.content) || 'Custom skill',
      source: 'custom',
    })
  }

  return {
    tools: tools.sort((a, b) => a.name.localeCompare(b.name)),
    skills: Array.from(skills.values()).sort((a, b) => a.label.localeCompare(b.label)),
    reservedNames: [...RESERVED_AGENT_NAMES],
    colors: [...CUSTOM_AGENT_COLORS],
  }
}

export function validateCustomAgent(agent: CustomAgentLike, catalog: CustomAgentCatalog, siblingNames: string[] = []): CustomAgentIssue[] {
  const normalized = normalizeCustomAgent(agent)
  const issues: CustomAgentIssue[] = []

  if (!normalized.name || !VALID_AGENT_NAME.test(normalized.name)) {
    issues.push({
      code: 'invalid_name',
      message: 'Use lowercase letters, numbers, and hyphens only for the agent name.',
    })
  }

  if (catalog.reservedNames.includes(normalized.name)) {
    issues.push({
      code: 'reserved_name',
      message: `"${normalized.name}" is reserved by Open Cowork or OpenCode.`,
    })
  }

  if (siblingNames.includes(normalized.name)) {
    issues.push({
      code: 'duplicate_name',
      message: `A custom agent named "${normalized.name}" already exists.`,
    })
  }

  if (!normalized.description) {
    issues.push({
      code: 'missing_description',
      message: 'Add a short description so Open Cowork knows when to delegate to this agent.',
    })
  }

  const toolMap = new Map(catalog.tools.map((tool) => [tool.id, tool]))
  const skillMap = new Map(catalog.skills.map((skill) => [skill.name, skill]))

  for (const toolId of normalized.toolIds) {
    if (!toolMap.has(toolId)) {
      issues.push({
        code: 'missing_tool',
        message: `The tool "${toolId}" is no longer available.`,
      })
    }
  }

  for (const skillName of normalized.skillNames) {
    if (!skillMap.has(skillName)) {
      issues.push({
        code: 'missing_skill',
        message: `The skill "${skillName}" is not currently available.`,
      })
    }
  }

  return issues
}

function deriveWriteCapability(agent: CustomAgentLike, catalog: CustomAgentCatalog) {
  const toolMap = new Map(catalog.tools.map((tool) => [tool.id, tool]))
  return agent.toolIds.some((toolId) => Boolean(toolMap.get(toolId)?.supportsWrite))
}

export function summarizeCustomAgents(input: {
  settings: SettingsLike
  builtinTools?: ConfiguredTool[]
  builtinSkills?: ConfiguredSkill[]
}): CustomAgentSummary[] {
  const catalog = buildCustomAgentCatalog({
    builtinTools: input.builtinTools,
    builtinSkills: input.builtinSkills,
    customMcps: input.settings.customMcps || [],
    customSkills: input.settings.customSkills || [],
    settings: input.settings,
  })
  const agents = input.settings.customAgents || []

  return agents.map((agent, index) => {
    const normalized = normalizeCustomAgent(agent)
    const siblingNames = agents
      .filter((_, siblingIndex) => siblingIndex !== index)
      .map((entry) => normalizeCustomAgent(entry).name)
    const issues = validateCustomAgent(normalized, catalog, siblingNames)
    const writeAccess = deriveWriteCapability(normalized, catalog)
    return {
      ...normalized,
      writeAccess,
      valid: issues.length === 0,
      issues,
    }
  })
}

export function buildRuntimeCustomAgents(input: {
  settings: SettingsLike
  builtinTools?: ConfiguredTool[]
  builtinSkills?: ConfiguredSkill[]
}): RuntimeCustomAgent[] {
  const summaries = summarizeCustomAgents(input)
  const catalog = buildCustomAgentCatalog({
    builtinTools: input.builtinTools,
    builtinSkills: input.builtinSkills,
    customMcps: input.settings.customMcps || [],
    customSkills: input.settings.customSkills || [],
    settings: input.settings,
  })
  const toolNames = new Map(catalog.tools.map((tool) => [tool.id, tool.name]))

  return summaries
    .filter((agent) => agent.enabled && agent.valid)
    .map((agent) => {
      const selectedTools = catalog.tools.filter((tool) => agent.toolIds.includes(tool.id))
      const allowPatterns = Array.from(new Set(selectedTools.flatMap((tool) => tool.allowPatterns)))
      const askPatterns = Array.from(new Set(selectedTools.flatMap((tool) => tool.askPatterns)))
      return {
        name: agent.name,
        description: agent.description,
        instructions: agent.instructions,
        skillNames: [...agent.skillNames],
        toolNames: agent.toolIds.map((toolId) => toolNames.get(toolId) || toolId),
        writeAccess: agent.writeAccess,
        color: agent.color,
        allowPatterns,
        askPatterns,
      }
    })
}
