export const RUNTIME_TOOLING_BRIDGE_CONSENT_VERSION = 1 as const

export const RUNTIME_TOOLING_BRIDGE_CATEGORIES = [
  {
    id: 'sourceControl',
    label: 'Git configuration',
    resourceSummary: 'Git config, ignore, and commit-message files',
    capabilitySummary: 'Use your Git identity, defaults, ignore rules, and credential helper configuration.',
  },
  {
    id: 'packageManagers',
    label: 'Package managers',
    resourceSummary: 'npm, pnpm, and Yarn configuration files',
    capabilitySummary: 'Use configured package registries and any credentials stored in those files.',
  },
  {
    id: 'ssh',
    label: 'SSH',
    resourceSummary: 'SSH config, known hosts, allowed signers, and the SSH agent socket when available',
    capabilitySummary: 'Authenticate through your SSH agent without exposing private-key files.',
  },
  {
    id: 'githubCli',
    label: 'GitHub CLI',
    resourceSummary: 'GitHub CLI hosts and configuration files',
    capabilitySummary: 'Use the accounts and defaults configured for the GitHub CLI.',
  },
  {
    id: 'aws',
    label: 'AWS CLI',
    resourceSummary: 'AWS config and credentials files',
    capabilitySummary: 'Use locally configured AWS profiles and credentials.',
  },
  {
    id: 'azure',
    label: 'Azure CLI',
    resourceSummary: 'Azure CLI profile and token-cache files',
    capabilitySummary: 'Use locally configured Azure CLI accounts.',
  },
  {
    id: 'googleCloud',
    label: 'Google Cloud CLI',
    resourceSummary: 'Google Cloud CLI account, profile, and application-default credential files',
    capabilitySummary: 'Use locally configured Google Cloud CLI accounts and defaults.',
  },
  {
    id: 'containers',
    label: 'Container registries',
    resourceSummary: 'Docker client configuration file',
    capabilitySummary: 'Use Docker client defaults and configured registry authentication.',
  },
  {
    id: 'kubernetes',
    label: 'Kubernetes',
    resourceSummary: 'Kubernetes client configuration file',
    capabilitySummary: 'Use configured Kubernetes clusters, users, and contexts.',
  },
] as const

export type RuntimeToolingBridgeCategoryId = typeof RUNTIME_TOOLING_BRIDGE_CATEGORIES[number]['id']

export type RuntimeToolingBridgeConsent = {
  version: typeof RUNTIME_TOOLING_BRIDGE_CONSENT_VERSION
  categories: Record<RuntimeToolingBridgeCategoryId, boolean>
}

export type BridgeProjection = {
  id: string
  category: RuntimeToolingBridgeCategoryId
  sourceClass: 'home-file'
  sourceRelativePath: string
  runtimeDestination: string
  accessMode: 'read-write-link'
  cleanupRule: 'bridge-owned-link'
}

function projection(
  id: string,
  category: RuntimeToolingBridgeCategoryId,
  relativePath: string,
): BridgeProjection {
  return {
    id,
    category,
    sourceClass: 'home-file',
    sourceRelativePath: relativePath,
    runtimeDestination: relativePath,
    accessMode: 'read-write-link',
    cleanupRule: 'bridge-owned-link',
  }
}

/**
 * Fixed, file-level projections shared by consent UX and runtime enforcement.
 *
 * These are links, not read-only copies: tools running in the managed runtime
 * can read and change an enabled file. Keep the catalog file-level so enabling
 * one category never exposes an entire host credential-store directory.
 */
export const RUNTIME_TOOLING_BRIDGE_PROJECTIONS: readonly BridgeProjection[] = [
  projection('git-config', 'sourceControl', '.gitconfig'),
  projection('git-ignore', 'sourceControl', '.gitignore'),
  projection('git-ignore-global', 'sourceControl', '.gitignore_global'),
  projection('git-message', 'sourceControl', '.gitmessage'),
  projection('xdg-git-config', 'sourceControl', '.config/git/config'),
  projection('npm-config', 'packageManagers', '.npmrc'),
  projection('pnpm-config', 'packageManagers', '.pnpmrc'),
  projection('yarn-config', 'packageManagers', '.yarnrc'),
  projection('yarn-modern-config', 'packageManagers', '.yarnrc.yml'),
  projection('xdg-npm-config', 'packageManagers', '.config/npm/npmrc'),
  projection('xdg-pnpm-config', 'packageManagers', '.config/pnpm/rc'),
  projection('ssh-config', 'ssh', '.ssh/config'),
  projection('ssh-known-hosts', 'ssh', '.ssh/known_hosts'),
  projection('ssh-allowed-signers', 'ssh', '.ssh/allowed_signers'),
  projection('github-hosts', 'githubCli', '.config/gh/hosts.yml'),
  projection('github-config', 'githubCli', '.config/gh/config.yml'),
  projection('aws-config', 'aws', '.aws/config'),
  projection('aws-credentials', 'aws', '.aws/credentials'),
  projection('azure-profile', 'azure', '.azure/azureProfile.json'),
  projection('azure-access-tokens', 'azure', '.azure/accessTokens.json'),
  projection('azure-msal-token-cache', 'azure', '.azure/msal_token_cache.json'),
  projection('gcloud-active-config', 'googleCloud', '.config/gcloud/active_config'),
  projection('gcloud-default-profile', 'googleCloud', '.config/gcloud/configurations/config_default'),
  projection('gcloud-credentials-db', 'googleCloud', '.config/gcloud/credentials.db'),
  projection('gcloud-access-tokens-db', 'googleCloud', '.config/gcloud/access_tokens.db'),
  projection('gcloud-adc', 'googleCloud', '.config/gcloud/application_default_credentials.json'),
  projection('docker-config', 'containers', '.docker/config.json'),
  projection('kubernetes-config', 'kubernetes', '.kube/config'),
]

export function createDisabledRuntimeToolingBridgeConsent(): RuntimeToolingBridgeConsent {
  return {
    version: RUNTIME_TOOLING_BRIDGE_CONSENT_VERSION,
    categories: Object.fromEntries(
      RUNTIME_TOOLING_BRIDGE_CATEGORIES.map(({ id }) => [id, false]),
    ) as Record<RuntimeToolingBridgeCategoryId, boolean>,
  }
}

export function normalizeRuntimeToolingBridgeConsent(value: unknown): RuntimeToolingBridgeConsent {
  const defaults = createDisabledRuntimeToolingBridgeConsent()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults
  const raw = value as { version?: unknown; categories?: unknown }
  if (raw.version !== RUNTIME_TOOLING_BRIDGE_CONSENT_VERSION) return defaults
  if (!raw.categories || typeof raw.categories !== 'object' || Array.isArray(raw.categories)) {
    return defaults
  }
  const categories = raw.categories as Record<string, unknown>
  return {
    version: RUNTIME_TOOLING_BRIDGE_CONSENT_VERSION,
    categories: Object.fromEntries(
      RUNTIME_TOOLING_BRIDGE_CATEGORIES.map(({ id }) => [id, categories[id] === true]),
    ) as Record<RuntimeToolingBridgeCategoryId, boolean>,
  }
}
