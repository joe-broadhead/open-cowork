import electron from 'electron'
import { cpSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import type { AgentStarterTemplate, BrandingConfig, CredentialField, ModelInfoSnapshot, ProviderDescriptor, ProviderModelDescriptor, PublicAppConfig } from '@open-cowork/shared'
import { getCachedProviderCatalog, scheduleBackgroundRefresh } from './provider-catalog.ts'
import { validateConfigLayerInput, validateResolvedConfig } from './config-schema.ts'
import { jsonConfigCandidates, readJsoncFile } from './jsonc.ts'
import { modelInfoKeys } from './model-info-utils.ts'
import { brandingAssetUrl } from './branding-assets.ts'

const electronApp = (electron as { app?: typeof import('electron').app }).app

export type ConfiguredSkill = {
  name: string
  description: string
  badge: 'Skill'
  sourceName: string
  toolIds?: string[]
}

export type ConfiguredTool = {
  id: string
  name: string
  icon?: string
  description: string
  kind: 'mcp' | 'built-in'
  namespace?: string
  patterns?: string[]
  allowPatterns?: string[]
  askPatterns?: string[]
}

export type BundleCredential = CredentialField

export type BundleHeaderSetting = {
  header: string
  key: string
  prefix?: string
}

export type BundleEnvSetting = {
  env: string
  key: string
}

export type BundleMcp = {
  name: string
  type: 'local' | 'remote'
  description: string
  authMode: 'none' | 'oauth' | 'api_token'
  packageName?: string
  command?: string[]
  url?: string
  headers?: Record<string, string>
  headerSettings?: BundleHeaderSetting[]
  envSettings?: BundleEnvSetting[]
  // UI metadata for per-MCP credential inputs. When present, the
  // Capabilities panel renders an input field per entry and persists
  // values to `integrationCredentials[mcpName][key]` — the same store
  // `envSettings` / `headerSettings` already read from. Lets bundles
  // like GitHub (PAT) or Perplexity (API key) collect their secrets
  // without each downstream fork having to build its own UI.
  credentials?: CredentialField[]
  // Opt-in: forward the app-level Google OAuth credentials into this MCP
  // via `GOOGLE_APPLICATION_CREDENTIALS`. See `CustomMcpConfig.googleAuth`
  // for the contract. Gated on `auth.mode: google-oauth` + a successful
  // login — no-op otherwise.
  googleAuth?: boolean
}

export type ConfiguredAgent = {
  name: string
  label?: string
  description: string
  instructions: string
  skillNames?: string[]
  toolIds?: string[]
  allowTools?: string[]
  askTools?: string[]
  color?: string
  hidden?: boolean
  mode?: 'primary' | 'subagent'
  // Inference tuning forwarded to SDK AgentConfig. Optional; unset fields
  // inherit the session defaults.
  model?: string
  variant?: string
  temperature?: number
  top_p?: number
  steps?: number
  options?: Record<string, unknown>
}

export type BuiltInAgentOverrideConfig = {
  disable?: boolean
  hidden?: boolean
  description?: string
  instructions?: string
  color?: string
  model?: string
  variant?: string
  temperature?: number
  top_p?: number
  steps?: number
  options?: Record<string, unknown>
}

export type CustomProviderRuntimeConfig = {
  npm: string
  name: string
  defaultModel?: string
  options?: Record<string, unknown>
  models: Record<string, Record<string, unknown>>
  credentials?: CredentialField[]
  description?: string
}

export type ConfiguredModelInfo = {
  limit?: {
    context?: number
    output?: number
  }
  cost?: {
    input?: number
    output?: number
    cache_read?: number
    cache_write?: number
  }
}

export type ConfiguredProviderDescriptor = {
  runtime?: 'builtin' | 'custom'
  name: string
  description: string
  defaultModel?: string
  options?: Record<string, unknown>
  credentials: CredentialField[]
  models: ProviderModelDescriptor[]
  // Optional dynamic-catalog hookup. When present, the app fetches the
  // endpoint, extracts models via the configured field paths, and overlays
  // them underneath the hardcoded `models[]` (which are treated as
  // featured / pinned). See `provider-catalog.ts`.
  dynamicCatalog?: {
    url: string
    responsePath?: string
    idField?: string
    nameField?: string
    descriptionField?: string
    contextLengthField?: string
    authHeader?: string
    cacheTtlMinutes?: number
  }
}

export type OpenCoworkConfig = {
  allowedEnvPlaceholders: string[]
  branding: BrandingConfig
  auth: {
    mode: 'none' | 'google-oauth'
    googleOAuth?: {
      clientId: string
      clientSecret?: string
      scopes?: string[]
    }
  }
  providers: {
    available: string[]
    descriptors?: Record<string, ConfiguredProviderDescriptor>
    defaultProvider: string | null
    defaultModel: string | null
    modelInfo?: Record<string, ConfiguredModelInfo>
    custom?: Record<string, CustomProviderRuntimeConfig>
  }
  tools: ConfiguredTool[]
  skills: ConfiguredSkill[]
  mcps: BundleMcp[]
  agents: ConfiguredAgent[]
  // Per-built-in overrides keyed by agent name (build / plan / general /
  // explore). Lets a downstream disable an agent or retune its model/
  // prompt/inference without modifying the upstream app.
  builtInAgents?: Record<string, BuiltInAgentOverrideConfig>
  // Extra starter templates appended to the built-in set shown in the
  // "New agent" picker. Downstream forks can ship their own templates
  // (e.g. "Nike Brand Writer") without touching renderer source.
  agentStarterTemplates?: AgentStarterTemplate[]
  permissions: {
    bash: 'allow' | 'ask' | 'deny'
    fileWrite: 'allow' | 'ask' | 'deny'
    task: 'allow' | 'ask' | 'deny'
    web: 'allow' | 'ask' | 'deny'
    webSearch: boolean
  }
  compaction: {
    // Enable automatic compaction when context is full. Default true.
    auto: boolean
    // Prune stale tool outputs during compaction. Default true.
    prune: boolean
    // Token buffer the runtime reserves so compaction can happen before
    // the context window overflows. Default 10_000.
    reserved: number
    // Optional overrides for the dedicated compaction agent that OpenCode
    // uses to summarize the session. Matches SDK Config.agent.compaction.
    agent?: {
      model?: string
      prompt?: string
      temperature?: number
    }
  }
  // Optional translation + locale overlay. Downstream forks set
  // `i18n.locale` to e.g. "de-DE" so Intl.NumberFormat / Intl.DateTimeFormat
  // produce locale-appropriate output, and `i18n.strings` to a
  // catalog of key→translation pairs. Unset entries fall back to the
  // inline English default in the renderer source.
  i18n?: {
    locale?: string
    strings?: Record<string, string>
  }
  // Optional remote telemetry forwarder. Upstream leaves `enabled:
  // false` (the default) — all event tracking stays local on disk.
  // Downstream forks shipping to a company internal install can point
  // `endpoint` at their own collector (PostHog, Mixpanel, a custom
  // http endpoint) and every tracked event is POSTed as JSON. The
  // `headers` map passes through verbatim — use it for auth tokens
  // rendered from env placeholders at config-load time.
  telemetry?: {
    enabled?: boolean
    endpoint?: string
    headers?: Record<string, string>
  }
}

// Re-export the shared type under the config-loader's historical name so
// existing call sites continue to compile. The shape is identical — this
// is the same data structure that `model:info` IPC returns and that the
// renderer consumes.
export type ModelFallbackInfo = ModelInfoSnapshot

const DEFAULT_CONFIG: OpenCoworkConfig = {
  allowedEnvPlaceholders: [],
  branding: {
    name: 'Cowork',
    appId: 'com.example.cowork',
    dataDirName: 'cowork',
    helpUrl: '',
    projectNamespace: 'opencowork',
    defaultTheme: 'mercury',
    themes: [],
  },
  auth: {
    mode: 'none',
  },
  providers: {
    available: [],
    descriptors: {},
    defaultProvider: null,
    defaultModel: null,
    modelInfo: {},
    custom: {},
  },
  tools: [],
  skills: [],
  mcps: [],
  agents: [],
  permissions: {
    bash: 'ask',
    fileWrite: 'ask',
    task: 'allow',
    web: 'allow',
    webSearch: true,
  },
  compaction: {
    auto: true,
    prune: true,
    reserved: 10_000,
  },
}

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
      firstExistingConfigPath(getUserConfigCandidates(baseForPaths.branding.dataDirName)),
      firstExistingConfigPath(getOverrideConfigCandidates()),
      firstExistingConfigPath(getCustomDirConfigCandidates()),
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
) {
  const config = getAppConfig()
  const descriptorDefault = config.providers.descriptors?.[providerId]?.defaultModel
  const customDefault = config.providers.custom?.[providerId]?.defaultModel
  const globalDefault = providerId === config.providers.defaultProvider ? config.providers.defaultModel : null
  const candidates = [descriptorDefault, customDefault, globalDefault, runtimeDefaultModel]

  for (const candidate of candidates) {
    const resolved = resolveModelFromCurrentCatalog(providerId, models, candidate)
    if (resolved) return resolved
  }
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
