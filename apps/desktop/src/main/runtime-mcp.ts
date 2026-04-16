import electron from 'electron'
import { existsSync } from 'fs'
import { join, resolve } from 'path'
import type { CustomMcpConfig } from '@open-cowork/shared'
import { getConfiguredMcpsFromConfig, type BundleMcp } from './config-loader.ts'
import { getIntegrationCredentialValue, getEffectiveSettings, type CoworkSettings } from './settings.ts'
import { getMachineSkillsDir } from './runtime-paths.ts'

const electronApp = (electron as { app?: typeof import('electron').app }).app

function resourcePath(...segments: string[]) {
  if (electronApp?.isPackaged) {
    return join(process.resourcesPath, ...segments)
  }
  const appPath = electronApp?.getAppPath?.() || process.cwd()
  return resolve(appPath, '..', '..', ...segments)
}

function mcpPath(name: string) {
  const downstreamRoot = process.env.OPEN_COWORK_DOWNSTREAM_ROOT?.trim()
  if (downstreamRoot) {
    const downstreamMcp = join(downstreamRoot, 'mcps', name, 'dist', 'index.js')
    if (existsSync(downstreamMcp)) return downstreamMcp
  }
  return resourcePath('mcps', name, 'dist', 'index.js')
}

export type ResolvedRuntimeMcpEntry =
  | {
    type: 'local'
    command: string[]
    environment?: Record<string, string>
  }
  | {
    type: 'remote'
    url: string
    headers?: Record<string, string>
  }

function resolveBuiltInMcpEntry(builtin: BundleMcp, settings: CoworkSettings): ResolvedRuntimeMcpEntry | null {
  if (builtin.type === 'local') {
    const entry: ResolvedRuntimeMcpEntry = {
      type: 'local',
      command: builtin.command || ['node', mcpPath(builtin.packageName || builtin.name)],
    }
    const env: Record<string, string> = {}

    for (const envSetting of builtin.envSettings || []) {
      const value = getIntegrationCredentialValue(settings, builtin.name, envSetting.key)
      if (!value) continue
      env[envSetting.env] = value
    }

    if (builtin.name === 'skills') {
      env.OPEN_COWORK_CUSTOM_SKILLS_DIR = getMachineSkillsDir()
    }

    if (Object.keys(env).length > 0) entry.environment = env
    return entry
  }

  if (builtin.url) {
    const headers: Record<string, string> = { ...(builtin.headers || {}) }

    for (const headerSetting of builtin.headerSettings || []) {
      const value = getIntegrationCredentialValue(settings, builtin.name, headerSetting.key)
      if (!value) continue
      headers[headerSetting.header] = `${headerSetting.prefix || ''}${value}`
    }

    const entry: ResolvedRuntimeMcpEntry = {
      type: 'remote',
      url: builtin.url,
    }
    if (Object.keys(headers).length > 0) entry.headers = headers
    return entry
  }

  return null
}

export function resolveConfiguredMcpRuntimeEntry(name: string, settings: CoworkSettings = getEffectiveSettings()): ResolvedRuntimeMcpEntry | null {
  const builtin = getConfiguredMcpsFromConfig().find((entry) => entry.name === name)
  if (!builtin) return null
  return resolveBuiltInMcpEntry(builtin, settings)
}

export function resolveCustomMcpRuntimeEntry(custom: CustomMcpConfig): ResolvedRuntimeMcpEntry | null {
  if (custom.type === 'stdio' && custom.command) {
    const entry: ResolvedRuntimeMcpEntry = {
      type: 'local',
      command: [custom.command, ...(custom.args || [])],
    }
    if (custom.env && Object.keys(custom.env).length > 0) {
      entry.environment = custom.env
    }
    return entry
  }

  if (custom.type === 'http' && custom.url) {
    const entry: ResolvedRuntimeMcpEntry = {
      type: 'remote',
      url: custom.url,
    }
    if (custom.headers && Object.keys(custom.headers).length > 0) {
      entry.headers = custom.headers
    }
    return entry
  }

  return null
}
