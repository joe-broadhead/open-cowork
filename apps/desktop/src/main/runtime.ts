import {
  createOpencode as createLegacyOpencode,
  createOpencodeClient as createLegacyOpencodeClient,
  type OpencodeClient as LegacyOpencodeClient,
} from '@opencode-ai/sdk'
import {
  createOpencodeClient as createV2OpencodeClient,
  type OpencodeClient as V2OpencodeClient,
} from '@opencode-ai/sdk/v2'
import electron from 'electron'
import { mkdirSync, writeFileSync, cpSync, existsSync, readFileSync, rmSync, readdirSync, statSync } from 'fs'
import { dirname, join, resolve } from 'path'
import {
  getAppConfig,
  type BundleMcp,
  getAppDataDir,
  getConfiguredMcpsFromConfig,
  getConfiguredModelFallbacks,
  getConfiguredSkillsFromConfig,
  getConfiguredToolAllowPatterns,
  getConfiguredToolAskPatterns,
  getConfiguredToolPatterns,
  getConfiguredToolsFromConfig,
  getProviderDescriptor,
  resolveCustomProviderConfig,
} from './config-loader.ts'
import type { CustomMcpConfig } from '@open-cowork/shared'
import { getEffectiveSettings, getIntegrationCredentialValue, getProviderCredentialValue, type CoworkSettings } from './settings.ts'
import { log } from './logger.ts'
import { refreshAccessToken } from './auth.ts'
import { buildOpenCoworkAgentConfig } from './agent-config.ts'
import { normalizeProviderListResponse } from './provider-utils.ts'
import { applyShellEnvironment } from './shell-env.ts'
import { listCustomAgents, listCustomMcps, listCustomSkills } from './native-customizations.ts'
import { getMachineAgentsDir, getMachineSkillsDir, getProjectCoworkAgentsDir, getProjectCoworkSkillsDir, getRuntimeEnvPaths, getRuntimeHomeDir } from './runtime-paths.ts'

const { app } = electron

export { getRuntimeHomeDir } from './runtime-paths.ts'

let client: LegacyOpencodeClient | null = null
let serverUrl: string | null = null
let serverClose: (() => void) | null = null
let tokenRefreshTimer: NodeJS.Timeout | null = null
let startRuntimePromise: Promise<LegacyOpencodeClient> | null = null
const directoryClients = new Map<string, LegacyOpencodeClient>()
const MAX_DIRECTORY_CLIENTS = 50
let activeProjectOverlayDirectory: string | null = null

// Cached model info from SDK (populated after runtime starts)
let cachedModelInfo: { pricing: Record<string, { inputPer1M: number; outputPer1M: number; cachePer1M?: number }>; contextLimits: Record<string, number> } | null = null

function getSandboxDir() {
  return getAppDataDir()
}

type ProjectOverlayManifest = {
  directory: string | null
  skillNames: string[]
  agentNames: string[]
  backedUpSkillNames: string[]
  backedUpAgentNames: string[]
}

function normalizeDirectory(directory?: string | null) {
  if (!directory) return null
  return resolve(directory)
}

function ensureSandboxDirs() {
  const base = getSandboxDir()
  const runtimePaths = getRuntimeEnvPaths()
  const dirs = [
    base,
    runtimePaths.home,
    runtimePaths.configHome,
    runtimePaths.dataHome,
    runtimePaths.cacheHome,
    runtimePaths.stateHome,
    join(runtimePaths.configHome, 'opencode'),
    join(runtimePaths.dataHome, 'opencode'),
    join(runtimePaths.cacheHome, 'opencode'),
  ]
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true })
  }
}

function getProjectOverlayManifestPath() {
  return join(getRuntimeEnvPaths().configHome, 'opencode', '.opencowork-project-overlay.json')
}

function getProjectOverlayBackupRoot() {
  return join(getRuntimeEnvPaths().configHome, 'opencode', '.opencowork-project-overlay-backups')
}

function readProjectOverlayManifest(): ProjectOverlayManifest {
  const path = getProjectOverlayManifestPath()
  if (!existsSync(path)) {
    return { directory: null, skillNames: [], agentNames: [], backedUpSkillNames: [], backedUpAgentNames: [] }
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ProjectOverlayManifest>
    return {
      directory: typeof parsed.directory === 'string' ? parsed.directory : null,
      skillNames: Array.isArray(parsed.skillNames) ? parsed.skillNames.filter((entry): entry is string => typeof entry === 'string') : [],
      agentNames: Array.isArray(parsed.agentNames) ? parsed.agentNames.filter((entry): entry is string => typeof entry === 'string') : [],
      backedUpSkillNames: Array.isArray(parsed.backedUpSkillNames)
        ? parsed.backedUpSkillNames.filter((entry): entry is string => typeof entry === 'string')
        : [],
      backedUpAgentNames: Array.isArray(parsed.backedUpAgentNames)
        ? parsed.backedUpAgentNames.filter((entry): entry is string => typeof entry === 'string')
        : [],
    }
  } catch {
    return { directory: null, skillNames: [], agentNames: [], backedUpSkillNames: [], backedUpAgentNames: [] }
  }
}

function writeProjectOverlayManifest(manifest: ProjectOverlayManifest) {
  writeFileSync(getProjectOverlayManifestPath(), `${JSON.stringify(manifest, null, 2)}\n`)
}

function clearProjectOverlayCopies() {
  const manifest = readProjectOverlayManifest()
  const skillsRoot = getMachineSkillsDir()
  const agentsRoot = getMachineAgentsDir()
  const backupRoot = getProjectOverlayBackupRoot()
  const backupSkillsRoot = join(backupRoot, 'skills')
  const backupAgentsRoot = join(backupRoot, 'agents')

  for (const skillName of manifest.skillNames) {
    rmSync(join(skillsRoot, skillName), { recursive: true, force: true })
  }

  for (const skillName of manifest.backedUpSkillNames) {
    const backup = join(backupSkillsRoot, skillName)
    const destination = join(skillsRoot, skillName)
    if (!existsSync(backup)) continue
    rmSync(destination, { recursive: true, force: true })
    cpSync(backup, destination, { recursive: true })
    rmSync(backup, { recursive: true, force: true })
  }

  for (const agentName of manifest.agentNames) {
    rmSync(join(agentsRoot, `${agentName}.md`), { force: true })
    rmSync(join(agentsRoot, `${agentName}.disabled.md`), { force: true })
    rmSync(join(agentsRoot, `${agentName}.opencowork.json`), { force: true })
  }

  for (const agentName of manifest.backedUpAgentNames) {
    for (const suffix of ['.md', '.disabled.md', '.opencowork.json']) {
      const backup = join(backupAgentsRoot, `${agentName}${suffix}`)
      const destination = join(agentsRoot, `${agentName}${suffix}`)
      if (!existsSync(backup)) continue
      cpSync(backup, destination, { recursive: false })
      rmSync(backup, { force: true })
    }
  }

  rmSync(backupRoot, { recursive: true, force: true })

  writeProjectOverlayManifest({
    directory: null,
    skillNames: [],
    agentNames: [],
    backedUpSkillNames: [],
    backedUpAgentNames: [],
  })
}

function syncProjectOverlayToRuntime(projectDirectory?: string | null) {
  clearProjectOverlayCopies()

  const normalized = normalizeDirectory(projectDirectory)
  if (!normalized || normalized === normalizeDirectory(getRuntimeHomeDir())) {
    activeProjectOverlayDirectory = null
    return
  }

  const skillsRoot = getMachineSkillsDir()
  const agentsRoot = getMachineAgentsDir()
  const backupRoot = getProjectOverlayBackupRoot()
  const backupSkillsRoot = join(backupRoot, 'skills')
  const backupAgentsRoot = join(backupRoot, 'agents')
  mkdirSync(skillsRoot, { recursive: true })
  mkdirSync(agentsRoot, { recursive: true })
  mkdirSync(backupSkillsRoot, { recursive: true })
  mkdirSync(backupAgentsRoot, { recursive: true })

  const projectSkills = listCustomSkills({ directory: normalized })
    .filter((skill) => skill.scope === 'project' && skill.directory === normalized)
    .map((skill) => skill.name)
  const projectAgents = listCustomAgents({ directory: normalized })
    .filter((agent) => agent.scope === 'project' && agent.directory === normalized)
    .map((agent) => agent.name)

  const skillSourceRoot = getProjectCoworkSkillsDir(normalized)
  const agentSourceRoot = getProjectCoworkAgentsDir(normalized)
  const backedUpSkillNames = new Set<string>()
  const backedUpAgentNames = new Set<string>()

  for (const skillName of projectSkills) {
    const source = join(skillSourceRoot, skillName)
    const destination = join(skillsRoot, skillName)
    if (!existsSync(source)) continue
    if (existsSync(destination)) {
      const backup = join(backupSkillsRoot, skillName)
      rmSync(backup, { recursive: true, force: true })
      cpSync(destination, backup, { recursive: true })
      backedUpSkillNames.add(skillName)
    }
    rmSync(destination, { recursive: true, force: true })
    cpSync(source, destination, { recursive: true })
  }

  for (const agentName of projectAgents) {
    let backedUp = false
    for (const suffix of ['.md', '.disabled.md', '.opencowork.json']) {
      const source = join(agentSourceRoot, `${agentName}${suffix}`)
      const destination = join(agentsRoot, `${agentName}${suffix}`)
      if (!existsSync(source)) continue
      if (existsSync(destination)) {
        const backup = join(backupAgentsRoot, `${agentName}${suffix}`)
        rmSync(backup, { force: true })
        cpSync(destination, backup, { recursive: false })
        backedUp = true
      }
      rmSync(destination, { recursive: true, force: true })
      cpSync(source, destination, { recursive: false })
    }
    if (backedUp) {
      backedUpAgentNames.add(agentName)
    }
  }

  writeProjectOverlayManifest({
    directory: normalized,
    skillNames: projectSkills,
    agentNames: projectAgents,
    backedUpSkillNames: Array.from(backedUpSkillNames).sort((a, b) => a.localeCompare(b)),
    backedUpAgentNames: Array.from(backedUpAgentNames).sort((a, b) => a.localeCompare(b)),
  })
  activeProjectOverlayDirectory = normalized
}

async function withRuntimeEnvironment<T>(fn: () => Promise<T>) {
  const runtimePaths = getRuntimeEnvPaths()
  const previous = {
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  }

  process.env.HOME = runtimePaths.home
  process.env.XDG_CONFIG_HOME = runtimePaths.configHome
  process.env.XDG_DATA_HOME = runtimePaths.dataHome
  process.env.XDG_CACHE_HOME = runtimePaths.cacheHome
  process.env.XDG_STATE_HOME = runtimePaths.stateHome

  try {
    return await fn()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

// In packaged app: extraResources are at process.resourcesPath
// In dev: they're relative to the app path
function resourcePath(...segments: string[]): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, ...segments)
  }
  return resolve(app.getAppPath(), '..', '..', ...segments)
}

function mcpPath(name: string): string {
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

function resolveEnvPlaceholders<T>(value: T): T {
  if (typeof value === 'string') {
    return value.replace(/\{env:([A-Z0-9_]+)\}/g, (_match, envName) => process.env[envName] || '') as T
  }
  if (Array.isArray(value)) {
    return value.map((entry) => resolveEnvPlaceholders(entry)) as T
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, resolveEnvPlaceholders(entry)]),
    ) as T
  }
  return value
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

function findBundledSkillDir(root: string, skillName: string): string | null {
  const direct = join(root, skillName)
  if (existsSync(direct)) return direct
  if (!existsSync(root)) return null

  const queue = [root]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) continue

    for (const entry of readdirSync(current)) {
      const candidate = join(current, entry)
      let stats
      try {
        stats = statSync(candidate)
      } catch {
        continue
      }
      if (!stats.isDirectory()) continue
      if (entry === skillName && existsSync(join(candidate, 'SKILL.md'))) {
        return candidate
      }
      queue.push(candidate)
    }
  }

  return null
}

function buildRuntimeConfig(projectDirectory?: string | null): Record<string, unknown> {
  const settings = getEffectiveSettings()
  const configModel = settings.effectiveModel || getAppConfig().providers.defaultModel || ''
  const providerId = settings.effectiveProviderId || getAppConfig().providers.defaultProvider || 'anthropic'
  const providerDescriptor = getProviderDescriptor(providerId)
  const fallbackSmallModel = providerDescriptor?.models?.find((model) => model.id !== configModel)?.id || configModel
  const modelStr = configModel ? `${providerId}/${configModel}` : `${providerId}`
  const smallModelStr = fallbackSmallModel ? `${providerId}/${fallbackSmallModel}` : modelStr

  const config: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'manual',
    model: modelStr,
    small_model: smallModelStr,
    compaction: {
      auto: true,
      prune: true,
      reserved: 10_000,
    },
    mcp: {},
  }

  const customProviders = getAppConfig().providers.custom || {}
  if (Object.keys(customProviders).length > 0) {
    config.provider = Object.fromEntries(
      Object.entries(customProviders).map(([id, provider]) => [
        id,
        {
          npm: provider.npm,
          name: provider.name,
          options: resolveEnvPlaceholders(provider.options || {}),
          models: provider.models,
        },
      ]),
    )
  }

  const mcpConfig = config.mcp as Record<string, unknown>
  for (const builtin of getConfiguredMcpsFromConfig()) {
    const entry = resolveBuiltInMcpEntry(builtin, settings)
    if (!entry) continue
    mcpConfig[builtin.name] = entry
  }
  for (const customMcp of listCustomMcps({ directory: projectDirectory || null })) {
    const entry = resolveCustomMcpRuntimeEntry(customMcp)
    if (!entry) continue
    mcpConfig[customMcp.name] = entry
  }

  const configuredTools = getConfiguredToolsFromConfig()
  const allowedPatterns = Array.from(new Set(configuredTools.flatMap((tool) => getConfiguredToolAllowPatterns(tool))))
  const askPatterns = Array.from(new Set(configuredTools.flatMap((tool) => getConfiguredToolAskPatterns(tool))))
  const allToolPatterns = Array.from(new Set([
    ...configuredTools.flatMap((tool) => getConfiguredToolPatterns(tool)),
  ]))
  const permission: Record<string, string> = {
    skill: 'allow',
    question: 'deny',
    task: 'deny',
    todowrite: 'allow',
    codesearch: 'allow',
    webfetch: 'allow',
    websearch: 'allow',
  }
  for (const tool of askPatterns) {
    permission[tool] = 'ask'
  }
  for (const tool of allowedPatterns) {
    permission[tool] = 'allow'
  }
  if (settings.enableBash) {
    permission['bash'] = 'allow'
  } else {
    permission['bash'] = 'deny'
  }
  if (settings.enableFileWrite) {
    permission['edit'] = 'allow'
    permission['write'] = 'allow'
    permission['apply_patch'] = 'allow'
  } else {
    permission['edit'] = 'deny'
    permission['write'] = 'deny'
    permission['apply_patch'] = 'deny'
  }
  permission['read'] = 'allow'
  permission['grep'] = 'allow'
  permission['glob'] = 'allow'
  permission['list'] = 'allow'

  config.permission = permission
  config.agent = buildOpenCoworkAgentConfig({
    allToolPatterns,
    allowToolPatterns: allowedPatterns,
    askToolPatterns: askPatterns,
    allowBash: settings.enableBash,
    allowEdits: settings.enableFileWrite,
  })

  log('runtime', `Config built: provider=${providerId} model=${modelStr}`)

  return config
}

function copySkillsAndAgents(projectDirectory?: string | null) {
  const runtimeHome = getRuntimeHomeDir()
  const runtimeConfigSrc = app.isPackaged
    ? join(process.resourcesPath, 'runtime-config')
    : join(app.getAppPath(), 'runtime-config')

  const agentsSrc = join(runtimeConfigSrc, 'AGENTS.md')
  if (existsSync(agentsSrc)) {
    writeFileSync(join(runtimeHome, 'AGENTS.md'), readFileSync(agentsSrc, 'utf-8'))
  }

  const skillsDst = join(runtimeHome, '.opencode', 'skills')
  rmSync(skillsDst, { recursive: true, force: true })
  mkdirSync(skillsDst, { recursive: true })

  const packagedSkillsSrc = app.isPackaged
    ? join(process.resourcesPath, 'skills')
    : join(app.getAppPath(), '..', '..', 'skills')
  const downstreamSkillsSrc = process.env.OPEN_COWORK_DOWNSTREAM_ROOT?.trim()
    ? join(process.env.OPEN_COWORK_DOWNSTREAM_ROOT.trim(), 'skills')
    : null

  const skillSourceRoots = [join(runtimeConfigSrc, 'skills'), packagedSkillsSrc]
  if (downstreamSkillsSrc) {
    skillSourceRoots.unshift(downstreamSkillsSrc)
  }
  for (const skillName of Array.from(new Set(getConfiguredSkillsFromConfig().map((skill) => skill.sourceName)))) {
    const destination = join(skillsDst, skillName)
    const source = skillSourceRoots
      .map((root) => findBundledSkillDir(root, skillName))
      .find((candidate) => candidate && existsSync(candidate))

    if (!source) {
      log('runtime', `Bundled skill not found: ${skillName}`)
      continue
    }

    mkdirSync(join(destination, '..'), { recursive: true })
    cpSync(source, destination, { recursive: true })
  }

  syncProjectOverlayToRuntime(projectDirectory)
}

async function fetchModelInfo(c: LegacyOpencodeClient) {
  const configuredFallbacks = getConfiguredModelFallbacks()
  try {
    const result = await c.provider.list()
    const raw = result.data as any
    const providers = normalizeProviderListResponse(raw)
    if (!providers.length) {
      cachedModelInfo = configuredFallbacks
      return
    }

    const pricing: Record<string, { inputPer1M: number; outputPer1M: number; cachePer1M?: number }> = {
      ...configuredFallbacks.pricing,
    }
    const contextLimits: Record<string, number> = {
      ...configuredFallbacks.contextLimits,
    }

    for (const provider of providers) {
      const models = provider.models || {}
      for (const [modelId, info] of Object.entries(models) as [string, any][]) {
        if (info.cost) {
          const inputPer1M = (info.cost.input || 0) * 1_000_000
          const outputPer1M = (info.cost.output || 0) * 1_000_000
          const cachePer1M = info.cost.cache_read ? info.cost.cache_read * 1_000_000 : undefined
          if (inputPer1M > 0 || outputPer1M > 0 || (cachePer1M || 0) > 0) {
            pricing[modelId] = {
              inputPer1M,
              outputPer1M,
              ...(cachePer1M ? { cachePer1M } : {}),
            }
          }
        }
        if (info.limit?.context) {
          contextLimits[modelId] = info.limit.context
        }
      }
    }

    cachedModelInfo = { pricing, contextLimits }
    log('runtime', `Loaded model info: ${Object.keys(pricing).length} models with pricing, ${Object.keys(contextLimits).length} with context limits`)
  } catch (err: any) {
    cachedModelInfo = configuredFallbacks
    log('runtime', `Could not fetch model info: ${err?.message}`)
  }
}

export function getModelInfo() {
  return cachedModelInfo || getConfiguredModelFallbacks()
}

export async function startRuntime(projectDirectory?: string | null): Promise<LegacyOpencodeClient> {
  if (client) return client
  if (startRuntimePromise) return startRuntimePromise

  startRuntimePromise = (async () => {
    ensureSandboxDirs()
    applyShellEnvironment()

    const token = await refreshAccessToken()
    if (token) {
      process.env.GOOGLE_WORKSPACE_CLI_TOKEN = token
    }

    const currentSettings = getEffectiveSettings()
    const providerDescriptor = getProviderDescriptor(currentSettings.effectiveProviderId)
    for (const credential of providerDescriptor?.credentials || []) {
      if (!credential.env) continue
      const value = getProviderCredentialValue(currentSettings, currentSettings.effectiveProviderId, credential.key)
      if (value) process.env[credential.env] = value
    }

    if (currentSettings.effectiveProviderId === 'google-vertex' || currentSettings.effectiveProviderId === 'vertex') {
      const projectId = getProviderCredentialValue(currentSettings, currentSettings.effectiveProviderId, 'projectId')
      const location = getProviderCredentialValue(currentSettings, currentSettings.effectiveProviderId, 'location')
      if (projectId) process.env.GOOGLE_VERTEX_PROJECT = projectId
      if (location) process.env.GOOGLE_VERTEX_LOCATION = location
    }

    const customProvider = currentSettings.effectiveProviderId
      ? resolveCustomProviderConfig(currentSettings.effectiveProviderId)
      : null
    for (const credential of customProvider?.credentials || []) {
      if (!credential.env || !currentSettings.effectiveProviderId) continue
      const value = getProviderCredentialValue(currentSettings, currentSettings.effectiveProviderId, credential.key)
      if (value) process.env[credential.env] = value
    }

    if (tokenRefreshTimer) {
      clearInterval(tokenRefreshTimer)
      tokenRefreshTimer = null
    }

    // Refresh token periodically (every 30 min)
    tokenRefreshTimer = setInterval(async () => {
      try {
        const t = await refreshAccessToken()
        if (t) process.env.GOOGLE_WORKSPACE_CLI_TOKEN = t
      } catch (err: any) {
        log('error', `Access token refresh failed: ${err?.message}`)
      }
    }, 30 * 60 * 1000)

    // Copy AGENTS.md and skills to runtime home (discovered from CWD)
    copySkillsAndAgents(projectDirectory)

    // Build config in memory — SDK passes it via OPENCODE_CONFIG_CONTENT env var
    const config = buildRuntimeConfig(projectDirectory)

    // Set CWD to sandbox runtime home so OpenCode discovers AGENTS.md and skills there.
    // Session-specific project routing is handled by directory-scoped SDK clients.
    process.chdir(getRuntimeHomeDir())

    try {
      const result = await withRuntimeEnvironment(() =>
        createLegacyOpencode({
          hostname: '127.0.0.1',
          port: 0,
          config: config as any,
        }),
      )

      client = result.client
      serverUrl = result.server.url
      serverClose = result.server.close
      directoryClients.clear()
      activeProjectOverlayDirectory = normalizeDirectory(projectDirectory)

      // Fetch model pricing and context limits from SDK
      await fetchModelInfo(client)

      log('runtime', `OpenCode server started at ${result.server.url}`)
      return client
    } catch (err) {
      if (tokenRefreshTimer) {
        clearInterval(tokenRefreshTimer)
        tokenRefreshTimer = null
      }
      cachedModelInfo = null
      client = null
      serverUrl = null
      serverClose = null
      directoryClients.clear()
      activeProjectOverlayDirectory = null
      throw err
    }
  })()

  try {
    return await startRuntimePromise
  } finally {
    startRuntimePromise = null
  }
}

export function getClient(): LegacyOpencodeClient | null {
  return client
}

export function getClientForDirectory(directory?: string | null): LegacyOpencodeClient | null {
  if (!client) return null

  const normalized = normalizeDirectory(directory)
  if (!normalized || normalized === normalizeDirectory(getRuntimeHomeDir())) {
    return client
  }

  const existing = directoryClients.get(normalized)
  if (existing) {
    directoryClients.delete(normalized)
    directoryClients.set(normalized, existing)
    return existing
  }
  if (!serverUrl) return client

  const scoped = createLegacyOpencodeClient({
    baseUrl: serverUrl,
    directory: normalized,
  })
  if (directoryClients.size >= MAX_DIRECTORY_CLIENTS) {
    const oldestKey = directoryClients.keys().next().value
    if (oldestKey) directoryClients.delete(oldestKey)
  }
  directoryClients.set(normalized, scoped)
  return scoped
}

export function getV2ClientForDirectory(directory?: string | null): V2OpencodeClient | null {
  if (!serverUrl) return null
  const normalized = normalizeDirectory(directory)
  return createV2OpencodeClient({
    baseUrl: serverUrl,
    ...(normalized ? { directory: normalized } : {}),
  })
}

export function getServerUrl() {
  return serverUrl
}

export function getActiveProjectOverlayDirectory() {
  return activeProjectOverlayDirectory
}

export async function stopRuntime() {
  startRuntimePromise = null
  if (tokenRefreshTimer) {
    clearInterval(tokenRefreshTimer)
    tokenRefreshTimer = null
  }
  if (serverClose) {
    serverClose()
    serverClose = null
  }
  directoryClients.clear()
  client = null
  serverUrl = null
  cachedModelInfo = null
  activeProjectOverlayDirectory = null
}
