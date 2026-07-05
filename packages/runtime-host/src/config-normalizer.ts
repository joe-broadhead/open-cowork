import type { PublicBrandingConfig } from '@open-cowork/shared'
import { derivePublicBrandingThemeTokens, normalizeCloudProjectSource } from '@open-cowork/shared'
import { deepMerge } from './config-layer-utils.js'
import { DEFAULT_CONFIG } from '@open-cowork/shared'
import type {
  CloudConfig,
  CloudDesktopConfig,
  CloudFeatureConfig,
  CloudProfileConfig,
  CloudRole,
  OpenCoworkConfig,
} from '@open-cowork/shared'

const CLOUD_ROLES = new Set<CloudRole>(['all-in-one', 'web', 'worker', 'scheduler'])
const CLOUD_AUTH_MODES = new Set(['none', 'header', 'oidc'])
const CLOUD_CONTROL_PLANE_KINDS = new Set(['local', 'postgres'])
const CLOUD_OBJECT_STORE_KINDS = new Set(['filesystem', 's3', 'gcs', 'azure-blob', 'digitalocean-spaces', 'minio'])
const PUBLIC_BRANDING_URL_KEYS = new Set(['logoUrl', 'supportUrl', 'privacyUrl', 'securityUrl', 'legalUrl'])
const GATEWAY_MODES = new Set(['self-host', 'managed'])
const GATEWAY_LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error', 'silent'])
const GATEWAY_PROVIDER_KINDS = new Set(['fake', 'telegram', 'slack', 'email', 'webhook', 'discord', 'whatsapp', 'signal', 'cli'])

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

function derivePublicBrandingConfigLayer(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const branding = value as Partial<PublicBrandingConfig>
  if (!branding.theme || typeof branding.theme !== 'object' || Array.isArray(branding.theme)) return value
  return {
    ...branding,
    theme: derivePublicBrandingThemeTokens(cleanPublicBrandingStrings(branding.theme)),
  }
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
    maxConcurrentWorkflowRunsPerOrg: nullablePositiveNumber(raw?.maxConcurrentWorkflowRunsPerOrg, defaults.maxConcurrentWorkflowRunsPerOrg),
    maxActiveWorkersPerOrg: nullablePositiveNumber(raw?.maxActiveWorkersPerOrg, defaults.maxActiveWorkersPerOrg),
    maxQueuedCommandsPerOrg: nullablePositiveNumber(raw?.maxQueuedCommandsPerOrg, defaults.maxQueuedCommandsPerOrg),
    maxQueueAgeMs: nullablePositiveNumber(raw?.maxQueueAgeMs, defaults.maxQueueAgeMs),
    maxPromptsPerHour: nullablePositiveNumber(raw?.maxPromptsPerHour, defaults.maxPromptsPerHour),
    maxWorkflowRunsPerHour: nullablePositiveNumber(raw?.maxWorkflowRunsPerHour, defaults.maxWorkflowRunsPerHour),
    maxGatewayPromptsPerHour: nullablePositiveNumber(raw?.maxGatewayPromptsPerHour, defaults.maxGatewayPromptsPerHour),
    maxWorkerMinutesPerHour: nullablePositiveNumber(raw?.maxWorkerMinutesPerHour, defaults.maxWorkerMinutesPerHour),
    maxGatewayDeliveriesPerHour: nullablePositiveNumber(raw?.maxGatewayDeliveriesPerHour, defaults.maxGatewayDeliveriesPerHour),
    maxGatewayChannelBindingsPerOrg: nullablePositiveNumber(raw?.maxGatewayChannelBindingsPerOrg, defaults.maxGatewayChannelBindingsPerOrg),
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
    maxConcurrentWorkflowRunsPerOrg: nullablePositiveNumber(raw.maxConcurrentWorkflowRunsPerOrg, null),
    maxActiveWorkersPerOrg: nullablePositiveNumber(raw.maxActiveWorkersPerOrg, null),
    maxQueuedCommandsPerOrg: nullablePositiveNumber(raw.maxQueuedCommandsPerOrg, null),
    maxQueueAgeMs: nullablePositiveNumber(raw.maxQueueAgeMs, null),
    maxPromptsPerHour: nullablePositiveNumber(raw.maxPromptsPerHour, null),
    maxWorkflowRunsPerHour: nullablePositiveNumber(raw.maxWorkflowRunsPerHour, null),
    maxGatewayPromptsPerHour: nullablePositiveNumber(raw.maxGatewayPromptsPerHour, null),
    maxWorkerMinutesPerHour: nullablePositiveNumber(raw.maxWorkerMinutesPerHour, null),
    maxGatewayDeliveriesPerHour: nullablePositiveNumber(raw.maxGatewayDeliveriesPerHour, null),
    maxGatewayChannelBindingsPerOrg: nullablePositiveNumber(raw.maxGatewayChannelBindingsPerOrg, null),
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
      signupMode: source.auth?.signupMode
        ? source.auth.signupMode
        : source.auth?.mode === 'oidc'
          ? 'invite'
          : DEFAULT_CONFIG.cloud.auth.signupMode,
      headerSecret: typeof source.auth?.headerSecret === 'string' && source.auth.headerSecret.trim()
        ? source.auth.headerSecret.trim()
        : undefined,
      headerSecretRef: typeof source.auth?.headerSecretRef === 'string' && source.auth.headerSecretRef.trim()
        ? source.auth.headerSecretRef.trim()
        : undefined,
      headerAllowUnsigned: typeof source.auth?.headerAllowUnsigned === 'boolean'
        ? source.auth.headerAllowUnsigned
        : false,
      headerMaxSignatureAgeMs: nullablePositiveNumber(source.auth?.headerMaxSignatureAgeMs, 5 * 60 * 1000) || 5 * 60 * 1000,
      allowedEmailDomains: stringArray(source.auth?.allowedEmailDomains),
      allowSelfServiceSignup: typeof source.auth?.allowSelfServiceSignup === 'boolean'
        ? source.auth.allowSelfServiceSignup
        : source.auth?.mode === 'oidc'
          ? false
          : DEFAULT_CONFIG.cloud.auth.allowSelfServiceSignup,
      apiTokens: {
        ...DEFAULT_CONFIG.cloud.auth.apiTokens,
        ...(source.auth?.apiTokens || {}),
        defaultTtlMs: nullablePositiveNumber(
          source.auth?.apiTokens?.defaultTtlMs,
          DEFAULT_CONFIG.cloud.auth.apiTokens?.defaultTtlMs || 90 * 24 * 60 * 60 * 1000,
        ) || DEFAULT_CONFIG.cloud.auth.apiTokens?.defaultTtlMs,
        maxTtlMs: nullablePositiveNumber(
          source.auth?.apiTokens?.maxTtlMs,
          DEFAULT_CONFIG.cloud.auth.apiTokens?.maxTtlMs || 365 * 24 * 60 * 60 * 1000,
        ) || DEFAULT_CONFIG.cloud.auth.apiTokens?.maxTtlMs,
        allowedScopes: stringArray(source.auth?.apiTokens?.allowedScopes).length > 0
          ? stringArray(source.auth?.apiTokens?.allowedScopes)
          : DEFAULT_CONFIG.cloud.auth.apiTokens?.allowedScopes,
      },
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

function normalizeGatewayConfig(raw: OpenCoworkConfig['gateway'] | undefined): OpenCoworkConfig['gateway'] {
  const defaults = DEFAULT_CONFIG.gateway
  const source = raw || defaults
  const mode = GATEWAY_MODES.has(source.mode || '') ? source.mode : defaults.mode
  const logLevel = GATEWAY_LOG_LEVELS.has(source.logging?.level || '') ? source.logging?.level : defaults.logging?.level
  return {
    ...defaults,
    ...source,
    branding: normalizePublicBranding(source.branding),
    cloud: {
      ...(defaults.cloud || {}),
      ...(source.cloud || {}),
      allowInsecureHttp: typeof source.cloud?.allowInsecureHttp === 'boolean'
        ? source.cloud.allowInsecureHttp
        : defaults.cloud?.allowInsecureHttp,
    },
    server: {
      ...(defaults.server || {}),
      ...(source.server || {}),
      port: Number.isInteger(source.server?.port) && source.server!.port! >= 0 && source.server!.port! <= 65535
        ? source.server!.port
        : defaults.server?.port,
    },
    mode,
    logging: {
      ...(defaults.logging || {}),
      ...(source.logging || {}),
      level: logLevel,
    },
    metrics: {
      ...(defaults.metrics || {}),
      ...(source.metrics || {}),
      enabled: typeof source.metrics?.enabled === 'boolean' ? source.metrics.enabled : defaults.metrics?.enabled,
    },
    diagnostics: {
      ...(defaults.diagnostics || {}),
      ...(source.diagnostics || {}),
      enabled: typeof source.diagnostics?.enabled === 'boolean'
        ? source.diagnostics.enabled
        : defaults.diagnostics?.enabled,
    },
    providers: Array.isArray(source.providers)
      ? source.providers
        .filter((provider) => provider && GATEWAY_PROVIDER_KINDS.has(provider.kind))
        .map((provider) => ({
          ...provider,
          id: typeof provider.id === 'string' && provider.id.trim() ? provider.id.trim() : undefined,
          channelBindingId: typeof provider.channelBindingId === 'string' ? provider.channelBindingId.trim() : '',
          externalWorkspaceId: typeof provider.externalWorkspaceId === 'string' && provider.externalWorkspaceId.trim()
            ? provider.externalWorkspaceId.trim()
            : null,
          defaultAgent: typeof provider.defaultAgent === 'string' && provider.defaultAgent.trim()
            ? provider.defaultAgent.trim()
            : null,
          credentials: provider.credentials && typeof provider.credentials === 'object' ? { ...provider.credentials } : {},
          settings: provider.settings && typeof provider.settings === 'object' ? { ...provider.settings } : {},
        }))
      : defaults.providers,
  }
}

export function normalizeAppConfig(raw: OpenCoworkConfig): OpenCoworkConfig {
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
    capabilityBundles: Array.isArray(raw.capabilityBundles) ? raw.capabilityBundles : [],
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
    gateway: normalizeGatewayConfig(raw.gateway),
  }
}

export function normalizeConfigLayers(
  layers: Array<Partial<OpenCoworkConfig>>,
  base: OpenCoworkConfig = DEFAULT_CONFIG,
): OpenCoworkConfig {
  return layers.reduce<OpenCoworkConfig>(
    (current, layer) => normalizeAppConfig(deepMerge<OpenCoworkConfig>(current, deriveConfigLayerPublicBranding(layer))),
    normalizeAppConfig(base),
  )
}

function deriveConfigLayerPublicBranding(layer: Partial<OpenCoworkConfig>): Partial<OpenCoworkConfig> {
  const hasCloudPublicBranding = Boolean(layer.cloud?.publicBranding)
  const hasGatewayBranding = Boolean(layer.gateway?.branding)
  const cloudPublicBranding = hasCloudPublicBranding
    ? derivePublicBrandingConfigLayer(layer.cloud?.publicBranding)
    : undefined
  const gatewayBranding = hasGatewayBranding
    ? derivePublicBrandingConfigLayer(layer.gateway?.branding)
    : undefined
  if (cloudPublicBranding === layer.cloud?.publicBranding && gatewayBranding === layer.gateway?.branding) return layer

  const next: Partial<OpenCoworkConfig> = { ...layer }
  if (hasCloudPublicBranding && layer.cloud) {
    next.cloud = {
      ...layer.cloud,
      publicBranding: cloudPublicBranding as PublicBrandingConfig,
    }
  }
  if (hasGatewayBranding && layer.gateway) {
    next.gateway = {
      ...layer.gateway,
      branding: gatewayBranding as PublicBrandingConfig,
    }
  }
  return next
}
