import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, resolve } from 'path'
import type { CapabilitySkill, CapabilitySkillBundle, CapabilityTool, CapabilityToolEntry } from '@open-cowork/shared'
import {
  getConfiguredAgentsFromConfig,
  getConfiguredSkillsFromConfig,
  getConfiguredToolAskPatterns,
  getConfiguredToolById,
  getConfiguredToolPatterns,
  getConfiguredToolsFromConfig,
} from './config-loader.ts'
import { loadSettings } from './settings.ts'
import { getCustomSkill, listCustomSkills } from './custom-skills.ts'
import { normalizeCustomAgent } from './custom-agents-utils.ts'

function humanize(value: string) {
  return value
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function extractFrontmatterField(content: string, field: string) {
  const match = content.match(new RegExp(`^---\\n[\\s\\S]*?\\n${field}:\\s*["']?(.+?)["']?\\s*(?:\\n|$)`, 'm'))
  return match?.[1]?.trim() || null
}

function listBundleFiles(root: string, current = root): Array<{ path: string }> {
  const files: Array<{ path: string }> = []
  if (!existsSync(current)) return files

  for (const entry of readdirSync(current)) {
    const fullPath = join(current, entry)
    let stats
    try {
      stats = statSync(fullPath)
    } catch {
      continue
    }

    if (stats.isDirectory()) {
      files.push(...listBundleFiles(root, fullPath))
      continue
    }

    const filePath = relative(root, fullPath).replace(/\\/g, '/')
    if (filePath === 'SKILL.md') continue
    files.push({ path: filePath })
  }

  return files.sort((a, b) => a.path.localeCompare(b.path))
}

function namespaceFromPattern(pattern: string) {
  const match = pattern.match(/^mcp__([^_]+(?:-[^_]+)*)__/)
  return match?.[1] || null
}

function bundledSkillRoots() {
  const downstreamRoot = process.env.OPEN_COWORK_DOWNSTREAM_ROOT?.trim()
  return [
    ...(downstreamRoot ? [join(downstreamRoot, 'skills')] : []),
    resolve(process.cwd(), 'skills'),
    ...(process.resourcesPath ? [join(process.resourcesPath, 'skills')] : []),
  ]
}

function findBundledSkillDir(skillName: string) {
  for (const root of bundledSkillRoots()) {
    const direct = join(root, skillName)
    if (existsSync(join(direct, 'SKILL.md'))) return direct
  }
  return null
}

function readBundledSkillBundle(skillName: string): CapabilitySkillBundle | null {
  const skillDir = findBundledSkillDir(skillName)
  if (!skillDir) return null
  const contentPath = join(skillDir, 'SKILL.md')
  if (!existsSync(contentPath)) return null

  return {
    name: skillName,
    source: 'builtin',
    content: readFileSync(contentPath, 'utf-8'),
    files: listBundleFiles(skillDir),
  }
}

function configuredAgentNamesForTool(toolId: string) {
  const builtIn = getConfiguredAgentsFromConfig()
    .filter((agent) => (agent.toolIds || []).includes(toolId))
    .map((agent) => agent.label || agent.name)
  const custom = (loadSettings().customAgents || [])
    .map((agent) => normalizeCustomAgent(agent as any))
    .filter((agent) => agent.toolIds.includes(toolId) && agent.enabled)
    .map((agent) => humanize(agent.name))
  return Array.from(new Set([...builtIn, ...custom])).sort((a, b) => a.localeCompare(b))
}

function configuredAgentNamesForSkill(skillName: string) {
  const builtIn = getConfiguredAgentsFromConfig()
    .filter((agent) => (agent.skillNames || []).includes(skillName))
    .map((agent) => agent.label || agent.name)
  const custom = (loadSettings().customAgents || [])
    .map((agent) => normalizeCustomAgent(agent as any))
    .filter((agent) => agent.skillNames.includes(skillName) && agent.enabled)
    .map((agent) => humanize(agent.name))
  return Array.from(new Set([...builtIn, ...custom])).sort((a, b) => a.localeCompare(b))
}

export function listCapabilityTools(): CapabilityTool[] {
  const configured = getConfiguredToolsFromConfig().map((tool) => {
    const patterns = getConfiguredToolPatterns(tool)
    const namespace = tool.namespace || patterns.map(namespaceFromPattern).find(Boolean) || null

    return {
      id: tool.id,
      name: tool.name,
      icon: tool.icon,
      description: tool.description,
      kind: tool.kind,
      source: 'builtin' as const,
      origin: 'open-cowork' as const,
      namespace,
      patterns,
      availableTools: [] as CapabilityToolEntry[],
      agentNames: configuredAgentNamesForTool(tool.id),
    }
  })

  const custom = (loadSettings().customMcps || [])
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
      namespace: entry.name,
      patterns: [`mcp__${entry.name}__*`],
      availableTools: [] as CapabilityToolEntry[],
      agentNames: configuredAgentNamesForTool(entry.name),
    }))

  return [...configured, ...custom].sort((a, b) => a.name.localeCompare(b.name))
}

export function getCapabilityTool(id: string) {
  return listCapabilityTools().find((tool) => tool.id === id) || null
}

export function listCapabilitySkills(): CapabilitySkill[] {
  const builtin = getConfiguredSkillsFromConfig().map((skill) => {
    const bundle = readBundledSkillBundle(skill.sourceName)
    return {
      name: skill.sourceName,
      label: skill.name || extractFrontmatterField(bundle?.content || '', 'title') || humanize(skill.sourceName),
      description: extractFrontmatterField(bundle?.content || '', 'description') || skill.description,
      source: 'builtin' as const,
      toolIds: [...(skill.toolIds || [])],
      agentNames: configuredAgentNamesForSkill(skill.sourceName),
    }
  })

  const custom = listCustomSkills().map((skill) => ({
    name: skill.name,
    label: extractFrontmatterField(skill.content, 'title') || extractFrontmatterField(skill.content, 'name') || humanize(skill.name),
    description: extractFrontmatterField(skill.content, 'description') || 'Custom skill',
    source: 'custom' as const,
    toolIds: undefined,
    agentNames: configuredAgentNamesForSkill(skill.name),
  }))

  return [...builtin, ...custom].sort((a, b) => a.label.localeCompare(b.label))
}

export function getCapabilitySkillBundle(skillName: string): CapabilitySkillBundle | null {
  const custom = getCustomSkill(skillName)
  if (custom) {
    return {
      name: custom.name,
      source: 'custom',
      content: custom.content,
      files: (custom.files || []).map((file) => ({ path: file.path })),
    }
  }

  return readBundledSkillBundle(skillName)
}

export function configuredToolLabels(toolIds: string[]) {
  return toolIds
    .map((toolId) => getConfiguredToolById(toolId)?.name || humanize(toolId))
    .sort((a, b) => a.localeCompare(b))
}

export function configuredSkillLabel(skillName: string) {
  const configured = getConfiguredSkillsFromConfig().find((skill) => skill.sourceName === skillName)
  if (configured) return configured.name
  const bundle = getCapabilitySkillBundle(skillName)
  return extractFrontmatterField(bundle?.content || '', 'title')
    || extractFrontmatterField(bundle?.content || '', 'name')
    || humanize(skillName)
}

export function configuredToolHasWriteAccess(toolId: string) {
  const tool = getConfiguredToolById(toolId)
  if (!tool) return false
  return getConfiguredToolAskPatterns(tool).length > 0
}
