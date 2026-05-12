import type { CustomMcpConfig, RuntimeContextOptions } from '@open-cowork/shared'
import {
  expandMcpToolPermissionPatterns,
  getConfiguredToolById,
  getConfiguredToolPatterns,
} from './config-loader.ts'
import { listCustomMcps } from './native-customizations.ts'
import { listRevokedGovernanceTools } from './governance-tool-policy-store.ts'
import { nativeToolLabels } from './agent-tool-access.ts'
import { resolveProjectDirectory } from './runtime-paths.ts'

const NATIVE_TOOL_IDS = new Set([
  'read',
  'grep',
  'glob',
  'list',
  'websearch',
  'webfetch',
  'codesearch',
  'bash',
  'edit',
  'write',
  'apply_patch',
  'question',
  'todowrite',
])

export type ResolvedToolControlTarget = {
  toolId: string
  label: string
  patterns: string[]
  source: 'configured' | 'custom-mcp' | 'native'
  scope: 'system' | 'machine' | 'project'
  directory: string | null
}

function customMcpLabel(mcp: CustomMcpConfig) {
  const explicit = mcp.label?.trim()
  if (explicit) return explicit
  return mcp.name
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
    || mcp.name
}

function uniquePatterns(patterns: string[]) {
  return Array.from(new Set(patterns.map((pattern) => pattern.trim()).filter(Boolean)))
}

export function resolveGovernanceToolControlTarget(
  toolId: string,
  options?: RuntimeContextOptions,
): ResolvedToolControlTarget | null {
  const configured = getConfiguredToolById(toolId)
  if (configured) {
    return {
      toolId,
      label: configured.name,
      patterns: uniquePatterns(expandMcpToolPermissionPatterns(getConfiguredToolPatterns(configured))),
      source: 'configured',
      scope: 'system',
      directory: null,
    }
  }

  const custom = listCustomMcps(options).find((entry) => entry.name === toolId)
  if (custom) {
    return {
      toolId,
      label: customMcpLabel(custom),
      patterns: uniquePatterns(expandMcpToolPermissionPatterns([`mcp__${custom.name}__*`])),
      source: 'custom-mcp',
      scope: custom.scope,
      directory: custom.scope === 'project' ? custom.directory || null : null,
    }
  }

  if (NATIVE_TOOL_IDS.has(toolId)) {
    return {
      toolId,
      label: nativeToolLabels([toolId])[0] || toolId,
      patterns: [toolId],
      source: 'native',
      scope: 'system',
      directory: null,
    }
  }

  return null
}

export function listRevokedToolPermissionPatterns(options?: RuntimeContextOptions): string[] {
  const patterns = new Set<string>()
  for (const revoked of listApplicableRevokedGovernanceTools(options)) {
    for (const pattern of revoked.patterns) patterns.add(pattern)
    const current = resolveGovernanceToolControlTarget(revoked.toolId, options)
    for (const pattern of current?.patterns || []) patterns.add(pattern)
  }
  return [...patterns].sort((left, right) => left.localeCompare(right))
}

export function revokedToolAppliesToContext(
  revoked: { scope?: string | null, directory?: string | null },
  options?: RuntimeContextOptions,
) {
  if (revoked.scope !== 'project') return true
  const revokedDirectory = resolveProjectDirectory(revoked.directory)
  const contextDirectory = resolveProjectDirectory(options?.directory)
  return Boolean(revokedDirectory && contextDirectory && revokedDirectory === contextDirectory)
}

export function listApplicableRevokedGovernanceTools(options?: RuntimeContextOptions) {
  return listRevokedGovernanceTools()
    .filter((revoked) => revokedToolAppliesToContext(revoked, options))
}
