import { existsSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { ProviderModelDescriptor, PublicAppConfig } from '@open-cowork/shared'
import { getAppPathHost } from '@open-cowork/shared/node'
import {
  buildConfiguredModelFallbacks,
  buildProviderDescriptors,
  buildPublicAppConfig,
  findProviderDescriptor,
  getProviderDynamicCatalogFromConfig,
  resolveProviderDefaultModel as resolveProviderDefaultModelForConfig,
} from './config-public.js'
import { validateConfigLayerInput, validateResolvedConfig } from './config-schema.js'
import { jsonConfigCandidates, readJsoncFile } from './jsonc.js'
import { DEFAULT_CONFIG } from '@open-cowork/shared'
import { normalizeAppConfig, normalizeConfigLayers } from './config-normalizer.js'
import {
  deepMerge,
  formatConfigError,
  resolveConfigEnvPlaceholders,
  validateConfigSemantics,
} from './config-layer-utils.js'
import type {
  ConfiguredTool,
  ModelFallbackInfo,
  OpenCoworkConfig,
} from '@open-cowork/shared'
import { applyE2EArgEnvironment } from './e2e-remote-debugging.js'

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
} from '@open-cowork/shared'

export { normalizeProviderModelId } from './config-public.js'
export { resolveConfigEnvPlaceholders } from './config-layer-utils.js'

// Electron's `app` provides only path resolution here (isPackaged / getAppPath /
// getPath). It is injected via the shared `AppPathHost` (set by the desktop
// `desktop-electron-hosts.ts` wiring at startup) instead of importing electron, so this
// config core stays Electron-free and package-resolvable; the cloud server leaves
// the host unset and the env/homedir/cwd fallbacks below apply.
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
    if (getAppPathHost()?.isPackaged) return jsonConfigCandidates(join(((process as { resourcesPath?: string }).resourcesPath ?? process.cwd()), 'open-cowork.config.json'))
    if (getAppPathHost()?.getAppPath) {
      return jsonConfigCandidates(resolve(getAppPathHost()!.getAppPath!(), '..', '..', 'open-cowork.config.json'))
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
    merged = normalizeAppConfig(deepMerge(merged, readConfigFile(bundledPath, 'bundled config')))
  }
  const overridePath = firstExistingConfigPath(getOverrideConfigCandidates())
  if (overridePath) {
    merged = normalizeAppConfig(deepMerge(merged, readConfigFile(overridePath, 'override config')))
  }
  const customDirPath = firstExistingConfigPath(getCustomDirConfigCandidates())
  if (customDirPath) {
    merged = normalizeAppConfig(deepMerge(merged, readConfigFile(customDirPath, 'config directory')))
  }
  return merged
}

function getUserConfigCandidates(dataDirName: string) {
  try {
    return jsonConfigCandidates(join(getAppPathHost()?.getPath?.('home') || homedir(), '.config', dataDirName, 'config.json'))
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
    return getAppPathHost()?.getPath?.('userData') || join(process.cwd(), '.open-cowork-test')
  } catch {
    return join(process.cwd(), '.open-cowork-test')
  }
}

// A config candidate "exists" only if it is a readable regular file. Docker bind
// mounts auto-create the host source as an empty directory when no config file is
// present, so an env-pointed config path (e.g. OPEN_COWORK_CONFIG_PATH defaulted to
// the in-container mount target) can resolve to a directory. Treat that as "no
// config" rather than letting the reader throw on a non-regular file.
function isRegularConfigFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function readConfigFile(path: string, source: string): Partial<OpenCoworkConfig> {
  if (!isRegularConfigFile(path)) return {}
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

    const merged = normalizeConfigLayers(layerPaths.map((path) => readConfigFile(path, path)))
    validateResolvedConfig(merged, 'resolved config')
    validateConfigSemantics(merged, 'resolved config')
    configCache = merged
    configErrorCache = null
  } catch (err) {
    configCache = normalizeAppConfig(DEFAULT_CONFIG)
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
// directory and the `.<ns>.json` sidecar suffix. The upstream config keeps
// `.opencowork/` intentionally as its documented on-disk namespace.
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
  mkdirSync(userDataRoot, { recursive: true })

  dataDirCache = userDataRoot
  return dataDirCache
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
  return Array.from(new Set(patterns))
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

export function getConfiguredCapabilityBundlesFromConfig() {
  return getAppConfig().capabilityBundles || []
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
