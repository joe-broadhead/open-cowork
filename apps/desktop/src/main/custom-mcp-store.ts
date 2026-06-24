import { readJsoncFile, writeJsonFile, writeTopLevelObjectPropertyFile } from '@open-cowork/runtime-host'
import { rmSync } from 'fs'
import { join } from 'path'
import type {
  CustomMcpConfig,
  RuntimeContextOptions,
  ScopedArtifactRef,
} from '@open-cowork/shared'
import { log } from './logger.ts'
import {
  getMachineOpencodeDir,
  getProjectCoworkDir,
  resolveProjectDirectory,
  type NativeConfigScope,
} from './runtime-paths.ts'
import { assertCustomMcpContentLimits } from './custom-content-limits.ts'
import {
  configPathForTarget,
  mergeByName,
  targetDirectory,
  type JsonRecord,
} from './custom-store-common.ts'

type ManagedMcpMetadata = {
  label?: string
  description?: string
  googleAuth?: boolean
  allowPrivateNetwork?: boolean
  permissionMode?: 'allow'
  traceLabel?: string
  tracePluralLabel?: string
}

function mcpMetaPathForTarget(scope: NativeConfigScope, directory?: string | null) {
  if (scope === 'project') {
    return join(getProjectCoworkDir(targetDirectory(scope, directory)!), 'mcp.open-cowork.json')
  }
  return join(getMachineOpencodeDir(), 'mcp.open-cowork.json')
}

function readManagedMcpMetadata(
  scope: NativeConfigScope,
  directory?: string | null,
): Record<string, ManagedMcpMetadata> {
  const path = mcpMetaPathForTarget(scope, directory)
  try {
    const value = readJsoncFile<JsonRecord>(path)
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry && typeof entry === 'object' && !Array.isArray(entry))
        .map(([name, entry]) => {
          const record = entry as Record<string, unknown>
          return [name, {
            label: typeof record.label === 'string' ? record.label : undefined,
            description: typeof record.description === 'string' ? record.description : undefined,
            googleAuth: record.googleAuth === true ? true : undefined,
            allowPrivateNetwork: record.allowPrivateNetwork === true ? true : undefined,
            permissionMode: record.permissionMode === 'allow' ? 'allow' : undefined,
            traceLabel: typeof record.traceLabel === 'string' ? record.traceLabel : undefined,
            tracePluralLabel: typeof record.tracePluralLabel === 'string' ? record.tracePluralLabel : undefined,
          }]
        }),
    )
  } catch (error) {
    log('error', `Custom MCP metadata load failed: ${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
}

function writeManagedMcpMetadata(
  scope: NativeConfigScope,
  directory: string | null | undefined,
  updater: (current: Record<string, ManagedMcpMetadata>) => Record<string, ManagedMcpMetadata>,
) {
  const path = mcpMetaPathForTarget(scope, directory)
  const current = readManagedMcpMetadata(scope, directory)
  const next = updater(current)

  if (Object.keys(next).length === 0) {
    rmSync(path, { force: true })
    return
  }

  writeJsonFile(path, next as JsonRecord)
}

function repairStaleManagedMcpMetadata(
  scope: NativeConfigScope,
  directory: string | null | undefined,
  metadata: Record<string, ManagedMcpMetadata>,
  configuredNames: Set<string>,
) {
  const staleNames = Object.keys(metadata).filter((name) => !configuredNames.has(name))
  if (staleNames.length === 0) return

  log('warn', `Custom MCP metadata had stale entries without config: ${staleNames.join(', ')}. Repairing sidecar metadata.`)
  try {
    writeManagedMcpMetadata(scope, directory, (current) => {
      const next = { ...current }
      for (const name of staleNames) delete next[name]
      return next
    })
  } catch (error) {
    log('error', `Custom MCP metadata repair failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function serializeCustomMcp(mcp: CustomMcpConfig): JsonRecord {
  if (mcp.type === 'stdio') {
    if (!mcp.command?.trim()) {
      throw new Error('Local MCPs require a command.')
    }
    const entry: JsonRecord = {
      type: 'local',
      command: [mcp.command.trim(), ...(mcp.args || []).filter(Boolean)],
      enabled: true,
    }
    if (mcp.env && Object.keys(mcp.env).length > 0) {
      entry.environment = mcp.env
    }
    return entry
  }

  if (!mcp.url?.trim()) {
    throw new Error('Remote MCPs require a URL.')
  }

  const entry: JsonRecord = {
    type: 'remote',
    url: mcp.url.trim(),
    enabled: true,
  }
  if (mcp.headers && Object.keys(mcp.headers).length > 0) {
    entry.headers = mcp.headers
  }
  return entry
}

function parseCustomMcpEntry(
  name: string,
  value: unknown,
  scope: NativeConfigScope,
  metadata: ManagedMcpMetadata,
  directory?: string | null,
): CustomMcpConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entry = value as Record<string, unknown>
  const type = entry.type === 'local' ? 'stdio' : entry.type === 'remote' ? 'http' : null
  if (!type) return null

  const commandArray = Array.isArray(entry.command)
    ? entry.command.filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    : []

  return {
    scope,
    directory: scope === 'project' ? targetDirectory(scope, directory) : null,
    name,
    label: metadata.label,
    description: metadata.description,
    googleAuth: metadata.googleAuth,
    allowPrivateNetwork: metadata.allowPrivateNetwork,
    permissionMode: metadata.permissionMode,
    traceLabel: metadata.traceLabel,
    tracePluralLabel: metadata.tracePluralLabel,
    type,
    command: type === 'stdio' ? commandArray[0] : undefined,
    args: type === 'stdio' ? commandArray.slice(1) : undefined,
    env: entry.environment && typeof entry.environment === 'object' && !Array.isArray(entry.environment)
      ? Object.fromEntries(Object.entries(entry.environment as Record<string, unknown>).filter(([, raw]) => typeof raw === 'string')) as Record<string, string>
      : undefined,
    url: type === 'http' && typeof entry.url === 'string' ? entry.url : undefined,
    headers: entry.headers && typeof entry.headers === 'object' && !Array.isArray(entry.headers)
      ? Object.fromEntries(Object.entries(entry.headers as Record<string, unknown>).filter(([, raw]) => typeof raw === 'string')) as Record<string, string>
      : undefined,
  }
}

export function readScopedMcps(scope: NativeConfigScope, directory?: string | null) {
  const path = configPathForTarget(scope, directory)
  const config = readJsoncFile<JsonRecord>(path)
  const mcp = config.mcp
  const metadata = readManagedMcpMetadata(scope, directory)
  if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp)) {
    repairStaleManagedMcpMetadata(scope, directory, metadata, new Set())
    return []
  }
  const entries = Object.entries(mcp)
  repairStaleManagedMcpMetadata(scope, directory, metadata, new Set(entries.map(([name]) => name)))
  return entries
    .map(([name, value]) => parseCustomMcpEntry(name, value, scope, metadata[name] || {}, directory))
    .filter((entry): entry is CustomMcpConfig => Boolean(entry))
}

function readScopedMcpConfig(
  scope: NativeConfigScope,
  directory: string | null | undefined,
): Record<string, unknown> {
  const path = configPathForTarget(scope, directory)
  const config = readJsoncFile<JsonRecord>(path)
  return config.mcp && typeof config.mcp === 'object' && !Array.isArray(config.mcp)
    ? { ...(config.mcp as Record<string, unknown>) }
    : {}
}

function updateScopedMcpConfig(
  scope: NativeConfigScope,
  directory: string | null | undefined,
  updater: (mcp: Record<string, unknown>) => Record<string, unknown>,
) {
  const path = configPathForTarget(scope, directory)
  const config = readJsoncFile<JsonRecord>(path)
  const nextMcp = updater(
    config.mcp && typeof config.mcp === 'object' && !Array.isArray(config.mcp)
      ? { ...(config.mcp as Record<string, unknown>) }
      : {},
  )

  if (Object.keys(nextMcp).length === 0 && Object.keys(config).length === 0) {
    rmSync(path, { force: true })
    return
  }

  writeTopLevelObjectPropertyFile(path, 'mcp', Object.keys(nextMcp).length === 0 ? null : nextMcp)
}

function restoreScopedMcpConfigAfterMetadataFailure(
  scope: NativeConfigScope,
  directory: string | null | undefined,
  previousMcp: Record<string, unknown>,
  error: unknown,
) {
  try {
    updateScopedMcpConfig(scope, directory, () => ({ ...previousMcp }))
  } catch (rollbackError) {
    throw new Error(
      `Custom MCP metadata write failed (${error instanceof Error ? error.message : String(error)}), and OpenCode MCP config rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      { cause: rollbackError },
    )
  }
  throw new Error(
    `Custom MCP metadata write failed after OpenCode MCP config update; restored previous MCP config: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  )
}

export function listCustomMcps(context?: RuntimeContextOptions) {
  const projectDirectory = resolveProjectDirectory(context?.directory)
  const entries = [
    ...readScopedMcps('machine'),
    ...(projectDirectory ? readScopedMcps('project', projectDirectory) : []),
  ]
  return mergeByName(entries)
}

export function saveCustomMcp(mcp: CustomMcpConfig) {
  assertCustomMcpContentLimits(mcp)
  const previousMcp = readScopedMcpConfig(mcp.scope, mcp.directory)
  updateScopedMcpConfig(mcp.scope, mcp.directory, (current) => ({
    ...current,
    [mcp.name]: serializeCustomMcp(mcp),
  }))
  try {
    writeManagedMcpMetadata(mcp.scope, mcp.directory, (current) => {
      const next = { ...current }
      const label = mcp.label?.trim() || undefined
      const description = mcp.description?.trim() || undefined
      const metadata: ManagedMcpMetadata = {
        label,
        description,
        googleAuth: mcp.googleAuth === true ? true : undefined,
        allowPrivateNetwork: mcp.allowPrivateNetwork === true ? true : undefined,
        permissionMode: mcp.permissionMode === 'allow' ? 'allow' : undefined,
        traceLabel: mcp.traceLabel?.trim() || undefined,
        tracePluralLabel: mcp.tracePluralLabel?.trim() || undefined,
      }
      if (!metadata.label && !metadata.description && !metadata.googleAuth && !metadata.allowPrivateNetwork && !metadata.permissionMode && !metadata.traceLabel && !metadata.tracePluralLabel) {
        delete next[mcp.name]
        return next
      }
      next[mcp.name] = metadata
      return next
    })
  } catch (error) {
    restoreScopedMcpConfigAfterMetadataFailure(mcp.scope, mcp.directory, previousMcp, error)
  }
  return true
}

export function removeCustomMcp(target: ScopedArtifactRef) {
  const previousMcp = readScopedMcpConfig(target.scope, target.directory)
  updateScopedMcpConfig(target.scope, target.directory, (current) => {
    const next = { ...current }
    delete next[target.name]
    return next
  })
  try {
    writeManagedMcpMetadata(target.scope, target.directory, (current) => {
      const next = { ...current }
      delete next[target.name]
      return next
    })
  } catch (error) {
    restoreScopedMcpConfigAfterMetadataFailure(target.scope, target.directory, previousMcp, error)
  }
  return true
}
