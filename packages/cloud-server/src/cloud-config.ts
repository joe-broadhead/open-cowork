import { resolve } from 'path'
import {
  normalizeCloudProjectSource,
  type AppSettings,
  type CloudProjectSourceInput,
  type CloudProjectSourcePolicyVerdict,
  type CustomMcpConfig,
} from '@open-cowork/shared'
import { DEFAULT_CONFIG } from '@open-cowork/shared'
import type {
  BundleMcp,
  CloudAbuseConfig,
  CloudAuthConfig,
  CloudBillingConfig,
  CloudFeatureConfig,
  CloudProfileConfig,
  CloudProjectSourcePolicyConfig,
  CloudRole,
  OpenCoworkConfig,
} from '@open-cowork/shared'
import { parseBoolean, parseCsv, parseCsvArray, parseOptionalPositiveInt, parsePositiveInt, parseSignupMode, resolveEnvRef } from './cloud-config-parse.ts'
import { isSupportedCloudSecretRef } from './secret-ref-policy.ts'

type Env = Record<string, string | undefined>

const CLOUD_ROLES = new Set<CloudRole>(['all-in-one', 'web', 'worker', 'scheduler'])

export type CloudRuntimePolicy = {
  role: CloudRole
  profileName: string
  profile: CloudProfileConfig
  features: CloudFeatureConfig
  runtimeConfigSource: 'app'
  allowMachineRuntimeConfig: boolean
  allowLocalStdioMcps: boolean
  allowHostProjectDirectories: boolean
  allowRemoteApprovalResponses: boolean
  projectSources: CloudProjectSourcePolicyConfig
  allowedAgents: string[] | null
  allowedTools: string[] | null
  allowedMcps: string[] | null
  allowedLocalMcpNames: string[]
  allowedHostProjectDirectories: string[]
}

export type CloudPolicyVerdict = {
  allowed: boolean
  reason: string | null
}

function configuredCloud(config: Pick<OpenCoworkConfig, 'cloud'>) {
  return config.cloud || DEFAULT_CONFIG.cloud
}

function envValue(env: Env, key: string) {
  const value = env[key]?.trim()
  return value || null
}

function unique(values: readonly string[] | undefined) {
  return Array.from(new Set((values || []).map((value) => value.trim()).filter(Boolean)))
}

function allowlist(values: readonly string[] | undefined) {
  const list = unique(values)
  return list.length > 0 ? list : null
}

function hasName(list: string[] | null | undefined, name: string) {
  return !list || list.includes(name)
}

function isPathInside(candidate: string, root: string) {
  const resolvedCandidate = resolve(candidate)
  const resolvedRoot = resolve(root)
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}/`)
}

function normalizeHost(host: string) {
  return host.trim().toLowerCase()
}

function normalizeRepositoryAllowKey(url: URL) {
  const pathname = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
  const parts = pathname.split('/').filter(Boolean)
  if (parts.length < 2) return null
  return `${normalizeHost(url.hostname)}/${parts[0]!.toLowerCase()}/${parts[1]!.toLowerCase()}`
}

function isSafeSubdirectory(subdirectory: string | null | undefined) {
  if (!subdirectory) return true
  if (subdirectory.includes('\0') || subdirectory.includes('\\') || subdirectory.startsWith('/')) return false
  return !subdirectory.split('/').some((part) => !part || part === '.' || part === '..')
}

function isSafeGitRef(ref: string | null | undefined) {
  if (!ref) return true
  const trimmed = ref.trim()
  if (!trimmed || trimmed.startsWith('-') || trimmed.includes('\0') || trimmed.includes('\\')) return false
  if (trimmed.includes('..') || trimmed.includes('@{') || trimmed.endsWith('.') || trimmed.includes('//')) return false
  return !trimmed.split('/').some((part) => !part || part === '.' || part === '..')
}

export function resolveCloudRole(
  config: Pick<OpenCoworkConfig, 'cloud'>,
  env: Env = process.env,
): CloudRole {
  const requested = envValue(env, 'OPEN_COWORK_CLOUD_ROLE') || configuredCloud(config).role
  if (!CLOUD_ROLES.has(requested as CloudRole)) {
    throw new Error(`Invalid cloud role "${requested}".`)
  }
  return requested as CloudRole
}

export function resolveCloudProfileName(
  config: Pick<OpenCoworkConfig, 'cloud'>,
  env: Env = process.env,
) {
  const cloud = configuredCloud(config)
  const requested = envValue(env, 'OPEN_COWORK_CLOUD_PROFILE') || cloud.defaultProfile
  if (!cloud.profiles[requested]) {
    throw new Error(`Unknown cloud profile "${requested}".`)
  }
  return requested
}

export function resolveCloudRuntimePolicy(
  config: Pick<OpenCoworkConfig, 'cloud'>,
  env: Env = process.env,
): CloudRuntimePolicy {
  const cloud = configuredCloud(config)
  const profileName = resolveCloudProfileName(config, env)
  const profile = cloud.profiles[profileName] || {}
  const runtime = {
    ...cloud.runtime,
    ...(profile.runtime || {}),
  }
  return {
    role: resolveCloudRole(config, env),
    profileName,
    profile,
    features: {
      ...cloud.features,
      ...(profile.features || {}),
    },
    runtimeConfigSource: 'app',
    allowMachineRuntimeConfig: runtime.allowMachineRuntimeConfig === true,
    allowLocalStdioMcps: runtime.allowLocalStdioMcps === true,
    allowHostProjectDirectories: runtime.allowHostProjectDirectories === true,
    allowRemoteApprovalResponses: runtime.allowRemoteApprovalResponses === true,
    projectSources: cloud.projectSources,
    allowedAgents: allowlist(profile.agents),
    allowedTools: allowlist(profile.tools),
    allowedMcps: allowlist(profile.mcps),
    allowedLocalMcpNames: unique(runtime.allowedLocalMcpNames),
    allowedHostProjectDirectories: unique(runtime.allowedHostProjectDirectories),
  }
}

export function assertCloudRuntimeSettingsAllowed(
  settings: Pick<AppSettings, 'runtimeConfigSource'>,
  policy: CloudRuntimePolicy,
) {
  if (settings.runtimeConfigSource === 'machine' && !policy.allowMachineRuntimeConfig) {
    throw new Error('Cloud profiles must use app-managed runtime config unless machine config is explicitly enabled.')
  }
}

export function coerceCloudRuntimeSettings<T extends Pick<AppSettings, 'runtimeConfigSource'>>(
  settings: T,
  policy: CloudRuntimePolicy,
): T {
  if (settings.runtimeConfigSource !== 'machine' || policy.allowMachineRuntimeConfig) return settings
  return {
    ...settings,
    runtimeConfigSource: 'app',
  }
}

export function evaluateCloudMcpPolicy(
  mcp: Pick<CustomMcpConfig, 'name' | 'type'> | Pick<BundleMcp, 'name' | 'type'>,
  policy: CloudRuntimePolicy,
): CloudPolicyVerdict {
  if (!hasName(policy.allowedMcps, mcp.name)) {
    return { allowed: false, reason: `MCP "${mcp.name}" is not enabled for cloud profile "${policy.profileName}".` }
  }

  const isLocal = mcp.type === 'stdio' || mcp.type === 'local'
  if (!isLocal) return { allowed: true, reason: null }

  if (policy.allowLocalStdioMcps || policy.allowedLocalMcpNames.includes(mcp.name)) {
    return { allowed: true, reason: null }
  }

  return {
    allowed: false,
    reason: 'Local stdio MCPs are disabled for this cloud profile.',
  }
}

export function isCloudMcpAllowed(
  mcp: Pick<CustomMcpConfig, 'name' | 'type'> | Pick<BundleMcp, 'name' | 'type'>,
  policy: CloudRuntimePolicy,
) {
  return evaluateCloudMcpPolicy(mcp, policy).allowed
}

export function evaluateCloudProjectDirectoryPolicy(
  directory: string | null | undefined,
  policy: CloudRuntimePolicy,
  extraAllowedRoots: readonly string[] = [],
): CloudPolicyVerdict {
  if (!directory?.trim()) {
    return { allowed: false, reason: 'Cloud sessions require an app-managed workspace directory.' }
  }
  const allowedRoots = [
    ...policy.allowedHostProjectDirectories,
    ...extraAllowedRoots,
  ].filter(Boolean)
  if (allowedRoots.some((root) => isPathInside(directory, root))) {
    return { allowed: true, reason: null }
  }
  if (policy.allowHostProjectDirectories) {
    return { allowed: true, reason: null }
  }
  return {
    allowed: false,
    reason: 'Arbitrary host project directories are disabled for this cloud profile.',
  }
}

export function isCloudProjectDirectoryAllowed(
  directory: string | null | undefined,
  policy: CloudRuntimePolicy,
  extraAllowedRoots: readonly string[] = [],
) {
  return evaluateCloudProjectDirectoryPolicy(directory, policy, extraAllowedRoots).allowed
}

export function evaluateCloudProjectSourcePolicy(
  input: CloudProjectSourceInput | null | undefined,
  policy: CloudRuntimePolicy,
): CloudProjectSourcePolicyVerdict {
  const source = normalizeCloudProjectSource(input)
  if (!source) {
    return { allowed: false, reason: 'Cloud project source is required.', policyCode: 'project_source.required' }
  }

  if (source.kind === 'git') {
    if (!policy.projectSources.git.enabled) {
      return { allowed: false, reason: 'Git project sources are disabled for this cloud profile.', policyCode: 'project_source.git.disabled' }
    }
    let url: URL
    try {
      url = new URL(source.repositoryUrl)
    } catch {
      return { allowed: false, reason: 'Git repository URL is invalid.', policyCode: 'project_source.git.invalid_url' }
    }
    if (url.username || url.password) {
      return {
        allowed: false,
        reason: 'Git credentials must be stored as credential refs, not embedded in repository URLs.',
        policyCode: 'project_source.git.raw_credentials',
      }
    }
    if (url.search || url.hash) {
      return {
        allowed: false,
        reason: 'Git repository URLs must not include query strings or fragments.',
        policyCode: 'project_source.git.url_components',
      }
    }
    if (url.protocol === 'file:' && !policy.projectSources.git.allowFileUrls) {
      return { allowed: false, reason: 'Local file Git URLs are disabled for this cloud profile.', policyCode: 'project_source.git.file_url_disabled' }
    }
    if (url.protocol !== 'https:' && url.protocol !== 'file:') {
      return { allowed: false, reason: 'Git repository URLs must use HTTPS.', policyCode: 'project_source.git.scheme' }
    }
    if (url.protocol !== 'file:') {
      const host = normalizeHost(url.hostname)
      const allowedHosts = policy.projectSources.git.allowedHosts.map(normalizeHost)
      if (allowedHosts.length > 0 && !allowedHosts.includes(host)) {
        return { allowed: false, reason: `Git host "${host}" is not allowed.`, policyCode: 'project_source.git.host_denied' }
      }
      const allowedRepos = policy.projectSources.git.allowedRepositories.map((entry) => entry.trim().toLowerCase()).filter(Boolean)
      if (allowedRepos.length > 0) {
        const key = normalizeRepositoryAllowKey(url)
        if (!key || !allowedRepos.includes(key)) {
          return { allowed: false, reason: 'Git repository is not allowed for this cloud profile.', policyCode: 'project_source.git.repo_denied' }
        }
      }
    }
    if (!isSafeSubdirectory(source.subdirectory)) {
      return { allowed: false, reason: 'Git subdirectory must be a safe relative path.', policyCode: 'project_source.git.subdirectory' }
    }
    if (!isSafeGitRef(source.ref)) {
      return { allowed: false, reason: 'Git ref must be a safe branch, tag, or commit reference.', policyCode: 'project_source.git.ref' }
    }
    if (!isSupportedCloudSecretRef(source.credentialRef)) {
      return {
        allowed: false,
        reason: 'Git credential refs must reference a cloud secret store, not raw credentials.',
        policyCode: 'project_source.git.credential_ref',
      }
    }
    return { allowed: true, reason: null }
  }

  if (!policy.projectSources.uploadedSnapshots.enabled) {
    return { allowed: false, reason: 'Uploaded snapshots are disabled for this cloud profile.', policyCode: 'project_source.snapshot.disabled' }
  }
  if (source.fileCount > policy.projectSources.uploadedSnapshots.maxFiles) {
    return { allowed: false, reason: 'Uploaded snapshot has too many files.', policyCode: 'project_source.snapshot.too_many_files' }
  }
  if (source.byteCount > policy.projectSources.uploadedSnapshots.maxBytes) {
    return { allowed: false, reason: 'Uploaded snapshot is too large.', policyCode: 'project_source.snapshot.too_large' }
  }
  return { allowed: true, reason: null }
}

// Abuse/quota and billing config resolvers (config defaults + env overrides → typed
// config). Pure: no secrets read, no runtime adapters created. Extracted from
// cloud/app.ts (which re-exports them for compatibility).
export function resolveCloudAbuseConfig(config: Pick<OpenCoworkConfig, 'cloud'>, env: Env = process.env): CloudAbuseConfig {
  const defaults = config.cloud.abuse
  return {
    ...defaults,
    enabled: parseBoolean(envValue(env, 'OPEN_COWORK_CLOUD_ABUSE_ENABLED'), defaults.enabled),
    maxConcurrentSessionsPerOrg: parseOptionalPositiveInt(
      envValue(env, 'OPEN_COWORK_CLOUD_MAX_CONCURRENT_SESSIONS_PER_ORG'),
      defaults.maxConcurrentSessionsPerOrg,
    ),
    maxConcurrentWorkflowRunsPerOrg: parseOptionalPositiveInt(
      envValue(env, 'OPEN_COWORK_CLOUD_MAX_CONCURRENT_WORKFLOW_RUNS_PER_ORG'),
      defaults.maxConcurrentWorkflowRunsPerOrg,
    ),
    maxActiveWorkersPerOrg: parseOptionalPositiveInt(
      envValue(env, 'OPEN_COWORK_CLOUD_MAX_ACTIVE_WORKERS_PER_ORG'),
      defaults.maxActiveWorkersPerOrg,
    ),
    maxQueuedCommandsPerOrg: parseOptionalPositiveInt(
      envValue(env, 'OPEN_COWORK_CLOUD_MAX_QUEUED_COMMANDS_PER_ORG'),
      defaults.maxQueuedCommandsPerOrg,
    ),
    maxQueueAgeMs: parseOptionalPositiveInt(
      envValue(env, 'OPEN_COWORK_CLOUD_MAX_QUEUE_AGE_MS'),
      defaults.maxQueueAgeMs,
    ),
    maxPromptsPerHour: parseOptionalPositiveInt(
      envValue(env, 'OPEN_COWORK_CLOUD_MAX_PROMPTS_PER_HOUR'),
      defaults.maxPromptsPerHour,
    ),
    maxWorkflowRunsPerHour: parseOptionalPositiveInt(
      envValue(env, 'OPEN_COWORK_CLOUD_MAX_WORKFLOW_RUNS_PER_HOUR'),
      defaults.maxWorkflowRunsPerHour,
    ),
    maxGatewayPromptsPerHour: parseOptionalPositiveInt(
      envValue(env, 'OPEN_COWORK_CLOUD_MAX_GATEWAY_PROMPTS_PER_HOUR'),
      defaults.maxGatewayPromptsPerHour,
    ),
    maxWorkerMinutesPerHour: parseOptionalPositiveInt(
      envValue(env, 'OPEN_COWORK_CLOUD_MAX_WORKER_MINUTES_PER_HOUR'),
      defaults.maxWorkerMinutesPerHour,
    ),
    maxGatewayDeliveriesPerHour: parseOptionalPositiveInt(
      envValue(env, 'OPEN_COWORK_CLOUD_MAX_GATEWAY_DELIVERIES_PER_HOUR'),
      defaults.maxGatewayDeliveriesPerHour,
    ),
    maxGatewayChannelBindingsPerOrg: parseOptionalPositiveInt(
      envValue(env, 'OPEN_COWORK_CLOUD_MAX_GATEWAY_CHANNEL_BINDINGS_PER_ORG'),
      defaults.maxGatewayChannelBindingsPerOrg,
    ),
    maxArtifactBytesPerDay: parseOptionalPositiveInt(
      envValue(env, 'OPEN_COWORK_CLOUD_MAX_ARTIFACT_BYTES_PER_DAY'),
      defaults.maxArtifactBytesPerDay,
    ),
    httpRateLimit: {
      ...defaults.httpRateLimit,
      enabled: parseBoolean(envValue(env, 'OPEN_COWORK_CLOUD_HTTP_RATE_LIMIT_ENABLED'), defaults.httpRateLimit.enabled),
      windowMs: parsePositiveInt(envValue(env, 'OPEN_COWORK_CLOUD_HTTP_RATE_LIMIT_WINDOW_MS'), defaults.httpRateLimit.windowMs),
      maxRequests: parsePositiveInt(envValue(env, 'OPEN_COWORK_CLOUD_HTTP_RATE_LIMIT_MAX_REQUESTS'), defaults.httpRateLimit.maxRequests),
    },
    authBackoff: {
      ...defaults.authBackoff,
      enabled: parseBoolean(envValue(env, 'OPEN_COWORK_CLOUD_AUTH_BACKOFF_ENABLED'), defaults.authBackoff.enabled),
      windowMs: parsePositiveInt(envValue(env, 'OPEN_COWORK_CLOUD_AUTH_BACKOFF_WINDOW_MS'), defaults.authBackoff.windowMs),
      maxFailures: parsePositiveInt(envValue(env, 'OPEN_COWORK_CLOUD_AUTH_BACKOFF_MAX_FAILURES'), defaults.authBackoff.maxFailures),
      backoffMs: parsePositiveInt(envValue(env, 'OPEN_COWORK_CLOUD_AUTH_BACKOFF_MS'), defaults.authBackoff.backoffMs),
    },
  }
}

export function resolveCloudBillingConfig(config: Pick<OpenCoworkConfig, 'cloud'>, env: Env = process.env): CloudBillingConfig {
  const defaults = config.cloud.billing
  const provider = envValue(env, 'OPEN_COWORK_CLOUD_BILLING_PROVIDER') || defaults.provider
  return {
    ...defaults,
    enabled: parseBoolean(envValue(env, 'OPEN_COWORK_CLOUD_BILLING_ENABLED'), defaults.enabled),
    provider: provider === 'none' || provider === 'stub' || provider === 'stripe' ? provider : defaults.provider,
    defaultPlanKey: envValue(env, 'OPEN_COWORK_CLOUD_BILLING_DEFAULT_PLAN') || defaults.defaultPlanKey,
    stripe: {
      ...(defaults.stripe || {}),
      apiKeyRef: envValue(env, 'OPEN_COWORK_CLOUD_STRIPE_API_KEY_REF') || defaults.stripe?.apiKeyRef,
      webhookSecretRef: envValue(env, 'OPEN_COWORK_CLOUD_STRIPE_WEBHOOK_SECRET_REF') || defaults.stripe?.webhookSecretRef,
      defaultPriceId: envValue(env, 'OPEN_COWORK_CLOUD_STRIPE_PRICE_ID') || defaults.stripe?.defaultPriceId,
      successUrl: envValue(env, 'OPEN_COWORK_CLOUD_STRIPE_SUCCESS_URL') || defaults.stripe?.successUrl,
      cancelUrl: envValue(env, 'OPEN_COWORK_CLOUD_STRIPE_CANCEL_URL') || defaults.stripe?.cancelUrl,
      portalReturnUrl: envValue(env, 'OPEN_COWORK_CLOUD_STRIPE_PORTAL_RETURN_URL') || defaults.stripe?.portalReturnUrl,
    },
  }
}

// Default max age for a signed header-auth signature (5 minutes). Exported because
// the header-auth verification path in app.ts also enforces it.
export const DEFAULT_HEADER_AUTH_SIGNATURE_AGE_MS = 5 * 60 * 1000

export type CloudDeploymentTier = 'local' | 'self_host_beta' | 'private_beta' | 'public_production'

export function parseCloudDeploymentTier(value: string | null | undefined): CloudDeploymentTier {
  if (!value) return 'local'
  if (value === 'local' || value === 'self_host_beta' || value === 'private_beta' || value === 'public_production') {
    return value
  }
  throw new Error(`Invalid OPEN_COWORK_CLOUD_DEPLOYMENT_TIER "${value}". Expected local, self_host_beta, private_beta, or public_production.`)
}

function inferSignupMode(input: {
  requestedSignupMode?: 'disabled' | 'closed' | 'invite' | 'domain' | 'open' | null
  allowSelfServiceSignup: boolean
  allowedEmailDomains?: string[] | null
}) {
  if (input.requestedSignupMode) return input.requestedSignupMode
  if (!input.allowSelfServiceSignup) return 'invite'
  return input.allowedEmailDomains?.length ? 'domain' : 'open'
}

export function resolveCloudAuthConfig(config: OpenCoworkConfig, env: Env = process.env): CloudAuthConfig {
  const requestedMode = envValue(env, 'OPEN_COWORK_CLOUD_AUTH_MODE')
  const mode = requestedMode === 'oidc' || requestedMode === 'header' || requestedMode === 'none'
    ? requestedMode
    : config.cloud.auth.mode
  const requestedSelfService = envValue(env, 'OPEN_COWORK_CLOUD_ALLOW_SELF_SERVICE_SIGNUP')
  const allowedEmailDomains = parseCsv(envValue(env, 'OPEN_COWORK_CLOUD_ALLOWED_EMAIL_DOMAINS')) || config.cloud.auth.allowedEmailDomains
  const envSwitchedToOidc = mode === 'oidc' && requestedMode === 'oidc' && config.cloud.auth.mode !== 'oidc'
  const requestedSignupMode = parseSignupMode(envValue(env, 'OPEN_COWORK_CLOUD_SIGNUP_MODE'))
    || (envSwitchedToOidc ? null : parseSignupMode(config.cloud.auth.signupMode))
  const allowSelfServiceSignup = requestedSelfService
    ? parseBoolean(requestedSelfService, false)
      : requestedSignupMode === 'open' || requestedSignupMode === 'domain'
        ? true
      : requestedSignupMode === 'disabled' || requestedSignupMode === 'closed' || requestedSignupMode === 'invite'
        ? false
        : envSwitchedToOidc
          ? false
          : config.cloud.auth.allowSelfServiceSignup ?? mode !== 'oidc'
  return {
    ...config.cloud.auth,
    mode,
    signupMode: inferSignupMode({
      requestedSignupMode,
      allowSelfServiceSignup,
      allowedEmailDomains,
    }),
    headerSecret: envValue(env, 'OPEN_COWORK_CLOUD_HEADER_AUTH_SECRET')
      || resolveEnvRef(envValue(env, 'OPEN_COWORK_CLOUD_HEADER_AUTH_SECRET_REF') || undefined, env)
      || resolveEnvRef(config.cloud.auth.headerSecretRef, env)
      || config.cloud.auth.headerSecret,
    headerSecretRef: envValue(env, 'OPEN_COWORK_CLOUD_HEADER_AUTH_SECRET_REF') || config.cloud.auth.headerSecretRef,
    headerAllowUnsigned: parseBoolean(
      envValue(env, 'OPEN_COWORK_CLOUD_HEADER_AUTH_ALLOW_UNSIGNED'),
      config.cloud.auth.headerAllowUnsigned || false,
    ),
    headerMaxSignatureAgeMs: parsePositiveInt(
      envValue(env, 'OPEN_COWORK_CLOUD_HEADER_AUTH_MAX_SIGNATURE_AGE_MS'),
      config.cloud.auth.headerMaxSignatureAgeMs || DEFAULT_HEADER_AUTH_SIGNATURE_AGE_MS,
    ),
    issuerUrl: envValue(env, 'OPEN_COWORK_CLOUD_OIDC_ISSUER_URL') || config.cloud.auth.issuerUrl,
    clientId: envValue(env, 'OPEN_COWORK_CLOUD_OIDC_CLIENT_ID') || config.cloud.auth.clientId,
    clientSecretRef: envValue(env, 'OPEN_COWORK_CLOUD_OIDC_CLIENT_SECRET_REF') || config.cloud.auth.clientSecretRef,
    callbackPath: envValue(env, 'OPEN_COWORK_CLOUD_OIDC_CALLBACK_PATH') || config.cloud.auth.callbackPath,
    cookieSecretRef: envValue(env, 'OPEN_COWORK_CLOUD_COOKIE_SECRET_REF') || config.cloud.auth.cookieSecretRef,
    allowedEmailDomains,
    allowSelfServiceSignup,
    apiTokens: {
      ...(config.cloud.auth.apiTokens || {}),
      defaultTtlMs: parsePositiveInt(
        envValue(env, 'OPEN_COWORK_CLOUD_API_TOKEN_DEFAULT_TTL_MS'),
        config.cloud.auth.apiTokens?.defaultTtlMs || 90 * 24 * 60 * 60 * 1000,
      ),
      maxTtlMs: parsePositiveInt(
        envValue(env, 'OPEN_COWORK_CLOUD_API_TOKEN_MAX_TTL_MS'),
        config.cloud.auth.apiTokens?.maxTtlMs || 365 * 24 * 60 * 60 * 1000,
      ),
      allowedScopes: parseCsvArray(
        envValue(env, 'OPEN_COWORK_CLOUD_API_TOKEN_ALLOWED_SCOPES'),
        config.cloud.auth.apiTokens?.allowedScopes,
      ),
    },
  }
}
