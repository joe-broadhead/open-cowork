import type { AgentConfig, Config, ProviderConfig } from '@opencode-ai/sdk/v2'
import {
  getAppConfig,
  getConfiguredMcpsFromConfig,
  getConfiguredSkillsFromConfig,
  getConfiguredToolAllowPatterns,
  getConfiguredToolAskPatterns,
  getConfiguredToolPatterns,
  getConfiguredToolsFromConfig,
  getProviderDescriptor,
} from './config-loader.ts'
import { getEffectiveSettings, getProviderCredentialValue, type CoworkSettings } from './settings.ts'
import { log } from './logger.ts'
import { buildOpenCoworkAgentConfig } from './agent-config.ts'
import { buildCoworkRuntimePermissionConfig } from './runtime-permissions.ts'
import { buildRuntimeCustomAgents } from './custom-agents-utils.ts'
import { listCustomAgents, listCustomMcps, listCustomSkills } from './native-customizations.ts'
import { validateCustomMcpStdioCommand } from './mcp-stdio-policy.ts'
import { evaluateBuiltInMcp, resolveCustomMcpRuntimeEntry, type BuiltInMcpSkipReason } from './runtime-mcp.ts'
import { getRuntimeSkillCatalogDir } from './runtime-paths.ts'
import { listEffectiveSkillsSync } from './effective-skills.ts'

type PlaceholderResolveOptions = {
  overrides?: Readonly<Record<string, string>>
  // Names that correspond to declared credential `env` fields. These
  // are NEVER allowed to fall through to `process.env` — the user's
  // Settings entry is the sole source of truth for credentials so a
  // stale shell export can't silently stand in for the real key.
  // Non-technical users (our target audience) don't export tokens to
  // their shell, so an env value there is always the wrong source.
  //
  // Placeholders for env names NOT in this set (e.g., a `baseUrl` that
  // references a build-time environment variable) can still fall
  // through to `process.env` if the user hasn't overridden them.
  credentialEnvNames?: ReadonlySet<string>
}

function resolveEnvPlaceholders<T>(value: T, options: PlaceholderResolveOptions = {}): T {
  // The allowlist lives at `allowedEnvPlaceholders` in config. Only vars
  // that appear in that list can be expanded inline via `{env:FOO}` — any
  // other reference is removed (replaced with empty string) to prevent a
  // misconfigured provider options block from quietly exfiltrating
  // AWS_SECRET_ACCESS_KEY, DATABASE_URL, etc. into the OpenCode runtime
  // config. The outer config loader runs the same gate during file reads
  // with stricter behaviour (throws); this inline expansion is the last
  // line of defence when a config layer bypasses that helper.
  const allowed = new Set(getAppConfig().allowedEnvPlaceholders || [])
  const { overrides, credentialEnvNames } = options
  const expand = <V>(raw: V): V => {
    if (typeof raw === 'string') {
      return raw.replace(/\{env:([A-Z0-9_]+)\}/g, (_match, envName) => {
        if (!allowed.has(envName)) return ''
        const override = overrides?.[envName]
        if (override) return override
        if (credentialEnvNames?.has(envName)) return ''
        return process.env[envName] || ''
      }) as V
    }
    if (Array.isArray(raw)) {
      return raw.map((entry) => expand(entry)) as V
    }
    if (raw && typeof raw === 'object') {
      return Object.fromEntries(
        Object.entries(raw as Record<string, unknown>).map(([key, entry]) => [key, expand(entry)]),
      ) as V
    }
    return raw
  }
  return expand(value)
}

// Build an env-override map from a custom provider's stored credentials.
// Credentials with an `env` field are mapped { envName: value }, so any
// `{env:NAME}` placeholder in `options` resolves against the user's
// Settings entry even when the OS env isn't populated. Without this,
// custom providers like Databricks would require users to export their
// token into the shell before launching — the Settings UI would look
// wired but do nothing at runtime.
function buildCredentialEnvOverrides(
  providerId: string,
  provider: NonNullable<ReturnType<typeof getAppConfig>['providers']['custom']>[string],
  settings: CoworkSettings,
): Record<string, string> {
  const credentials = provider.credentials || []
  const overrides: Record<string, string> = {}
  const mapped: string[] = []
  const missing: string[] = []
  for (const credential of credentials) {
    if (!credential.env) continue
    const value = getProviderCredentialValue(settings, providerId, credential.key)
    if (value) {
      overrides[credential.env] = value
      const fp = value.length <= 10
        ? `len=${value.length}`
        : `len=${value.length} ${value.slice(0, 4)}…${value.slice(-4)}`
      mapped.push(`${credential.env}=<${fp}>`)
    } else {
      missing.push(`${credential.env} (key=${credential.key})`)
    }
  }
  if (mapped.length > 0 || missing.length > 0) {
    log('runtime', `credential-env-overrides provider=${providerId} mapped=[${mapped.join(', ')}] missing=[${missing.join(', ')}]`)
  }
  return overrides
}

function isBuiltinRuntimeProvider(providerId: string) {
  return getAppConfig().providers.descriptors?.[providerId]?.runtime === 'builtin'
}

export function buildProviderRuntimeConfig(
  providerId: string,
  provider: NonNullable<ReturnType<typeof getAppConfig>['providers']['custom']>[string],
  settings: CoworkSettings,
  _selectedProviderId: string | null,
) {
  const envOverrides = buildCredentialEnvOverrides(providerId, provider, settings)
  // Credential-scoped placeholders (env names declared in
  // `credentials[].env`) must come from the Settings UI — never from
  // `process.env`. A stale shell `DATABRICKS_TOKEN` export would
  // otherwise masquerade as the user's stored credential, which is
  // exactly the bug that surfaced during Databricks onboarding for a
  // non-technical user. Non-credential placeholders (e.g. a
  // configurable baseUrl) can still fall through to `process.env` as
  // before.
  const credentialEnvNames = new Set(
    (provider.credentials || [])
      .map((credential) => credential.env)
      .filter((envName): envName is string => typeof envName === 'string' && envName.length > 0),
  )
  const options = resolveEnvPlaceholders(provider.options || {}, {
    overrides: envOverrides,
    credentialEnvNames,
  })

  // Diagnostic breadcrumb so "token rejected" errors can be distinguished
  // from "host URL mangled" — without leaking credentials. `baseURL` is
  // logged verbatim (it's a public endpoint); secrets are reported as a
  // fingerprint — length plus first/last 4 chars — enough to spot a
  // truncated / trailing-newline / wrong-token case without exposing the
  // full value.
  const fingerprint = (value: string) => (
    value.length <= 10
      ? `<len ${value.length}>`
      : `<len ${value.length} ${value.slice(0, 4)}…${value.slice(-4)}>`
  )
  const optionsShape = Object.entries(options).map(([key, value]) => {
    if (key === 'baseURL' && typeof value === 'string') return `${key}=${value}`
    if (typeof value === 'string') return `${key}=${fingerprint(value)}`
    return `${key}=<${typeof value}>`
  })
  log('runtime', `provider=${providerId} options {${optionsShape.join(', ')}}`)

  return {
    npm: provider.npm,
    name: provider.name,
    options,
    models: provider.models,
  }
}

export function buildBuiltinProviderRuntimeConfig(
  providerId: string,
  settings: CoworkSettings,
) {
  const descriptor = getAppConfig().providers.descriptors?.[providerId]
  if (!descriptor) return null

  const options = {
    // Built-in provider options (default base URLs, regions) can still
    // resolve from `process.env` when unset — these are non-credential
    // settings and power-user overrides via shell exports are a
    // reasonable escape hatch. The actual secret keys are overlaid from
    // Settings below via the `credentials` map.
    ...resolveEnvPlaceholders(descriptor.options || {}),
    ...Object.fromEntries(
      descriptor.credentials.flatMap((credential) => {
        const value = getProviderCredentialValue(settings, providerId, credential.key)
        const runtimeKey = credential.runtimeKey || credential.key
        return value ? [[runtimeKey, value]] : []
      }),
    ),
  }

  return {
    name: descriptor.name,
    ...(Object.keys(options).length > 0 ? { options } : {}),
  }
}

export function buildEffectiveProviderRuntimeConfig(
  providerId: string,
  settings: CoworkSettings,
  selectedProviderId: string | null,
) {
  if (isBuiltinRuntimeProvider(providerId)) {
    return buildBuiltinProviderRuntimeConfig(providerId, settings)
  }

  const customProvider = getAppConfig().providers.custom?.[providerId]
  if (customProvider) {
    return buildProviderRuntimeConfig(providerId, customProvider, settings, selectedProviderId)
  }
  return null
}

export function buildRuntimeConfig(projectDirectory?: string | null): Config {
  const settings = getEffectiveSettings()
  const configModel = settings.effectiveModel || getAppConfig().providers.defaultModel || ''
  const providerId = settings.effectiveProviderId || getAppConfig().providers.defaultProvider || 'openrouter'
  const providerDescriptor = getProviderDescriptor(providerId)
  const fallbackSmallModel = providerDescriptor?.models?.find((model) => model.id !== configModel)?.id || configModel
  const modelStr = configModel ? `${providerId}/${configModel}` : `${providerId}`
  const smallModelStr = fallbackSmallModel ? `${providerId}/${fallbackSmallModel}` : modelStr

  const mcpConfig: NonNullable<Config['mcp']> = {}
  const compactionConfig = getAppConfig().compaction
  const config: Config = {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'manual',
    model: modelStr,
    small_model: smallModelStr,
    compaction: {
      auto: compactionConfig.auto,
      prune: compactionConfig.prune,
      reserved: compactionConfig.reserved,
    },
    mcp: mcpConfig,
    // Point OpenCode at a Cowork-built runtime skill catalog rather
    // than the raw bundled/custom storage directories. That lets the
    // product layer keep SDK discovery self-contained while rewriting
    // supporting-file paths into workspace-local mirrors that the
    // model can actually read in project-scoped sessions.
    skills: {
      paths: [getRuntimeSkillCatalogDir()],
    },
  }

  const providerConfigEntries: Record<string, ProviderConfig> = Object.fromEntries(
    Object.entries(getAppConfig().providers.custom || {})
      .filter(([id]) => !isBuiltinRuntimeProvider(id))
      .map(([id, provider]) => [
        id,
        buildProviderRuntimeConfig(id, provider, settings, providerId),
      ]),
  )
  if (providerId && !providerConfigEntries[providerId]) {
    const selectedProviderConfig = buildEffectiveProviderRuntimeConfig(providerId, settings, providerId)
    if (selectedProviderConfig) {
      providerConfigEntries[providerId] = selectedProviderConfig
    }
  }
  if (Object.keys(providerConfigEntries).length > 0) {
    config.provider = providerConfigEntries
  }

  const contextOptions = { directory: projectDirectory || null }
  const customMcps = listCustomMcps(contextOptions)
  const customSkills = listCustomSkills(contextOptions)
  const customAgentsRaw = listCustomAgents(contextOptions)
  const availableSkills = listEffectiveSkillsSync(contextOptions).map((skill) => ({
    name: skill.name,
    label: skill.label,
    description: skill.description,
    source: skill.source,
    origin: skill.origin,
    scope: skill.scope,
    location: skill.location,
    toolIds: skill.toolIds,
  }))
  // Partition bundled MCPs: register only the ones that are genuinely
  // runnable right now. Everything else is reported in a single
  // breadcrumb line so boot logs don't scream "X failed" for MCPs the
  // user never intended to use.
  const skippedByReason: Record<BuiltInMcpSkipReason, string[]> = {
    'not-configured': [],
    'not-signed-in-google': [],
    'disabled-by-user': [],
    'awaiting-oauth-opt-in': [],
  }
  for (const builtin of getConfiguredMcpsFromConfig()) {
    const resolution = evaluateBuiltInMcp(builtin, settings)
    if (resolution.status === 'ready') {
      mcpConfig[builtin.name] = resolution.entry
    } else if (resolution.status === 'skipped') {
      skippedByReason[resolution.reason].push(builtin.name)
    }
  }
  const skipSummary = (Object.entries(skippedByReason) as Array<[BuiltInMcpSkipReason, string[]]>)
    .filter(([, names]) => names.length > 0)
    .map(([reason, names]) => `${reason}=[${names.join(', ')}]`)
    .join(' ')
  if (skipSummary) {
    log('mcp', `Skipping bundled MCPs — ${skipSummary}`)
  }
  for (const customMcp of customMcps) {
    try {
      if (customMcp.type === 'stdio') {
        validateCustomMcpStdioCommand(customMcp)
      }
    } catch (error) {
      log('runtime', `Skipping invalid local MCP ${customMcp.name}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const entry = resolveCustomMcpRuntimeEntry(customMcp)
    if (!entry) continue
    mcpConfig[customMcp.name] = entry
  }

  const configuredTools = getConfiguredToolsFromConfig()
  const configuredSkills = getConfiguredSkillsFromConfig()
  const managedSkillNames = Array.from(new Set(availableSkills.map((skill) => skill.name)))

  // Register custom agents with the OpenCode SDK so the primary agent
  // can route `task` invocations to them and the @ picker / runtime
  // catalog reflects the same set the user sees on the Agents page.
  // Without this, customs show in `agents:list` (disk) but the SDK
  // never knows about them. See custom-agents-utils.ts for the catalog
  // assembly; we skip the async runtime-tool augmentation here since
  // descriptions aren't load-bearing for runtime registration.
  const customAgents = buildRuntimeCustomAgents({
    state: {
      customMcps,
      customSkills,
      customAgents: customAgentsRaw,
    },
    builtinTools: configuredTools,
    builtinSkills: configuredSkills,
    availableSkills,
  })
  const customMcpPatterns = Array.from(new Set(
    customMcps
      .filter((customMcp) => Boolean(customMcp.name))
      .map((customMcp) => `mcp__${customMcp.name}__*`),
  ))
  const allowedPatterns = Array.from(new Set(configuredTools.flatMap((tool) => getConfiguredToolAllowPatterns(tool))))
  const askPatterns = Array.from(new Set([
    ...configuredTools.flatMap((tool) => getConfiguredToolAskPatterns(tool)),
    ...customMcpPatterns,
  ]))
  const allToolPatterns = Array.from(new Set([
    ...configuredTools.flatMap((tool) => getConfiguredToolPatterns(tool)),
    ...customMcpPatterns,
  ]))
  const permission = buildCoworkRuntimePermissionConfig({
    managedSkillNames,
    allowPatterns: allowedPatterns,
    askPatterns,
    allowBash: settings.enableBash,
    allowEdits: settings.enableFileWrite,
    projectDirectory,
  })

  config.permission = permission
  config.agent = buildOpenCoworkAgentConfig({
    allToolPatterns,
    allowToolPatterns: allowedPatterns,
    askToolPatterns: askPatterns,
    managedSkillNames,
    availableSkillNames: managedSkillNames,
    allowBash: settings.enableBash,
    allowEdits: settings.enableFileWrite,
    projectDirectory,
    customAgents,
  })

  // If the user supplied compaction-agent overrides (model / prompt /
  // temperature), inject them under `agent.compaction` — the dedicated SDK
  // slot OpenCode uses for session summarization.
  if (compactionConfig.agent) {
    const compactionAgent: AgentConfig = {}
    if (compactionConfig.agent.model) compactionAgent.model = compactionConfig.agent.model
    if (compactionConfig.agent.prompt) compactionAgent.prompt = compactionConfig.agent.prompt
    if (typeof compactionConfig.agent.temperature === 'number') {
      compactionAgent.temperature = compactionConfig.agent.temperature
    }
    if (Object.keys(compactionAgent).length > 0) {
      config.agent = {
        ...config.agent,
        compaction: compactionAgent,
      }
    }
  }

  log('runtime', `Config built: provider=${providerId} model=${modelStr}`)

  return config
}
