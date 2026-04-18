import type { CapabilitySkill, CapabilitySkillBundle, CapabilityTool, CapabilityToolEntry, RuntimeContextOptions } from '@open-cowork/shared'
import {
  getConfiguredAgentsFromConfig,
  getConfiguredMcpsFromConfig,
  getConfiguredSkillsFromConfig,
  getConfiguredToolAskPatterns,
  getConfiguredToolById,
  getConfiguredToolPatterns,
  getConfiguredToolsFromConfig,
} from './config-loader.ts'
import { listCustomAgents, listCustomMcps } from './native-customizations.ts'
import { getEffectiveSkillBundle, listEffectiveSkills } from './effective-skills.ts'

function humanize(value: string) {
  return value
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function namespaceFromPattern(pattern: string) {
  const match = pattern.match(/^mcp__([^_]+(?:-[^_]+)*)__/)
  return match?.[1] || null
}

function configuredAgentNamesForTool(toolId: string, context?: RuntimeContextOptions) {
  const builtIn = getConfiguredAgentsFromConfig()
    .filter((agent) => (agent.toolIds || []).includes(toolId))
    .map((agent) => agent.label || agent.name)
  const custom = listCustomAgents(context)
    .filter((agent) => agent.toolIds.includes(toolId) && agent.enabled)
    .map((agent) => humanize(agent.name))
  return Array.from(new Set([...builtIn, ...custom])).sort((a, b) => a.localeCompare(b))
}

function configuredAgentNamesForSkill(skillName: string, context?: RuntimeContextOptions) {
  const builtIn = getConfiguredAgentsFromConfig()
    .filter((agent) => (agent.skillNames || []).includes(skillName))
    .map((agent) => agent.label || agent.name)
  const custom = listCustomAgents(context)
    .filter((agent) => agent.skillNames.includes(skillName) && agent.enabled)
    .map((agent) => humanize(agent.name))
  return Array.from(new Set([...builtIn, ...custom])).sort((a, b) => a.localeCompare(b))
}

export function listCapabilityTools(context?: RuntimeContextOptions): CapabilityTool[] {
  // Index configured MCPs by name so we can splice their credential
  // metadata onto the matching Tool entry. Downstream bundles (e.g. the
  // GitHub hosted MCP, Perplexity) declare credentials on the MCP
  // itself; the UI drives its input forms off the CapabilityTool shape,
  // so we forward the metadata there.
  const mcpByNamespace = new Map(
    getConfiguredMcpsFromConfig().map((mcp) => [mcp.name, mcp] as const),
  )

  const configured = getConfiguredToolsFromConfig().map((tool) => {
    const patterns = getConfiguredToolPatterns(tool)
    const namespace = tool.namespace || patterns.map(namespaceFromPattern).find(Boolean) || null
    const backingMcp = namespace ? mcpByNamespace.get(namespace) : undefined

    return {
      id: tool.id,
      name: tool.name,
      icon: tool.icon,
      description: tool.description,
      kind: tool.kind,
      source: 'builtin' as const,
      origin: 'open-cowork' as const,
      scope: null,
      namespace,
      patterns,
      availableTools: [] as CapabilityToolEntry[],
      agentNames: configuredAgentNamesForTool(tool.id, context),
      ...(backingMcp?.credentials && backingMcp.credentials.length > 0
        ? { credentials: backingMcp.credentials, integrationId: backingMcp.name }
        : {}),
    }
  })

  const custom = listCustomMcps(context)
    .filter((entry) => entry.name)
    .map((entry) => ({
      id: entry.name,
      name: entry.label?.trim() || humanize(entry.name),
      icon: entry.name,
      description: entry.description?.trim() || (entry.type === 'stdio'
        ? `${entry.command}${entry.args?.length ? ` ${entry.args.join(' ')}` : ''}`
        : entry.url || 'Custom MCP'),
      kind: 'mcp' as const,
      source: 'custom' as const,
      origin: 'custom' as const,
      scope: entry.scope,
      namespace: entry.name,
      patterns: [`mcp__${entry.name}__*`],
      availableTools: [] as CapabilityToolEntry[],
      agentNames: configuredAgentNamesForTool(entry.name, context),
    }))

  return [...configured, ...custom].sort((a, b) => a.name.localeCompare(b.name))
}

export function getCapabilityTool(id: string, context?: RuntimeContextOptions) {
  return listCapabilityTools(context).find((tool) => tool.id === id) || null
}

export async function listCapabilitySkills(context?: RuntimeContextOptions): Promise<CapabilitySkill[]> {
  const effectiveSkills = await listEffectiveSkills(context)
  return effectiveSkills
    .map((skill) => ({
      name: skill.name,
      label: skill.label,
      description: skill.description,
      source: skill.source,
      origin: skill.origin,
      scope: skill.scope,
      location: skill.location,
      toolIds: skill.toolIds,
      agentNames: configuredAgentNamesForSkill(skill.name, context),
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

export async function getCapabilitySkillBundle(skillName: string, context?: RuntimeContextOptions): Promise<CapabilitySkillBundle | null> {
  return getEffectiveSkillBundle(skillName, context)
}

export function configuredToolLabels(toolIds: string[]) {
  return toolIds
    .map((toolId) => getConfiguredToolById(toolId)?.name || humanize(toolId))
    .sort((a, b) => a.localeCompare(b))
}

export function configuredSkillLabel(skillName: string) {
  const configured = getConfiguredSkillsFromConfig().find((skill) => skill.sourceName === skillName)
  if (configured) return configured.name
  return humanize(skillName)
}

export function configuredToolHasWriteAccess(toolId: string) {
  const tool = getConfiguredToolById(toolId)
  if (!tool) return false
  return getConfiguredToolAskPatterns(tool).length > 0
}
