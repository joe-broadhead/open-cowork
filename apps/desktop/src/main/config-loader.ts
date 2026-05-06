import electron from 'electron'
import { cpSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import type { BrandingConfig, ProviderDescriptor, ProviderModelDescriptor, PublicAppConfig } from '@open-cowork/shared'
import { getCachedProviderCatalog, scheduleBackgroundRefresh } from './provider-catalog.ts'
import { validateConfigLayerInput, validateResolvedConfig } from './config-schema.ts'
import { jsonConfigCandidates, readJsoncFile } from './jsonc.ts'
import { modelInfoKeys } from './model-info-utils.ts'
import { brandingAssetUrl } from './branding-assets.ts'
import { DEFAULT_CONFIG } from './config-types.ts'
import type {
  ConfiguredProviderDescriptor,
  ConfiguredTool,
  ModelFallbackInfo,
  OpenCoworkConfig,
} from './config-types.ts'

export type {
  BuiltInAgentOverrideConfig,
  BundleCredential,
  BundleEnvSetting,
  BundleHeaderSetting,
  BundleMcp,
  ConfiguredAgent,
  ConfiguredModelInfo,
  ConfiguredProviderDescriptor,
  ConfiguredSkill,
  ConfiguredTool,
  CustomProviderRuntimeConfig,
  ModelFallbackInfo,
  OpenCoworkConfig,
} from './config-types.ts'

const electronApp = (electron as { app?: typeof import('electron').app }).app

let configCache: OpenCoworkConfig | null = null
let publicConfigCache: PublicAppConfig | null = null
let dataDirCache: string | null = null
let configErrorCache: string | null = null

function deepMerge<T extends Record<string, any>>(base: T, override: Partial<T>): T {
  const next: Record<string, any> = { ...base }
  for (const [key, value] of Object.entries(override || {})) {
    if (Array.isArray(value)) {
      next[key] = value
      continue
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const current = next[key]
      next[key] = deepMerge(
        current && typeof current === 'object' && !Array.isArray(current) ? current : {},
        value as Record<string, unknown>,
      )
      continue
    }
    if (value !== undefined) next[key] = value
  }
  return next as T
}

function formatConfigError(source: string, path: string, message: string) {
  return `Invalid app config in ${source}${path ? ` at ${path}` : ''}: ${message}`
}

function validateConfigFileInput(raw: unknown, source: string) {
  validateConfigLayerInput(raw, source)
}

function validateConfigSemantics(raw: unknown, source: string, options?: { requireProviderDefinitions?: boolean }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
  const config = raw as Partial<OpenCoworkConfig>
  const providerIds = new Set([
    ...((config.providers?.available || []).filter(Boolean)),
  ])

  if (options?.requireProviderDefinitions !== false) {
    for (const providerId of providerIds) {
      const hasDescriptor = Boolean(config.providers?.descriptors?.[providerId])
      const hasRuntime = Boolean(config.providers?.custom?.[providerId])
      if (!hasDescriptor && !hasRuntime) {
        throw new Error(formatConfigError(source, `providers.available`, `references unknown provider "${providerId}"`))
      }
    }

    if (config.providers?.defaultProvider && !providerIds.has(config.providers.defaultProvider)) {
      throw new Error(formatConfigError(source, 'providers.defaultProvider', 'must exist in providers.available'))
    }
  }

  for (const [index, mcp] of (config.mcps || []).entries()) {
    if (mcp.type === 'local' && !(Array.isArray(mcp.command) || typeof mcp.packageName === 'string')) {
      throw new Error(formatConfigError(source, `mcps[${index}]`, 'local MCPs require either packageName or command'))
    }
    if (mcp.type === 'remote' && typeof mcp.url !== 'string') {
      throw new Error(formatConfigError(source, `mcps[${index}]`, 'remote MCPs require a url'))
    }
  }
}

function uniquePaths(paths: Array<string | null | undefined>) {
  return Array.from(new Set(paths.filter((path): path is string => Boolean(path)).map((path) => resolve(path))))
}

function resolvePlaceholderFilePath(rawPath: string, baseDir: string) {
  if (rawPath.startsWith('~/')) {
    return join(homedir(), rawPath.slice(2))
  }
  if (rawPath.startsWith('/')) {
    return rawPath
  }
  return resolve(baseDir, rawPath)
}

export function resolveConfigEnvPlaceholders<T>(
  value: T,
  baseDir = process.cwd(),
  allowedEnvPlaceholders: ReadonlySet<string> = new Set(),
): T {
  if (typeof value === 'string') {
    const withEnv = value.replace(/\{env:([A-Z0-9_]+)\}/g, (_match, envName) => {
      if (!allowedEnvPlaceholders.has(envName)) {
        throw new Error(`Environment placeholder ${envName} is not allowlisted. Add it to allowedEnvPlaceholders in open-cowork.config.json or remove the placeholder.`)
      }
      return process.env[envName] || ''
    })
    return withEnv.replace(/\{file:([^}]+)\}/g, (_match, rawPath) => {
      const path = resolvePlaceholderFilePath(rawPath.trim(), baseDir)
      return existsSync(path) ? readFileSync(path, 'utf-8') : ''
    }) as T
  }

  if (Array.isArray(value)) {
    return value.map((entry) => resolveConfigEnvPlaceholders(entry, baseDir, allowedEnvPlaceholders)) as T
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, resolveConfigEnvPlaceholders(entry, baseDir, allowedEnvPlaceholders)]),
    ) as T
  }

  return value
}

function firstExistingConfigPath(paths: string[]) {
  return uniquePaths(paths).find((path) => existsSync(path)) || null
}

function getBundledConfigCandidates() {
  try {
    if (electronApp?.isPackaged) return jsonConfigCandidates(join(process.resourcesPath, 'open-cowork.config.json'))
    if (electronApp?.getAppPath) {
      return jsonConfigCandidates(resolve(electronApp.getAppPath(), '..', '..', 'open-cowork.config.json'))
    }
    return jsonConfigCandidates(resolve(process.cwd(), 'open-cowork.config.json'))
  } catch {
    return jsonConfigCandidates(resolve(process.cwd(), 'open-cowork.config.json'))
  }
}

function getOverrideConfigCandidates() {
  const overridePath = process.env.OPEN_COWORK_CONFIG_PATH?.trim()
  if (!overridePath) return []
  return jsonConfigCandidates(resolve(overridePath))
}

function getCustomDirConfigCandidates() {
  const roots = uniquePaths([
    process.env.OPEN_COWORK_CONFIG_DIR?.trim(),
    process.env.OPEN_COWORK_DOWNSTREAM_ROOT?.trim(),
  ])

  return roots.flatMap((root) => uniquePaths([
    ...jsonConfigCandidates(join(root, 'config.json')),
    ...jsonConfigCandidates(join(root, 'open-cowork.config.json')),
  ]))
}

function getBaseConfigForPathResolution() {
  let merged = DEFAULT_CONFIG
  const bundledPath = firstExistingConfigPath(getBundledConfigCandidates())
  if (bundledPath) {
    merged = normalizeConfig(deepMerge(merged, readConfigFile(bundledPath, 'bundled config')))
  }
  const overridePath = firstExistingConfigPath(getOverrideConfigCandidates())
  if (overridePath) {
    merged = normalizeConfig(deepMerge(merged, readConfigFile(overridePath, 'override config')))
  }
  const customDirPath = firstExistingConfigPath(getCustomDirConfigCandidates())
  if (customDirPath) {
    merged = normalizeConfig(deepMerge(merged, readConfigFile(customDirPath, 'config directory')))
  }
  return merged
}

function getUserConfigCandidates(dataDirName: string) {
  try {
    return jsonConfigCandidates(join(electronApp?.getPath?.('home') || homedir(), '.config', dataDirName, 'config.json'))
  } catch {
    return jsonConfigCandidates(join(homedir(), '.config', dataDirName, 'config.json'))
  }
}

function getManagedConfigCandidates(dataDirName: string) {
  if (process.platform === 'darwin') {
    return jsonConfigCandidates(join('/Library/Application Support', dataDirName, 'config.json'))
  }
  if (process.platform === 'win32') {
    const programData = process.env.ProgramData || 'C:\\ProgramData'
    return jsonConfigCandidates(join(programData, dataDirName, 'config.json'))
  }
  return jsonConfigCandidates(join('/etc', dataDirName, 'config.json'))
}

function getUserDataRoot() {
  const override = process.env.OPEN_COWORK_USER_DATA_DIR?.trim()
  if (override) {
    return resolve(override)
  }
  try {
    return electronApp?.getPath?.('userData') || join(process.cwd(), '.open-cowork-test')
  } catch {
    return join(process.cwd(), '.open-cowork-test')
  }
}

function readConfigFile(path: string, source: string): Partial<OpenCoworkConfig> {
  if (!existsSync(path)) return {}
  try {
    const parsed = readJsoncFile<Partial<OpenCoworkConfig>>(path)
    const allowedEnvPlaceholders = new Set(
      Array.isArray(parsed.allowedEnvPlaceholders)
        ? parsed.allowedEnvPlaceholders.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
        : [],
    )

    // Custom provider `options` blocks commonly reference user-entered
    // credentials via `{env:FOO}` (e.g. a Databricks PAT typed into
    // Settings). Resolving them at load time would lock in whatever was
    // in the shell's `process.env` when the main process booted —
    // empty for GUI-launched apps, stale for terminal-launched ones.
    // We resolve the rest of the config normally and keep the raw
    // unresolved options from `parsed`; the runtime config-builder's
    // override-aware resolver substitutes against live credentials at
    // the point a provider is actually instantiated.
    //
    // We never mutate `parsed` itself — the resolver walks the config
    // and returns new objects. Reading the original raw options back
    // from `parsed.providers?.custom` is safe because those references
    // haven't been touched.
    const resolved = resolveConfigEnvPlaceholders(parsed, dirname(path), allowedEnvPlaceholders)

    const rawCustomProviders = parsed.providers?.custom
    if (rawCustomProviders && resolved.providers?.custom) {
      for (const [providerId, rawProvider] of Object.entries(rawCustomProviders)) {
        const resolvedProvider = resolved.providers.custom[providerId]
        if (!resolvedProvider || !rawProvider || typeof rawProvider !== 'object') continue
        if ('options' in rawProvider) {
          (resolvedProvider as Record<string, unknown>).options = (rawProvider as Record<string, unknown>).options
        }
      }
    }

    validateConfigFileInput(resolved, source)
    validateConfigSemantics(resolved, source, { requireProviderDefinitions: false })
    return resolved
  } catch (err) {
    if (err instanceof Error) throw err
    throw new Error(formatConfigError(source, '', 'could not be parsed'), { cause: err })
  }
}

function normalizeConfig(raw: OpenCoworkConfig): OpenCoworkConfig {
  return {
    ...raw,
    allowedEnvPlaceholders: Array.isArray(raw.allowedEnvPlaceholders)
      ? raw.allowedEnvPlaceholders.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
      : DEFAULT_CONFIG.allowedEnvPlaceholders,
    branding: {
      ...DEFAULT_CONFIG.branding,
      ...(raw.branding || {}),
    },
    auth: {
      ...(raw.auth || {}),
      mode: raw.auth?.mode === 'google-oauth' ? 'google-oauth' : 'none',
    },
    providers: {
      ...DEFAULT_CONFIG.providers,
      ...(raw.providers || {}),
      available: Array.isArray(raw.providers?.available) && raw.providers?.available.length > 0
        ? raw.providers.available
        : DEFAULT_CONFIG.providers.available,
      descriptors: raw.providers?.descriptors || DEFAULT_CONFIG.providers.descriptors,
      modelInfo: raw.providers?.modelInfo || DEFAULT_CONFIG.providers.modelInfo,
      custom: raw.providers?.custom || {},
    },
    tools: Array.isArray(raw.tools) ? raw.tools : [],
    skills: Array.isArray(raw.skills) ? raw.skills : [],
    mcps: Array.isArray(raw.mcps) ? raw.mcps : [],
    agents: Array.isArray(raw.agents) ? raw.agents : [],
    permissions: {
      ...DEFAULT_CONFIG.permissions,
      ...(raw.permissions || {}),
      webSearch: typeof raw.permissions?.webSearch === 'boolean'
        ? raw.permissions.webSearch
        : DEFAULT_CONFIG.permissions.webSearch,
    },
    builtInAgents: raw.builtInAgents && typeof raw.builtInAgents === 'object'
      ? { ...raw.builtInAgents }
      : undefined,
    agentStarterTemplates: Array.isArray(raw.agentStarterTemplates) ? raw.agentStarterTemplates : undefined,
    compaction: {
      ...DEFAULT_CONFIG.compaction,
      ...(raw.compaction || {}),
      ...(raw.compaction?.agent ? { agent: { ...raw.compaction.agent } } : {}),
    },
  }
}

export function getAppConfig(): OpenCoworkConfig {
  if (configCache) return configCache
  try {
    const baseForPaths = getBaseConfigForPathResolution()
    const layerPaths = uniquePaths([
      firstExistingConfigPath(getBundledConfigCandidates()),
      firstExistingConfigPath(getOverrideConfigCandidates()),
      firstExistingConfigPath(getCustomDirConfigCandidates()),
      firstExistingConfigPath(getUserConfigCandidates(baseForPaths.branding.dataDirName)),
      firstExistingConfigPath(getManagedConfigCandidates(baseForPaths.branding.dataDirName)),
    ])

    const merged = layerPaths.reduce(
      (current, path) => normalizeConfig(deepMerge(current, readConfigFile(path, path))),
      DEFAULT_CONFIG,
    )
    validateResolvedConfig(merged, 'resolved config')
    validateConfigSemantics(merged, 'resolved config')
    configCache = merged
    configErrorCache = null
  } catch (err) {
    configCache = normalizeConfig(DEFAULT_CONFIG)
    configErrorCache = err instanceof Error
      ? err.message
      : 'Invalid app config'
  }
  return configCache
}

export function getConfigError() {
  void getAppConfig()
  return configErrorCache
}

export function assertConfigValid() {
  void getAppConfig()
  if (configErrorCache) {
    throw new Error(configErrorCache)
  }
}

export function getBranding() {
  return getAppConfig().branding
}

export function getDataDirName() {
  return getBranding().dataDirName
}

// Kebab-case filesystem namespace used for the `.<ns>/` project overlay
// directory and the `.<ns>.json` sidecar suffix. Falls back to "opencowork"
// so existing installs keep writing `.opencowork/` even if a downstream
// forgets to set the field.
export function getProjectNamespace() {
  const raw = getBranding().projectNamespace?.trim()
  return raw && /^[a-z0-9][a-z0-9-]*$/.test(raw) ? raw : 'opencowork'
}

export function getProjectOverlayDirName() {
  return `.${getProjectNamespace()}`
}

export function getSidecarJsonSuffix() {
  return `.${getProjectNamespace()}.json`
}

// User-facing brand name (e.g. "Open Cowork", "Nike Agent"). Returned as-is
// so call sites can template it into UI copy and the agent system prompt.
export function getBrandName() {
  return getBranding().name
}

export function getLogFilePrefix() {
  return getDataDirName()
}

export function getAppDataDir() {
  if (dataDirCache) return dataDirCache

  const userDataRoot = getUserDataRoot()
  const preferredDir = userDataRoot
  const legacyDirs = Array.from(new Set([
    join(userDataRoot, getDataDirName()),
    join(userDataRoot, 'cowork'),
  ])).filter((path) => path !== preferredDir)

  mkdirSync(preferredDir, { recursive: true })

  for (const legacyDir of legacyDirs) {
    if (!existsSync(legacyDir)) continue
    try {
      cpSync(legacyDir, preferredDir, { recursive: true, force: false })
    } catch {
      // Best-effort migration only. Existing root data wins over legacy copies.
    }
  }

  dataDirCache = preferredDir
  return preferredDir
}

// Merge the descriptor's hardcoded `models[]` (marked featured) with the
// latest cached dynamic catalog. Hardcoded entries take priority on
// duplicate ids — the descriptor name wins, and the `featured` flag flags
// it for pinning in the picker. The fetch itself is kicked off in the
// background so subsequent reads eventually pick up fresh data.
function mergeDescriptorModels(
  providerId: string,
  descriptor: ConfiguredProviderDescriptor,
  invalidateCache: () => void,
): ProviderModelDescriptor[] {
  const featured: ProviderModelDescriptor[] = (descriptor.models || []).map((model) => ({
    ...model,
    featured: true,
  }))
  if (!descriptor.dynamicCatalog) return featured

  const dynamic = getCachedProviderCatalog(providerId)
  scheduleBackgroundRefresh(providerId, descriptor.dynamicCatalog, invalidateCache)

  const seen = new Set(featured.map((entry) => entry.id))
  const overlay = dynamic.filter((entry) => !seen.has(entry.id))
  return [...featured, ...overlay]
}

export function normalizeProviderModelId(providerId: string, modelId: string) {
  const trimmed = modelId.trim()
  const prefix = `${providerId}/`
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed
}

function resolveModelFromCurrentCatalog(
  providerId: string,
  models: ProviderModelDescriptor[],
  modelId: string | null | undefined,
) {
  if (!modelId?.trim()) return null
  const normalized = normalizeProviderModelId(providerId, modelId)
  if (models.length === 0) return normalized
  return models.find((model) => model.id === modelId || model.id === normalized)?.id || null
}

export function resolveProviderDefaultModel(
  providerId: string,
  models: ProviderModelDescriptor[],
  runtimeDefaultModel?: string | null,
  options: { runtimeCatalogKnown?: boolean } = {},
) {
  const config = getAppConfig()
  const descriptorDefault = config.providers.descriptors?.[providerId]?.defaultModel
  const customDefault = config.providers.custom?.[providerId]?.defaultModel
  const globalDefault = providerId === config.providers.defaultProvider ? config.providers.defaultModel : null
  const descriptorResolved = resolveModelFromCurrentCatalog(providerId, models, descriptorDefault)
  if (descriptorResolved) return descriptorResolved
  const customResolved = resolveModelFromCurrentCatalog(providerId, models, customDefault)
  if (customResolved) return customResolved

  const runtimeModels = options.runtimeCatalogKnown === false ? [] : models
  const runtimeResolved = resolveModelFromCurrentCatalog(providerId, runtimeModels, runtimeDefaultModel)
  if (runtimeResolved) return runtimeResolved

  const globalResolved = resolveModelFromCurrentCatalog(providerId, models, globalDefault)
  if (globalResolved) return globalResolved
  return undefined
}

export function getProviderDescriptors(): ProviderDescriptor[] {
  const config = getAppConfig()
  return config.providers.available.map((providerId) => {
    const builtin = config.providers.descriptors?.[providerId]
    if (builtin) {
      const models = mergeDescriptorModels(providerId, builtin, invalidatePublicConfigCache)
      const defaultModel = resolveProviderDefaultModel(providerId, models)
      return {
        id: providerId,
        name: builtin.name,
        description: builtin.description,
        credentials: builtin.credentials || [],
        models,
        ...(defaultModel ? { defaultModel } : {}),
      }
    }

    const custom = config.providers.custom?.[providerId]
    if (!custom) {
      return {
        id: providerId,
        name: providerId,
        description: 'Custom provider',
        credentials: [],
        models: [],
      }
    }

    const models = Object.entries(custom.models || {}).map(([id, info]) => ({
      id,
      name: typeof info?.name === 'string' ? info.name : id,
    }))
    const defaultModel = resolveProviderDefaultModel(providerId, models)
    return {
      id: providerId,
      name: custom.name,
      description: custom.description || `${custom.name} custom provider`,
      credentials: custom.credentials || [],
      models,
      ...(defaultModel ? { defaultModel } : {}),
    }
  })
}

export function invalidatePublicConfigCache() {
  publicConfigCache = null
}

export function getProviderDynamicCatalog(providerId: string) {
  const config = getAppConfig()
  return config.providers.descriptors?.[providerId]?.dynamicCatalog || null
}

export function getProviderDescriptor(providerId: string | null | undefined) {
  if (!providerId) return null
  return getProviderDescriptors().find((provider) => provider.id === providerId) || null
}

function resolvePublicBranding(branding: BrandingConfig): BrandingConfig {
  const top = branding.sidebar?.top
  if (!top?.logoAsset) return branding

  const logoUrl = brandingAssetUrl(top.logoAsset)
  const nextTop = {
    ...top,
    ...(logoUrl
      ? { logoUrl, logoDataUrl: undefined }
      : {}),
  }
  return {
    ...branding,
    sidebar: {
      ...branding.sidebar,
      top: nextTop,
    },
  }
}

export function getPublicAppConfig(): PublicAppConfig {
  if (publicConfigCache) return publicConfigCache
  // getAppConfig() returns the fully loaded, already-expanded runtime config.
  // Keep the public view derived from that source of truth rather than
  // re-running placeholder resolution in a second code path.
  const config = getAppConfig()
  publicConfigCache = {
    branding: resolvePublicBranding(config.branding),
    auth: {
      mode: config.auth.mode,
      enabled: config.auth.mode !== 'none',
    },
    providers: {
      available: getProviderDescriptors(),
      defaultProvider: config.providers.defaultProvider,
      defaultModel: config.providers.defaultModel,
    },
    agentStarterTemplates: config.agentStarterTemplates || [],
    // Pass through the i18n overlay if present — renderer code reads
    // `config.i18n` via the public-config IPC. Absent block is treated
    // as "use inline English + host locale."
    ...(config.i18n ? { i18n: config.i18n } : {}),
  }
  return publicConfigCache
}

export function getConfiguredToolsFromConfig() {
  return getAppConfig().tools || []
}

export function getTelemetryConfig() {
  return getAppConfig().telemetry
}

export function getConfiguredToolById(toolId: string) {
  return getConfiguredToolsFromConfig().find((tool) => tool.id === toolId) || null
}

export function expandMcpToolPermissionPatterns(patterns: string[]) {
  const expanded = new Set<string>()
  for (const pattern of patterns) {
    expanded.add(pattern)
    const match = pattern.match(/^mcp__([a-z0-9][a-z0-9_-]*)__([^/]+)$/i)
    if (!match) continue
    const [, namespace, toolPattern] = match
    if (!namespace || !toolPattern) continue
    expanded.add(`${namespace}_${toolPattern}`)
  }
  return Array.from(expanded)
}

export function getConfiguredToolAllowPatterns(tool: ConfiguredTool) {
  if (tool.allowPatterns?.length) return expandMcpToolPermissionPatterns([...tool.allowPatterns])
  if (tool.patterns?.length) return expandMcpToolPermissionPatterns([...tool.patterns])
  if (tool.namespace) return expandMcpToolPermissionPatterns([`mcp__${tool.namespace}__*`])
  return []
}

export function getConfiguredToolAskPatterns(tool: ConfiguredTool) {
  return expandMcpToolPermissionPatterns([...(tool.askPatterns || [])])
}

export function getConfiguredToolPatterns(tool: ConfiguredTool) {
  return Array.from(new Set([
    ...getConfiguredToolAllowPatterns(tool),
    ...getConfiguredToolAskPatterns(tool),
    ...(tool.patterns || []),
  ]))
}

export function getConfiguredSkillsFromConfig() {
  return getAppConfig().skills || []
}

export function getConfiguredMcpsFromConfig() {
  return getAppConfig().mcps || []
}

export function getConfiguredAgentsFromConfig() {
  return getAppConfig().agents || []
}

export function clearConfigCaches() {
  configCache = null
  publicConfigCache = null
  dataDirCache = null
  configErrorCache = null
}

export function resolveCustomProviderConfig(providerId: string) {
  return getAppConfig().providers.custom?.[providerId] || null
}

export function getConfiguredModelFallbacks(): ModelFallbackInfo {
  const pricing: ModelFallbackInfo['pricing'] = {}
  const contextLimits: ModelFallbackInfo['contextLimits'] = {}

  const addModelInfo = (providerId: string | undefined, modelId: string, rawModel: unknown) => {
    const model = rawModel as Record<string, any>
    const cost = model?.cost
    if (cost && typeof cost === 'object') {
      const inputPer1M = typeof cost.input === 'number' ? cost.input : 0
      const outputPer1M = typeof cost.output === 'number' ? cost.output : 0
      const cachePer1M = typeof cost.cache_read === 'number' ? cost.cache_read : undefined
      const cacheWritePer1M = typeof cost.cache_write === 'number' ? cost.cache_write : undefined
      if (inputPer1M > 0 || outputPer1M > 0 || (cachePer1M || 0) > 0 || (cacheWritePer1M || 0) > 0) {
        const modelPricing = {
          inputPer1M,
          outputPer1M,
          ...(cachePer1M !== undefined ? { cachePer1M } : {}),
          ...(cacheWritePer1M !== undefined ? { cacheWritePer1M } : {}),
        }
        for (const key of modelInfoKeys(providerId, modelId)) {
          pricing[key] = modelPricing
        }
      }
    }

    const context = model?.limit?.context
    if (typeof context === 'number' && context > 0) {
      for (const key of modelInfoKeys(providerId, modelId)) {
        contextLimits[key] = context
      }
    }
  }

  const config = getAppConfig()

  for (const [providerId, descriptor] of Object.entries(config.providers.descriptors || {})) {
    for (const model of descriptor.models || []) {
      addModelInfo(providerId, model.id, model)
    }
  }

  for (const [providerId, provider] of Object.entries(config.providers.custom || {})) {
    for (const [modelId, rawModel] of Object.entries(provider.models || {})) {
      addModelInfo(providerId, modelId, rawModel)
    }
  }

  for (const [modelId, modelInfo] of Object.entries(config.providers.modelInfo || {})) {
    addModelInfo(undefined, modelId, modelInfo)
  }

  return { pricing, contextLimits }
}
