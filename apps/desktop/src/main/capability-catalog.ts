import type { CapabilitySkill, CapabilitySkillBundle, CapabilityTool, CapabilityToolEntry, RuntimeContextOptions } from '@open-cowork/shared'
import {
  getConfiguredAgentsFromConfig,
  getConfiguredMcpsFromConfig,
  getConfiguredToolById,
  getConfiguredToolPatterns,
  getConfiguredToolsFromConfig,
} from './config-loader.ts'
import { listCustomAgents, listCustomMcps, listCustomSkills } from './native-customizations.ts'
import { summarizeCustomAgents, type CustomAgentCatalogSkill } from './custom-agents-utils.ts'
import { getEffectiveSkillBundle, listEffectiveSkills, listEffectiveSkillsSync } from './effective-skills.ts'
import { getEffectiveSettings } from './settings.ts'

function humanize(value: string) {
  return value
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function namespaceFromPattern(pattern: string) {
  if (!pattern.startsWith('mcp__')) return null
  const end = pattern.indexOf('__', 'mcp__'.length)
  if (end <= 'mcp__'.length) return null
  const namespace = pattern.slice('mcp__'.length, end)
  return /^[a-zA-Z0-9-]+$/.test(namespace) ? namespace : null
}

function listRuntimeEligibleCustomAgents(
  availableSkills: CustomAgentCatalogSkill[],
  context?: RuntimeContextOptions,
) {
  const customMcps = listCustomMcps(context)
  const customSkills = listCustomSkills(context)
  const customAgents = listCustomAgents(context)
  return summarizeCustomAgents({
    availableSkills,
    state: {
      customMcps,
      customSkills,
      customAgents,
    },
  }).filter((agent) => agent.enabled && agent.valid)
}

function configuredAgentNamesForTool(
  toolId: string,
  availableSkills: CustomAgentCatalogSkill[],
  context?: RuntimeContextOptions,
) {
  const builtIn = getConfiguredAgentsFromConfig()
    .filter((agent) => (agent.toolIds || []).includes(toolId))
    .map((agent) => agent.label || agent.name)
  const custom = listRuntimeEligibleCustomAgents(availableSkills, context)
    .filter((agent) => agent.toolIds.includes(toolId))
    .map((agent) => humanize(agent.name))
  return Array.from(new Set([...builtIn, ...custom])).sort((a, b) => a.localeCompare(b))
}

function configuredAgentNamesForSkill(
  skillName: string,
  availableSkills: CustomAgentCatalogSkill[],
  context?: RuntimeContextOptions,
) {
  const builtIn = getConfiguredAgentsFromConfig()
    .filter((agent) => (agent.skillNames || []).includes(skillName))
    .map((agent) => agent.label || agent.name)
  const custom = listRuntimeEligibleCustomAgents(availableSkills, context)
    .filter((agent) => agent.skillNames.includes(skillName))
    .map((agent) => humanize(agent.name))
  return Array.from(new Set([...builtIn, ...custom])).sort((a, b) => a.localeCompare(b))
}

export function listCapabilityTools(context?: RuntimeContextOptions): CapabilityTool[] {
  const availableSkills = listEffectiveSkillsSync(context).map((skill) => ({
    name: skill.name,
    label: skill.label,
    description: skill.description,
    source: skill.source,
    origin: skill.origin,
    scope: skill.scope,
    location: skill.location,
    toolIds: skill.toolIds,
  }))
  // Index configured MCPs by name so we can splice their credential
  // metadata onto the matching Tool entry. Downstream bundles (e.g. the
  // GitHub hosted MCP, Perplexity) declare credentials on the MCP
  // itself; the UI drives its input forms off the CapabilityTool shape,
  // so we forward the metadata there.
  const mcpByNamespace = new Map(
    getConfiguredMcpsFromConfig().map((mcp) => [mcp.name, mcp] as const),
  )
  // Snapshot current user-level enable overrides so the renderer can
  // position the Enable toggle without a second IPC. Reads `Partial`
  // because older settings files may be missing the field; the map
  // defaults to {} in that case.
  const enabledOverrides = getEffectiveSettings().integrationEnabled || {}

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
      agentNames: configuredAgentNamesForTool(tool.id, availableSkills, context),
      // For every MCP-backed tool, forward the integration id + auth
      // metadata + current enable state so the detail view can render
      // the right CTA (credential form for api_token, "Enable & sign
      // in" for oauth, just the toggle for none). Credentials are
      // only included when the MCP declares them. Non-MCP tools (ask,
      // invoke-agent) leave all of these undefined.
      ...(backingMcp
        ? {
          integrationId: backingMcp.name,
          authMode: backingMcp.authMode,
          enabled: enabledOverrides[backingMcp.name],
          ...(backingMcp.credentials && backingMcp.credentials.length > 0
            ? { credentials: backingMcp.credentials }
            : {}),
        }
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
      agentNames: configuredAgentNamesForTool(entry.name, availableSkills, context),
    }))

  return [...configured, ...custom].sort((a, b) => a.name.localeCompare(b.name))
}

export function getCapabilityTool(id: string, context?: RuntimeContextOptions) {
  return listCapabilityTools(context).find((tool) => tool.id === id) || null
}

export async function listCapabilitySkills(context?: RuntimeContextOptions): Promise<CapabilitySkill[]> {
  const effectiveSkills = await listEffectiveSkills(context)
  const availableSkills = effectiveSkills.map((skill) => ({
    name: skill.name,
    label: skill.label,
    description: skill.description,
    source: skill.source,
    origin: skill.origin,
    scope: skill.scope,
    location: skill.location,
    toolIds: skill.toolIds,
  }))
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
      agentNames: configuredAgentNamesForSkill(skill.name, availableSkills, context),
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
