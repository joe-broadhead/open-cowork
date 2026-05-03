import {
  getBrandName,
  getConfiguredSkillsFromConfig,
  getConfiguredToolAllowPatterns,
  getConfiguredToolAskPatterns,
  getConfiguredToolsFromConfig,
  expandMcpToolPermissionPatterns,
  type ConfiguredSkill,
  type ConfiguredTool,
} from './config-loader.ts'
import type { NativeConfigScope } from './runtime-paths.ts'
import { humanizeToolId, nativeToolPermissionPatterns, nativeToolSupportsWrite } from './runtime-tools.ts'
import { validateCustomAgentContentLimits } from './custom-content-limits.ts'

export type AgentColor = 'primary' | 'warning' | 'accent' | 'success' | 'info' | 'secondary'

export type CustomSkillLike = {
  name: string
  content: string
  label?: string
  description?: string
  toolIds?: string[]
  source?: 'builtin' | 'custom'
  origin?: 'open-cowork' | 'custom'
  scope?: NativeConfigScope | null
  location?: string | null
}

export type CustomAgentLike = {
  scope?: NativeConfigScope
  directory?: string | null
  name: string
  description: string
  instructions: string
  skillNames: string[]
  toolIds: string[]
  enabled: boolean
  color: AgentColor
  avatar?: string | null
  // Inference tuning forwarded to the SDK AgentConfig. Optional.
  model?: string | null
  variant?: string | null
  temperature?: number | null
  top_p?: number | null
  steps?: number | null
  options?: Record<string, unknown> | null
  // Specific tool patterns to deny even when the parent MCP is allowed.
  // See `CustomAgentConfig.deniedToolPatterns` for the full contract.
  deniedToolPatterns?: string[]
}

export type NormalizedCustomAgent = Omit<CustomAgentLike, 'scope' | 'directory'> & {
  scope: NativeConfigScope
  directory: string | null
}

export type CustomAgentCatalogState = {
  customMcps?: Array<{ name: string; label?: string; description?: string; permissionMode?: 'ask' | 'allow' }>
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
  origin?: 'open-cowork' | 'custom'
  scope?: NativeConfigScope | null
  location?: string | null
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
  deniedPatterns: string[]
  model?: string | null
  variant?: string | null
  temperature?: number | null
  top_p?: number | null
  steps?: number | null
  options?: Record<string, unknown> | null
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

export function normalizeCustomAgent(input: CustomAgentLike): NormalizedCustomAgent {
  const trimmedModel = typeof input.model === 'string' ? input.model.trim() : ''
  const trimmedVariant = typeof input.variant === 'string' ? input.variant.trim() : ''
  const trimmedAvatar = typeof input.avatar === 'string' ? input.avatar.trim() : ''
  return {
    scope: input.scope === 'project' ? 'project' : 'machine',
    directory: input.scope === 'project' ? input.directory || null : null,
    name: (input.name || '').trim().toLowerCase(),
    description: (input.description || '').trim(),
    instructions: (input.instructions || '').trim(),
    skillNames: unique((input.skillNames || []).map((value) => value.trim()).filter(Boolean)),
    toolIds: unique((input.toolIds || []).map((value) => value.trim()).filter(Boolean)),
    enabled: input.enabled !== false,
    color: CUSTOM_AGENT_COLORS.includes(input.color) ? input.color : 'accent',
    avatar: trimmedAvatar ? trimmedAvatar : null,
    model: trimmedModel ? trimmedModel : null,
    variant: trimmedVariant ? trimmedVariant : null,
    temperature: typeof input.temperature === 'number' && Number.isFinite(input.temperature) ? input.temperature : null,
    top_p: typeof input.top_p === 'number' && Number.isFinite(input.top_p) ? input.top_p : null,
    steps: typeof input.steps === 'number' && Number.isFinite(input.steps) && input.steps > 0 ? Math.round(input.steps) : null,
    options: input.options && typeof input.options === 'object' ? { ...input.options } : null,
    deniedToolPatterns: unique((input.deniedToolPatterns || []).map((value) => value.trim()).filter(Boolean)),
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
    supportsWrite: tool.writeAccess === true || (tool.writeAccess !== false && askPatterns.length > 0),
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
    origin: 'open-cowork',
    toolIds: [...(skill.toolIds || [])],
  }
}

export function buildCustomAgentCatalog(input: {
  builtinTools?: ConfiguredTool[]
  builtinSkills?: ConfiguredSkill[]
  runtimeTools?: Array<{ id: string; description: string }>
  availableSkills?: CustomAgentCatalogSkill[]
  customMcps: Array<{ name: string; label?: string; description?: string; permissionMode?: 'ask' | 'allow' }>
  customSkills: CustomSkillLike[]
  state: CustomAgentCatalogState
}): CustomAgentCatalog {
  const builtinTools = input.builtinTools || getConfiguredToolsFromConfig()
  const builtinSkills = input.builtinSkills || getConfiguredSkillsFromConfig()

  const tools = new Map<string, CustomAgentCatalogTool>(
    builtinTools
      .map(buildBuiltinToolCatalogEntry)
      .map((tool) => [tool.id, tool]),
  )

  for (const runtimeTool of input.runtimeTools || []) {
    if (!runtimeTool.id || tools.has(runtimeTool.id)) continue
    const supportsWrite = nativeToolSupportsWrite(runtimeTool.id)
    const permissionPatterns = nativeToolPermissionPatterns(runtimeTool.id)
    tools.set(runtimeTool.id, {
      id: runtimeTool.id,
      name: humanizeToolId(runtimeTool.id),
      icon: runtimeTool.id,
      description: runtimeTool.description,
      supportsWrite,
      source: 'builtin',
      patterns: [runtimeTool.id],
      allowPatterns: permissionPatterns.allowPatterns,
      askPatterns: permissionPatterns.askPatterns,
    })
  }

  for (const mcp of input.customMcps || []) {
    if (!mcp.name) continue
    const mcpPatterns = expandMcpToolPermissionPatterns([`mcp__${mcp.name}__*`])
    const permissionMode = mcp.permissionMode === 'allow' ? 'allow' : 'ask'
    tools.set(mcp.name, {
      id: mcp.name,
      name: mcp.label?.trim() || humanize(mcp.name),
      icon: mcp.name,
      description: mcp.description?.trim() || 'Custom MCP server',
      supportsWrite: true,
      source: 'custom',
      patterns: mcpPatterns,
      allowPatterns: permissionMode === 'allow' ? mcpPatterns : [],
      askPatterns: permissionMode === 'ask' ? mcpPatterns : [],
    })
  }

  const skills = new Map<string, CustomAgentCatalogSkill>()
  if (input.availableSkills && input.availableSkills.length > 0) {
    for (const skill of input.availableSkills) {
      skills.set(skill.name, skill)
    }
  } else {
    for (const skill of builtinSkills) {
      skills.set(skill.sourceName, buildBuiltinSkillCatalogEntry(skill))
    }

    for (const skill of input.customSkills) {
      skills.set(skill.name, {
        name: skill.name,
        label: skill.label || humanize(extractFrontmatterName(skill.content) || skill.name),
        description: skill.description || extractFrontmatterDescription(skill.content) || 'Custom skill',
        source: skill.source || 'custom',
        origin: skill.origin,
        scope: skill.scope || undefined,
        location: skill.location || undefined,
        toolIds: skill.toolIds,
      })
    }
  }

  return {
    tools: Array.from(tools.values()).sort((a, b) => a.name.localeCompare(b.name)),
    skills: Array.from(skills.values()).sort((a, b) => a.label.localeCompare(b.label)),
    reservedNames: [...RESERVED_AGENT_NAMES],
    colors: [...CUSTOM_AGENT_COLORS],
  }
}

export function validateCustomAgent(agent: CustomAgentLike, catalog: CustomAgentCatalog, siblingNames: string[] = []): CustomAgentIssue[] {
  const normalized = normalizeCustomAgent(agent)
  const issues: CustomAgentIssue[] = validateCustomAgentContentLimits(normalized)

  if (!normalized.name || !VALID_AGENT_NAME.test(normalized.name)) {
    issues.push({
      code: 'invalid_name',
      message: 'Use lowercase letters, numbers, and hyphens only for the agent name.',
    })
  }

  if (catalog.reservedNames.includes(normalized.name)) {
    issues.push({
      code: 'reserved_name',
      message: `"${normalized.name}" is reserved by ${getBrandName()} or OpenCode.`,
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
      message: `Add a short description so ${getBrandName()} knows when to delegate to this agent.`,
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
  state: CustomAgentCatalogState
  builtinTools?: ConfiguredTool[]
  builtinSkills?: ConfiguredSkill[]
  runtimeTools?: Array<{ id: string; description: string }>
  availableSkills?: CustomAgentCatalogSkill[]
}): CustomAgentSummary[] {
  const catalog = buildCustomAgentCatalog({
    builtinTools: input.builtinTools,
    builtinSkills: input.builtinSkills,
    runtimeTools: input.runtimeTools,
    availableSkills: input.availableSkills,
    customMcps: input.state.customMcps || [],
    customSkills: input.state.customSkills || [],
    state: input.state,
  })
  const agents = input.state.customAgents || []

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
  state: CustomAgentCatalogState
  builtinTools?: ConfiguredTool[]
  builtinSkills?: ConfiguredSkill[]
  runtimeTools?: Array<{ id: string; description: string }>
  availableSkills?: CustomAgentCatalogSkill[]
}): RuntimeCustomAgent[] {
  const summaries = summarizeCustomAgents(input)
  const catalog = buildCustomAgentCatalog({
    builtinTools: input.builtinTools,
    builtinSkills: input.builtinSkills,
    runtimeTools: input.runtimeTools,
    availableSkills: input.availableSkills,
    customMcps: input.state.customMcps || [],
    customSkills: input.state.customSkills || [],
    state: input.state,
  })
  const toolNames = new Map(catalog.tools.map((tool) => [tool.id, tool.name]))

  return summaries
    .filter((agent) => agent.enabled && agent.valid)
    .map((agent) => {
      const selectedTools = catalog.tools.filter((tool) => agent.toolIds.includes(tool.id))
      const allowPatterns = Array.from(new Set(selectedTools.flatMap((tool) => tool.allowPatterns)))
      const askPatterns = Array.from(new Set(selectedTools.flatMap((tool) => tool.askPatterns)))
      const deniedPatterns = Array.from(new Set(expandMcpToolPermissionPatterns(agent.deniedToolPatterns || [])))
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
        deniedPatterns,
        model: agent.model ?? null,
        variant: agent.variant ?? null,
        temperature: agent.temperature ?? null,
        top_p: agent.top_p ?? null,
        steps: agent.steps ?? null,
        options: agent.options ?? null,
      }
    })
}
