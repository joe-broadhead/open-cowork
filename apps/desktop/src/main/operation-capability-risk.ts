import {
  COWORK_OPERATION_SCHEMA_VERSION,
  type CapabilityRiskLevel,
  type CapabilityRiskMetadata,
} from '@open-cowork/shared'
import { configuredToolMayWrite } from './agent-tool-access.ts'
import {
  getConfiguredSkillsFromConfig,
  getConfiguredToolAskPatterns,
  getConfiguredToolById,
  getConfiguredToolPatterns,
  getConfiguredToolsFromConfig,
} from './config-loader.ts'
import type { ConfiguredTool } from './config-types.ts'

const RISK_ORDER: Record<CapabilityRiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
}

const NATIVE_TOOL_RISK: Array<Omit<CapabilityRiskMetadata, 'schemaVersion'>> = [
  {
    capabilityId: 'native:read',
    toolPattern: 'read',
    risk: 'low',
    writeCapable: false,
    approvalRequired: false,
    reason: 'Reads files already available to the OpenCode runtime.',
  },
  {
    capabilityId: 'native:grep',
    toolPattern: 'grep',
    risk: 'low',
    writeCapable: false,
    approvalRequired: false,
    reason: 'Searches readable local files without writing.',
  },
  {
    capabilityId: 'native:glob',
    toolPattern: 'glob',
    risk: 'low',
    writeCapable: false,
    approvalRequired: false,
    reason: 'Lists matching readable paths without writing.',
  },
  {
    capabilityId: 'native:list',
    toolPattern: 'list',
    risk: 'low',
    writeCapable: false,
    approvalRequired: false,
    reason: 'Lists readable directories without writing.',
  },
  {
    capabilityId: 'native:question',
    toolPattern: 'question',
    risk: 'low',
    writeCapable: false,
    approvalRequired: false,
    reason: 'Asks the user for more information; no external side effect.',
  },
  {
    capabilityId: 'native:websearch',
    toolPattern: 'websearch',
    risk: 'medium',
    writeCapable: false,
    approvalRequired: false,
    reason: 'Reads external web search results and may disclose query text to a provider.',
  },
  {
    capabilityId: 'native:webfetch',
    toolPattern: 'webfetch',
    risk: 'medium',
    writeCapable: false,
    approvalRequired: false,
    reason: 'Reads external URLs and may disclose target URLs to a provider.',
  },
  {
    capabilityId: 'native:codesearch',
    toolPattern: 'codesearch',
    risk: 'medium',
    writeCapable: false,
    approvalRequired: false,
    reason: 'Searches code through a provider-backed capability without writing.',
  },
  {
    capabilityId: 'native:todowrite',
    toolPattern: 'todowrite',
    risk: 'medium',
    writeCapable: true,
    approvalRequired: false,
    reason: 'Mutates OpenCode todo state but not project files or external systems.',
  },
  {
    capabilityId: 'native:bash',
    toolPattern: 'bash',
    risk: 'high',
    writeCapable: true,
    approvalRequired: true,
    reason: 'Runs shell commands that can read, write, or call external systems.',
  },
  {
    capabilityId: 'native:edit',
    toolPattern: 'edit',
    risk: 'high',
    writeCapable: true,
    approvalRequired: true,
    reason: 'Edits files inside granted runtime/project authority.',
  },
  {
    capabilityId: 'native:write',
    toolPattern: 'write',
    risk: 'high',
    writeCapable: true,
    approvalRequired: true,
    reason: 'Writes files inside granted runtime/project authority.',
  },
  {
    capabilityId: 'native:apply_patch',
    toolPattern: 'apply_patch',
    risk: 'high',
    writeCapable: true,
    approvalRequired: true,
    reason: 'Applies file patches inside granted runtime/project authority.',
  },
]

function withSchema(row: Omit<CapabilityRiskMetadata, 'schemaVersion'>): CapabilityRiskMetadata {
  return {
    schemaVersion: COWORK_OPERATION_SCHEMA_VERSION,
    ...row,
  }
}

function maxRisk(...levels: CapabilityRiskLevel[]) {
  return levels.reduce<CapabilityRiskLevel>((highest, next) => (
    RISK_ORDER[next] > RISK_ORDER[highest] ? next : highest
  ), 'low')
}

function configuredToolRisk(tool: ConfiguredTool) {
  const writeCapable = configuredToolMayWrite(tool.id)
  const approvalRequired = getConfiguredToolAskPatterns(tool).length > 0
  const risk: CapabilityRiskLevel = writeCapable
    ? (approvalRequired ? 'high' : 'medium')
    : 'low'
  return { risk, writeCapable, approvalRequired }
}

function configuredToolReason(tool: ConfiguredTool, writeCapable: boolean, approvalRequired: boolean) {
  if (!writeCapable) return `${tool.name} is configured as read-only.`
  if (approvalRequired) return `${tool.name} has write-capable operations behind ask/approval patterns.`
  return `${tool.name} has write-capable operations in its allowlisted patterns.`
}

function configuredToolMetadata(tool: ConfiguredTool) {
  const patterns = Array.from(new Set(getConfiguredToolPatterns(tool))).sort((a, b) => a.localeCompare(b))
  const { risk, writeCapable, approvalRequired } = configuredToolRisk(tool)
  const reason = configuredToolReason(tool, writeCapable, approvalRequired)
  const rows = patterns.length > 0 ? patterns : [null]
  return rows.map((pattern) => withSchema({
    capabilityId: `tool:${tool.id}`,
    toolPattern: pattern,
    risk,
    writeCapable,
    approvalRequired,
    reason,
  }))
}

function skillRisk(toolIds: string[] = []) {
  const toolRisks = toolIds
    .map((toolId) => getConfiguredToolById(toolId))
    .filter((tool): tool is ConfiguredTool => Boolean(tool))
    .map(configuredToolRisk)
  return {
    risk: maxRisk(...toolRisks.map((entry) => entry.risk)),
    writeCapable: toolRisks.some((entry) => entry.writeCapable),
    approvalRequired: toolRisks.some((entry) => entry.approvalRequired),
  }
}

export function listCapabilityRiskMetadata() {
  const nativeRows = NATIVE_TOOL_RISK.map(withSchema)
  const toolRows = getConfiguredToolsFromConfig()
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .flatMap(configuredToolMetadata)
  const skillRows = getConfiguredSkillsFromConfig()
    .slice()
    .sort((a, b) => a.sourceName.localeCompare(b.sourceName))
    .map((skill) => {
      const { risk, writeCapable, approvalRequired } = skillRisk(skill.toolIds)
      const linkedTools = skill.toolIds?.length ? skill.toolIds.join(', ') : 'no linked tools'
      return withSchema({
        capabilityId: `skill:${skill.sourceName}`,
        toolPattern: null,
        risk,
        writeCapable,
        approvalRequired,
        reason: `${skill.name} inherits authority from ${linkedTools}.`,
      })
    })

  return [...nativeRows, ...toolRows, ...skillRows].sort((a, b) => (
    a.capabilityId.localeCompare(b.capabilityId) || String(a.toolPattern || '').localeCompare(String(b.toolPattern || ''))
  ))
}
