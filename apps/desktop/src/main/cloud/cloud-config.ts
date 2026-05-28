import { resolve } from 'path'
import {
  normalizeCloudProjectSource,
  type AppSettings,
  type CloudProjectSourceInput,
  type CloudProjectSourcePolicyVerdict,
  type CustomMcpConfig,
} from '@open-cowork/shared'
import { DEFAULT_CONFIG } from '../config-types.ts'
import type {
  BundleMcp,
  CloudFeatureConfig,
  CloudProfileConfig,
  CloudProjectSourcePolicyConfig,
  CloudRole,
  OpenCoworkConfig,
} from '../config-types.ts'

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
  return `${normalizeHost(url.hostname)}/${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`
}

function isSafeSubdirectory(subdirectory: string | null | undefined) {
  if (!subdirectory) return true
  if (subdirectory.includes('\0') || subdirectory.includes('\\') || subdirectory.startsWith('/')) return false
  return !subdirectory.split('/').some((part) => !part || part === '.' || part === '..')
}

function isSupportedCloudSecretRef(ref: string | null | undefined) {
  if (!ref) return true
  const trimmed = ref.trim()
  if (
    trimmed.startsWith('env:')
    || trimmed.startsWith('gcp-sm://')
    || trimmed.startsWith('aws-sm://')
    || trimmed.startsWith('azure-kv://')
  ) {
    return true
  }
  if (trimmed.startsWith('https://')) {
    try {
      const url = new URL(trimmed)
      return !url.username
        && !url.password
        && url.hostname.toLowerCase().endsWith('.vault.azure.net')
        && url.pathname.split('/').filter(Boolean)[0] === 'secrets'
    } catch {
      return false
    }
  }
  return false
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
