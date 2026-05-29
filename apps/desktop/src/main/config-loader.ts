import electron from 'electron'
import { cpSync, existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import type { ProviderModelDescriptor, PublicAppConfig, PublicBrandingConfig } from '@open-cowork/shared'
import { normalizeCloudProjectSource } from '@open-cowork/shared'
import {
  buildConfiguredModelFallbacks,
  buildProviderDescriptors,
  buildPublicAppConfig,
  findProviderDescriptor,
  getProviderDynamicCatalogFromConfig,
  resolveProviderDefaultModel as resolveProviderDefaultModelForConfig,
} from './config-public.ts'
import { validateConfigLayerInput, validateResolvedConfig } from './config-schema.ts'
import { jsonConfigCandidates, readJsoncFile } from './jsonc.ts'
import { DEFAULT_CONFIG } from './config-types.ts'
import {
  deepMerge,
  formatConfigError,
  resolveConfigEnvPlaceholders,
  validateConfigSemantics,
} from './config-layer-utils.ts'
import type {
  CloudConfig,
  CloudDesktopConfig,
  CloudFeatureConfig,
  CloudProfileConfig,
  CloudRole,
  ConfiguredTool,
  ModelFallbackInfo,
  OpenCoworkConfig,
} from './config-types.ts'
import { applyE2EArgEnvironment } from './e2e-remote-debugging.ts'

applyE2EArgEnvironment()

export type {
  BuiltInAgentOverrideConfig,
  BundleCredential,
  BundleEnvSetting,
  BundleHeaderSetting,
  BundleMcp,
  CloudConfig,
  CloudFeatureConfig,
  CloudProfileConfig,
  CloudRole,
  ConfiguredAgent,
  ConfiguredModelInfo,
  ConfiguredProviderDescriptor,
  ConfiguredSkill,
  ConfiguredTool,
  CustomProviderRuntimeConfig,
  ModelFallbackInfo,
  OpenCoworkConfig,
} from './config-types.ts'

export { normalizeProviderModelId } from './config-public.ts'
export { resolveConfigEnvPlaceholders } from './config-layer-utils.ts'

const electronApp = (electron as { app?: typeof import('electron').app }).app
const CLOUD_ROLES = new Set<CloudRole>(['all-in-one', 'web', 'worker', 'scheduler'])
const CLOUD_AUTH_MODES = new Set(['none', 'header', 'oidc'])
const CLOUD_CONTROL_PLANE_KINDS = new Set(['local', 'postgres'])
const CLOUD_OBJECT_STORE_KINDS = new Set(['filesystem', 's3', 'gcs', 'azure-blob', 'digitalocean-spaces', 'minio'])
const PUBLIC_BRANDING_URL_KEYS = new Set(['logoUrl', 'supportUrl', 'privacyUrl', 'securityUrl', 'legalUrl'])

let configCache: OpenCoworkConfig | null = null
let publicConfigCache: PublicAppConfig | null = null
let dataDirCache: string | null = null
let configErrorCache: string | null = null

function validateConfigFileInput(raw: unknown, source: string) {
  validateConfigLayerInput(raw, source)
}

function uniquePaths(paths: Array<string | null | undefined>) {
  return Array.from(new Set(paths.filter((path): path is string => Boolean(path)).map((path) => resolve(path))))
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

function stringArray(value: unknown, fallback: string[] = []) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : fallback
}

function normalizeCloudFeatures(raw: Partial<CloudFeatureConfig> | undefined): CloudFeatureConfig {
  return {
    ...DEFAULT_CONFIG.cloud.features,
    ...(raw || {}),
  }
}

function safePublicBrandingUrl(value: unknown, allowMailto = false) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return ''
  try {
    const url = new URL(text)
    if (url.protocol === 'https:') return url.toString()
    if (allowMailto && url.protocol === 'mailto:') return url.toString()
  } catch {
    return ''
  }
  return ''
}

function cleanPublicBrandingStrings(value: unknown) {
  const output: Record<string, string> = {}
  if (!value || typeof value !== 'object') return output
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') continue
    const text = entry.trim()
    if (!text) continue
    output[key] = text
  }
  return output
}

function normalizePublicBranding(raw: Partial<PublicBrandingConfig> | undefined): PublicBrandingConfig {
  const defaults = DEFAULT_CONFIG.cloud.publicBranding
  const source = raw || {}
  const base: PublicBrandingConfig = {
    ...defaults,
    ...source,
    productName: typeof source.productName === 'string' && source.productName.trim()
      ? source.productName.trim()
      : defaults.productName,
    shortName: typeof source.shortName === 'string' && source.shortName.trim()
      ? source.shortName.trim()
      : defaults.shortName,
    logoUrl: safePublicBrandingUrl(source.logoUrl),
    supportUrl: safePublicBrandingUrl(source.supportUrl, true),
    privacyUrl: safePublicBrandingUrl(source.privacyUrl),
    securityUrl: safePublicBrandingUrl(source.securityUrl),
    legalUrl: safePublicBrandingUrl(source.legalUrl),
    theme: {
      ...(defaults.theme || {}),
      ...cleanPublicBrandingStrings(source.theme),
    },
    dashboard: {
      ...(defaults.dashboard || {}),
      ...cleanPublicBrandingStrings(source.dashboard),
    },
    managedOrgConnectionLabels: {
      ...(defaults.managedOrgConnectionLabels || {}),
      ...cleanPublicBrandingStrings(source.managedOrgConnectionLabels),
    },
  }
  for (const key of PUBLIC_BRANDING_URL_KEYS) {
    if (!base[key as keyof PublicBrandingConfig]) delete base[key as keyof PublicBrandingConfig]
  }
  return base
}

function normalizeCloudProjectSources(raw: CloudConfig['projectSources'] | undefined): CloudConfig['projectSources'] {
  const defaults = DEFAULT_CONFIG.cloud.projectSources
  const source = raw || defaults
  return {
    git: {
      ...defaults.git,
      ...(source.git || {}),
      enabled: typeof source.git?.enabled === 'boolean' ? source.git.enabled : defaults.git.enabled,
      allowedHosts: stringArray(source.git?.allowedHosts, defaults.git.allowedHosts),
      allowedRepositories: stringArray(source.git?.allowedRepositories, defaults.git.allowedRepositories),
      allowFileUrls: typeof source.git?.allowFileUrls === 'boolean' ? source.git.allowFileUrls : defaults.git.allowFileUrls,
    },
    uploadedSnapshots: {
      ...defaults.uploadedSnapshots,
      ...(source.uploadedSnapshots || {}),
      enabled: typeof source.uploadedSnapshots?.enabled === 'boolean'
        ? source.uploadedSnapshots.enabled
        : defaults.uploadedSnapshots.enabled,
      maxFiles: nullablePositiveNumber(source.uploadedSnapshots?.maxFiles, defaults.uploadedSnapshots.maxFiles)
        || defaults.uploadedSnapshots.maxFiles,
      maxBytes: nullablePositiveNumber(source.uploadedSnapshots?.maxBytes, defaults.uploadedSnapshots.maxBytes)
        || defaults.uploadedSnapshots.maxBytes,
    },
    managedWorkspaces: {
      ...defaults.managedWorkspaces,
      ...(source.managedWorkspaces || {}),
      enabled: typeof source.managedWorkspaces?.enabled === 'boolean'
        ? source.managedWorkspaces.enabled
        : defaults.managedWorkspaces.enabled,
    },
  }
}

function nullablePositiveNumber(value: unknown, fallback: number | null): number | null {
  if (value === null) return null
  const parsed = Number(value ?? fallback)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function normalizeCloudAbuseConfig(raw: CloudConfig['abuse'] | undefined): CloudConfig['abuse'] {
  const defaults = DEFAULT_CONFIG.cloud.abuse
  return {
    ...defaults,
    ...(raw || {}),
    enabled: typeof raw?.enabled === 'boolean' ? raw.enabled : defaults.enabled,
    maxConcurrentSessionsPerOrg: nullablePositiveNumber(raw?.maxConcurrentSessionsPerOrg, defaults.maxConcurrentSessionsPerOrg),
    maxActiveWorkersPerOrg: nullablePositiveNumber(raw?.maxActiveWorkersPerOrg, defaults.maxActiveWorkersPerOrg),
    maxPromptsPerHour: nullablePositiveNumber(raw?.maxPromptsPerHour, defaults.maxPromptsPerHour),
    maxGatewayDeliveriesPerHour: nullablePositiveNumber(raw?.maxGatewayDeliveriesPerHour, defaults.maxGatewayDeliveriesPerHour),
    maxArtifactBytesPerDay: nullablePositiveNumber(raw?.maxArtifactBytesPerDay, defaults.maxArtifactBytesPerDay),
    httpRateLimit: {
      ...defaults.httpRateLimit,
      ...(raw?.httpRateLimit || {}),
      enabled: typeof raw?.httpRateLimit?.enabled === 'boolean'
        ? raw.httpRateLimit.enabled
        : defaults.httpRateLimit.enabled,
      windowMs: nullablePositiveNumber(raw?.httpRateLimit?.windowMs, defaults.httpRateLimit.windowMs) || defaults.httpRateLimit.windowMs,
      maxRequests: nullablePositiveNumber(raw?.httpRateLimit?.maxRequests, defaults.httpRateLimit.maxRequests) || defaults.httpRateLimit.maxRequests,
    },
    authBackoff: {
      ...defaults.authBackoff,
      ...(raw?.authBackoff || {}),
      enabled: typeof raw?.authBackoff?.enabled === 'boolean'
        ? raw.authBackoff.enabled
        : defaults.authBackoff.enabled,
      windowMs: nullablePositiveNumber(raw?.authBackoff?.windowMs, defaults.authBackoff.windowMs) || defaults.authBackoff.windowMs,
      maxFailures: nullablePositiveNumber(raw?.authBackoff?.maxFailures, defaults.authBackoff.maxFailures) || defaults.authBackoff.maxFailures,
      backoffMs: nullablePositiveNumber(raw?.authBackoff?.backoffMs, defaults.authBackoff.backoffMs) || defaults.authBackoff.backoffMs,
    },
  }
}

function normalizeBillingEntitlements(raw: CloudConfig['billing']['plans'][string]['entitlements'] | undefined): CloudConfig['billing']['plans'][string]['entitlements'] {
  if (!raw) return undefined
  return {
    ...raw,
    allowedProfiles: raw.allowedProfiles === null ? null : stringArray(raw.allowedProfiles),
    allowedProviders: raw.allowedProviders === null ? null : stringArray(raw.allowedProviders),
    maxConcurrentSessionsPerOrg: nullablePositiveNumber(raw.maxConcurrentSessionsPerOrg, null),
    maxActiveWorkersPerOrg: nullablePositiveNumber(raw.maxActiveWorkersPerOrg, null),
    maxPromptsPerHour: nullablePositiveNumber(raw.maxPromptsPerHour, null),
    maxGatewayDeliveriesPerHour: nullablePositiveNumber(raw.maxGatewayDeliveriesPerHour, null),
    maxArtifactBytesPerDay: nullablePositiveNumber(raw.maxArtifactBytesPerDay, null),
  }
}

function normalizeCloudBillingConfig(raw: CloudConfig['billing'] | undefined): CloudConfig['billing'] {
  const defaults = DEFAULT_CONFIG.cloud.billing
  const source = raw || defaults
  const providers = new Set(['none', 'stub', 'stripe'])
  const plans: CloudConfig['billing']['plans'] = {}
  for (const [planKey, plan] of Object.entries(defaults.plans)) {
    plans[planKey] = {
      ...plan,
      entitlements: normalizeBillingEntitlements(plan.entitlements),
    }
  }
  for (const [planKey, plan] of Object.entries(source.plans || {})) {
    if (!planKey.trim()) continue
    plans[planKey] = {
      ...(plans[planKey] || {}),
      ...plan,
      entitlements: normalizeBillingEntitlements({
        ...(plans[planKey]?.entitlements || {}),
        ...(plan.entitlements || {}),
      }),
    }
  }
  const defaultPlanKey = source.defaultPlanKey && plans[source.defaultPlanKey]
    ? source.defaultPlanKey
    : defaults.defaultPlanKey
  return {
    ...defaults,
    ...source,
    enabled: typeof source.enabled === 'boolean' ? source.enabled : defaults.enabled,
    provider: providers.has(source.provider) ? source.provider : defaults.provider,
    defaultPlanKey,
    plans,
    stripe: {
      ...(defaults.stripe || {}),
      ...(source.stripe || {}),
    },
  }
}

function normalizeCloudProfile(raw: CloudProfileConfig | undefined): CloudProfileConfig {
  const defaultProjectSource = Object.prototype.hasOwnProperty.call(raw || {}, 'defaultProjectSource')
    ? normalizeCloudProjectSource(raw?.defaultProjectSource)
    : undefined
  return {
    ...(raw || {}),
    agents: stringArray(raw?.agents),
    tools: stringArray(raw?.tools),
    mcps: stringArray(raw?.mcps),
    features: raw?.features ? normalizeCloudFeatures(raw.features) : undefined,
    ...(defaultProjectSource !== undefined ? { defaultProjectSource } : {}),
    runtime: raw?.runtime
      ? {
          ...raw.runtime,
          configSource: 'app',
          launcher: 'node',
          allowedLocalMcpNames: stringArray(raw.runtime.allowedLocalMcpNames),
          allowedHostProjectDirectories: stringArray(raw.runtime.allowedHostProjectDirectories),
        }
      : undefined,
  }
}

function normalizeCloudConfig(raw: CloudConfig | undefined): CloudConfig {
  const source = raw || DEFAULT_CONFIG.cloud
  const profiles: Record<string, CloudProfileConfig> = {}
  for (const [name, profile] of Object.entries(DEFAULT_CONFIG.cloud.profiles)) {
    profiles[name] = normalizeCloudProfile(profile)
  }
  for (const [name, profile] of Object.entries(source.profiles || {})) {
    if (!name.trim()) continue
    profiles[name] = normalizeCloudProfile({
      ...(profiles[name] || {}),
      ...profile,
      features: {
        ...(profiles[name]?.features || {}),
        ...(profile.features || {}),
      },
      runtime: {
        ...(profiles[name]?.runtime || {}),
        ...(profile.runtime || {}),
      },
    })
  }

  const role = CLOUD_ROLES.has(source.role) ? source.role : DEFAULT_CONFIG.cloud.role
  const defaultProfile = source.defaultProfile && profiles[source.defaultProfile]
    ? source.defaultProfile
    : DEFAULT_CONFIG.cloud.defaultProfile

  return {
    ...DEFAULT_CONFIG.cloud,
    ...source,
    role,
    defaultProfile,
    profiles,
    publicBranding: normalizePublicBranding(source.publicBranding),
    auth: {
      ...DEFAULT_CONFIG.cloud.auth,
      ...(source.auth || {}),
      mode: CLOUD_AUTH_MODES.has(source.auth?.mode || '')
        ? source.auth.mode
        : DEFAULT_CONFIG.cloud.auth.mode,
      headerSecret: typeof source.auth?.headerSecret === 'string' && source.auth.headerSecret.trim()
        ? source.auth.headerSecret.trim()
        : undefined,
      allowedEmailDomains: stringArray(source.auth?.allowedEmailDomains),
      allowSelfServiceSignup: typeof source.auth?.allowSelfServiceSignup === 'boolean'
        ? source.auth.allowSelfServiceSignup
        : source.auth?.mode === 'oidc'
          ? false
          : DEFAULT_CONFIG.cloud.auth.allowSelfServiceSignup,
    },
    storage: {
      controlPlane: {
        ...DEFAULT_CONFIG.cloud.storage.controlPlane,
        ...(source.storage?.controlPlane || {}),
        kind: CLOUD_CONTROL_PLANE_KINDS.has(source.storage?.controlPlane?.kind || '')
          ? source.storage!.controlPlane.kind
          : DEFAULT_CONFIG.cloud.storage.controlPlane.kind,
      },
      objectStore: {
        ...DEFAULT_CONFIG.cloud.storage.objectStore,
        ...(source.storage?.objectStore || {}),
        kind: CLOUD_OBJECT_STORE_KINDS.has(source.storage?.objectStore?.kind || '')
          ? source.storage!.objectStore.kind
          : DEFAULT_CONFIG.cloud.storage.objectStore.kind,
      },
    },
    runtime: {
      ...DEFAULT_CONFIG.cloud.runtime,
      ...(source.runtime || {}),
      configSource: 'app',
      launcher: 'node',
      allowedLocalMcpNames: stringArray(source.runtime?.allowedLocalMcpNames),
      allowedHostProjectDirectories: stringArray(source.runtime?.allowedHostProjectDirectories),
    },
    projectSources: normalizeCloudProjectSources(source.projectSources),
    features: normalizeCloudFeatures(source.features),
    abuse: normalizeCloudAbuseConfig(source.abuse),
    billing: normalizeCloudBillingConfig(source.billing),
  }
}

function normalizeCloudDesktopConfig(raw: CloudDesktopConfig | undefined): CloudDesktopConfig {
  const source = raw || DEFAULT_CONFIG.cloudDesktop
  const cacheModes = new Set(['full', 'metadata-only', 'disabled'])
  const fallbackModes = new Set(['metadata-only', 'disabled', 'fail-startup'])
  return {
    ...DEFAULT_CONFIG.cloudDesktop,
    ...source,
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_CONFIG.cloudDesktop.enabled,
    allowUserAddedConnections: typeof source.allowUserAddedConnections === 'boolean'
      ? source.allowUserAddedConnections
      : DEFAULT_CONFIG.cloudDesktop.allowUserAddedConnections,
    preconfiguredConnections: Array.isArray(source.preconfiguredConnections)
      ? source.preconfiguredConnections
        .filter((connection) => connection && typeof connection.baseUrl === 'string' && connection.baseUrl.trim())
        .map((connection) => ({
          baseUrl: connection.baseUrl.trim(),
          ...(typeof connection.label === 'string' && connection.label.trim() ? { label: connection.label.trim() } : {}),
        }))
      : DEFAULT_CONFIG.cloudDesktop.preconfiguredConnections,
    requireManagedOrg: typeof source.requireManagedOrg === 'boolean'
      ? source.requireManagedOrg
      : DEFAULT_CONFIG.cloudDesktop.requireManagedOrg,
    cacheMode: cacheModes.has(source.cacheMode) ? source.cacheMode : DEFAULT_CONFIG.cloudDesktop.cacheMode,
    cacheEncryptionFallback: fallbackModes.has(source.cacheEncryptionFallback)
      ? source.cacheEncryptionFallback
      : DEFAULT_CONFIG.cloudDesktop.cacheEncryptionFallback,
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
    updates: {
      ...DEFAULT_CONFIG.updates,
      ...(raw.updates || {}),
      ...(raw.updates?.releaseSource ? { releaseSource: { ...raw.updates.releaseSource } } : {}),
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
    toolTrace: {
      rules: Array.isArray(raw.toolTrace?.rules)
        ? raw.toolTrace.rules
        : DEFAULT_CONFIG.toolTrace?.rules || [],
      additionalRules: Array.isArray(raw.toolTrace?.additionalRules)
        ? raw.toolTrace.additionalRules
        : [],
    },
    compaction: {
      ...DEFAULT_CONFIG.compaction,
      ...(raw.compaction || {}),
      ...(raw.compaction?.agent ? { agent: { ...raw.compaction.agent } } : {}),
    },
    cloud: normalizeCloudConfig(raw.cloud),
    cloudDesktop: normalizeCloudDesktopConfig(raw.cloudDesktop),
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

export function resolveProviderDefaultModel(
  providerId: string,
  models: ProviderModelDescriptor[],
  runtimeDefaultModel?: string | null,
  options: { runtimeCatalogKnown?: boolean } = {},
) {
  return resolveProviderDefaultModelForConfig(getAppConfig(), providerId, models, runtimeDefaultModel, options)
}

export function getProviderDescriptors() {
  return buildProviderDescriptors(getAppConfig(), invalidatePublicConfigCache)
}

export function invalidatePublicConfigCache() {
  publicConfigCache = null
}

export function getProviderDynamicCatalog(providerId: string) {
  return getProviderDynamicCatalogFromConfig(getAppConfig(), providerId)
}

export function getProviderDescriptor(providerId: string | null | undefined) {
  return findProviderDescriptor(getProviderDescriptors(), providerId)
}

export function getPublicAppConfig(): PublicAppConfig {
  if (publicConfigCache) return publicConfigCache
  // getAppConfig() returns the fully loaded, already-expanded runtime config.
  // Keep the public view derived from that source of truth rather than
  // re-running placeholder resolution in a second code path.
  publicConfigCache = buildPublicAppConfig(getAppConfig(), getProviderDescriptors())
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
  return buildConfiguredModelFallbacks(getAppConfig())
}
