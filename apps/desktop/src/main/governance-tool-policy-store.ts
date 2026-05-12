import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GovernanceRevokedTool } from '@open-cowork/shared'
import { COWORK_GOVERNANCE_SCHEMA_VERSION } from '@open-cowork/shared'
import { getAppDataDir } from './config-loader.ts'
import { writeFileAtomic } from './fs-atomic.ts'

const GOVERNANCE_TOOL_POLICY_FILENAME = 'governance-tool-policy.json'
const MAX_TOOL_ID_BYTES = 512
const MAX_LABEL_BYTES = 1024
const MAX_REASON_BYTES = 16 * 1024
const MAX_PATTERN_BYTES = 1024
const MAX_DIRECTORY_BYTES = 4096
const MAX_REVOKED_TOOL_COUNT = 512
const MAX_PATTERN_COUNT = 128

const TOOL_SOURCES = new Set(['configured', 'custom-mcp', 'native'])
const TOOL_SCOPES = new Set(['system', 'machine', 'project'])

let revokedToolCache: GovernanceRevokedTool[] | null = null

function policyPath() {
  return join(getAppDataDir(), GOVERNANCE_TOOL_POLICY_FILENAME)
}

function nowIso() {
  return new Date().toISOString()
}

function boundedString(value: unknown, label: string, maxBytes: number) {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`)
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} is required.`)
  if (Buffer.byteLength(normalized, 'utf8') > maxBytes) throw new Error(`${label} is too large.`)
  return normalized
}

function optionalBoundedString(value: unknown, label: string, maxBytes: number) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`)
  const normalized = value.trim()
  if (!normalized) return null
  if (Buffer.byteLength(normalized, 'utf8') > maxBytes) throw new Error(`${label} is too large.`)
  return normalized
}

function normalizePatterns(value: unknown) {
  const raw = Array.isArray(value) ? value : []
  const patterns = Array.from(new Set(raw
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean)))
  if (patterns.length === 0) throw new Error('Revoked tool policy requires at least one permission pattern.')
  if (patterns.length > MAX_PATTERN_COUNT) throw new Error('Revoked tool policy has too many permission patterns.')
  for (const pattern of patterns) {
    if (Buffer.byteLength(pattern, 'utf8') > MAX_PATTERN_BYTES) {
      throw new Error('Revoked tool permission pattern is too large.')
    }
  }
  return patterns
}

function normalizeRevokedTool(value: unknown): GovernanceRevokedTool | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const toolId = optionalBoundedString(record.toolId, 'Revoked tool id', MAX_TOOL_ID_BYTES)
  if (!toolId) return null
  const label = optionalBoundedString(record.label, 'Revoked tool label', MAX_LABEL_BYTES) || toolId
  const patterns = normalizePatterns(record.patterns)
  const source = typeof record.source === 'string' && TOOL_SOURCES.has(record.source)
    ? record.source as GovernanceRevokedTool['source']
    : 'configured'
  const scope = typeof record.scope === 'string' && TOOL_SCOPES.has(record.scope)
    ? record.scope as GovernanceRevokedTool['scope']
    : 'system'
  const directory = scope === 'project' ? optionalBoundedString(record.directory, 'Revoked tool directory', MAX_DIRECTORY_BYTES) : null
  if (scope === 'project' && !directory) return null
  const revokedAt = optionalBoundedString(record.revokedAt, 'Revoked tool timestamp', 128) || nowIso()
  const revokedBy = optionalBoundedString(record.revokedBy, 'Revoked tool actor', 512) || 'local-user'
  return {
    schemaVersion: COWORK_GOVERNANCE_SCHEMA_VERSION,
    toolId,
    label,
    patterns,
    source,
    scope,
    directory,
    revokedAt,
    revokedBy,
    reason: optionalBoundedString(record.reason, 'Revoked tool reason', MAX_REASON_BYTES),
  }
}

function readPolicyFile(): GovernanceRevokedTool[] {
  const path = policyPath()
  if (!existsSync(path)) return []
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  const rawTools = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>).revokedTools
    : null
  const entries = Array.isArray(rawTools)
    ? rawTools.map(normalizeRevokedTool).filter((entry): entry is GovernanceRevokedTool => Boolean(entry))
    : []
  return entries.slice(0, MAX_REVOKED_TOOL_COUNT)
}

function writePolicyFile(entries: GovernanceRevokedTool[]) {
  const sorted = [...entries].sort((left, right) => revokedToolKey(left).localeCompare(revokedToolKey(right)))
  writeFileAtomic(policyPath(), `${JSON.stringify({
    schemaVersion: COWORK_GOVERNANCE_SCHEMA_VERSION,
    revokedTools: sorted,
  }, null, 2)}\n`, { mode: 0o600 })
  revokedToolCache = sorted
}

export function clearGovernanceToolPolicyCache() {
  revokedToolCache = null
}

export function listRevokedGovernanceTools(): GovernanceRevokedTool[] {
  if (!revokedToolCache) revokedToolCache = readPolicyFile()
  return revokedToolCache.map((entry) => ({
    ...entry,
    patterns: [...entry.patterns],
  }))
}

function revokedToolKey(input: {
  toolId: string
  source: GovernanceRevokedTool['source']
  scope: GovernanceRevokedTool['scope']
  directory?: string | null
}) {
  return [input.source, input.scope, input.directory || '', input.toolId].join('\u0000')
}

export function getRevokedGovernanceTool(
  toolId: string,
  options?: {
    source?: GovernanceRevokedTool['source']
    scope?: GovernanceRevokedTool['scope']
    directory?: string | null
  },
) {
  if (!options?.source || !options.scope) {
    return listRevokedGovernanceTools().find((entry) => entry.toolId === toolId) || null
  }
  const key = revokedToolKey({
    toolId,
    source: options.source,
    scope: options.scope,
    directory: options.directory,
  })
  return listRevokedGovernanceTools().find((entry) => revokedToolKey(entry) === key) || null
}

export function saveRevokedGovernanceTool(input: {
  toolId: string
  label: string
  patterns: string[]
  source: GovernanceRevokedTool['source']
  scope: GovernanceRevokedTool['scope']
  directory?: string | null
  reason?: string | null
  revokedBy?: string | null
}): GovernanceRevokedTool {
  const toolId = boundedString(input.toolId, 'Revoked tool id', MAX_TOOL_ID_BYTES)
  const source = TOOL_SOURCES.has(input.source) ? input.source : 'configured'
  const scope = TOOL_SCOPES.has(input.scope) ? input.scope : 'system'
  const directory = scope === 'project'
    ? optionalBoundedString(input.directory, 'Revoked tool directory', MAX_DIRECTORY_BYTES)
    : null
  if (scope === 'project' && !directory) throw new Error('Project-scoped revoked tool policy requires a directory.')
  const existing = getRevokedGovernanceTool(toolId, { source, scope, directory })
  if (existing) throw new Error(`Tool ${toolId} is already revoked.`)
  const entry: GovernanceRevokedTool = {
    schemaVersion: COWORK_GOVERNANCE_SCHEMA_VERSION,
    toolId,
    label: boundedString(input.label, 'Revoked tool label', MAX_LABEL_BYTES),
    patterns: normalizePatterns(input.patterns),
    source,
    scope,
    directory,
    revokedAt: nowIso(),
    revokedBy: optionalBoundedString(input.revokedBy, 'Revoked tool actor', 512) || 'local-user',
    reason: optionalBoundedString(input.reason, 'Revoked tool reason', MAX_REASON_BYTES),
  }
  const entries = [...listRevokedGovernanceTools(), entry]
  if (entries.length > MAX_REVOKED_TOOL_COUNT) throw new Error('Too many revoked tools are recorded.')
  writePolicyFile(entries)
  return {
    ...entry,
    patterns: [...entry.patterns],
  }
}
