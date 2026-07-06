import type { AgentConfig, Config, ProviderConfig } from '@opencode-ai/sdk/v2'
import type { CustomMcpConfig, ProviderModelDescriptor } from '@open-cowork/shared'
import {
  getAppConfig,
  getConfiguredMcpsFromConfig,
  getConfiguredSkillsFromConfig,
  getConfiguredToolAllowPatterns,
  getConfiguredToolAskPatterns,
  getConfiguredToolPatterns,
  getConfiguredToolsFromConfig,
  expandMcpToolPermissionPatterns,
} from './config-loader-core.js'
import type { ConfiguredProviderDescriptor } from '@open-cowork/shared'
import { getEffectiveSettings, getProviderCredentialValue, type CoworkSettings } from './settings.js'
import { log } from '@open-cowork/shared/node'
import { buildOpenCoworkAgentConfig } from './agent-config.js'
import { buildCoworkRuntimePermissionConfig } from './runtime-permissions.js'
import { buildRuntimeCustomAgents } from './custom-agents-utils.js'
import { listCustomAgents, listCustomMcps, listCustomSkills } from './native-customizations.js'
import { validateCustomMcpStdioCommand } from './mcp-stdio-policy.js'
import {
  evaluateBuiltInMcp,
  resolveCustomMcpRuntimeEntry,
  resolveCustomMcpRuntimeEntryForRuntime,
  type BuiltInMcpSkipReason,
  type ResolvedRuntimeMcpEntry,
} from './runtime-mcp.js'
import { listEffectiveSkillsSync } from './effective-skills.js'
import { evaluateHttpMcpUrlResolved } from './mcp-url-policy.js'
import type { PermissionAction } from './permission-config.js'
import { getRuntimeSkillCatalogDir } from './runtime-paths.js'

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

type RuntimeConfigBuildDiagnostic = {
  scope: 'runtime' | 'mcp'
  message: string
}

function emitRuntimeConfigBuildDiagnostics(diagnostics: readonly RuntimeConfigBuildDiagnostic[]) {
  for (const diagnostic of diagnostics) {
    log(diagnostic.scope, diagnostic.message)
  }
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
  diagnostics: RuntimeConfigBuildDiagnostic[],
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
      mapped.push(`${credential.env}=<len=${value.length} redacted>`)
    } else {
      missing.push(`${credential.env} (key=${credential.key})`)
    }
  }
  if (mapped.length > 0 || missing.length > 0) {
    diagnostics.push({
      scope: 'runtime',
      message: `credential-env-overrides provider=${providerId} mapped=[${mapped.join(', ')}] missing=[${missing.join(', ')}]`,
    })
  }
  return overrides
}

function isBuiltinRuntimeProvider(providerId: string) {
  return getAppConfig().providers.descriptors?.[providerId]?.runtime === 'builtin'
}

function buildDescriptorModelRuntimeConfig(
  models: ProviderModelDescriptor[] | undefined,
): NonNullable<ProviderConfig['models']> | undefined {
  if (!models?.length) return undefined
  return Object.fromEntries(
    models.map((model) => [
      model.id,
      {
        id: model.id,
        name: model.name,
        ...(model.reasoning ? { reasoning: true } : {}),
        ...(model.variants?.length
          ? { variants: Object.fromEntries(model.variants.map((variant) => [variant, {}])) }
          : {}),
      },
    ]),
  )
}

export function buildConfiguredDescriptorProviderRuntimeConfig(
  descriptor: ConfiguredProviderDescriptor,
  credentialValues: Record<string, string | null | undefined>,
): ProviderConfig | null {
  const credentialEntries = Object.fromEntries(
    descriptor.credentials.flatMap((credential) => {
      const value = credentialValues[credential.key]
      const runtimeKey = credential.runtimeKey || credential.key
      return value ? [[runtimeKey, value]] : []
    }),
  )
  const options = {
    // Built-in provider options (default base URLs, regions) can still
    // resolve from `process.env` when unset — these are non-credential
    // settings and power-user overrides via shell exports are a
    // reasonable escape hatch. Secret credentials are overlaid by key
    // from the explicit credential value map below.
    ...resolveEnvPlaceholders(descriptor.options || {}),
    ...credentialEntries,
  }
  const models = buildDescriptorModelRuntimeConfig(descriptor.models)
  const hasOptions = Object.keys(options).length > 0

  // Most OpenCode-native providers such as OpenAI should be omitted
  // unless Cowork has options, API-key credentials, or model overrides to
  // contribute. Passing a name-only provider object can shadow OpenCode's
  // built-in metadata and make the runtime choose the API-key auth path
  // even after browser login. Some dormant OpenCode-native providers,
  // including GitHub Copilot in the pinned runtime, only appear after a
  // minimal provider config entry exists; those descriptors opt into
  // runtimeActivation: "config".
  if (!hasOptions && !models) {
    return descriptor.runtimeActivation === 'config'
      ? { name: descriptor.name }
      : null
  }

  return {
    name: descriptor.name,
    ...(hasOptions ? { options } : {}),
    ...(models ? { models } : {}),
  }
}

function buildProviderRuntimeConfigResult(
  providerId: string,
  provider: NonNullable<ReturnType<typeof getAppConfig>['providers']['custom']>[string],
  settings: CoworkSettings,
  _selectedProviderId: string | null,
): { config: ProviderConfig; diagnostics: RuntimeConfigBuildDiagnostic[] } {
  const diagnostics: RuntimeConfigBuildDiagnostic[] = []
  const envOverrides = buildCredentialEnvOverrides(providerId, provider, settings, diagnostics)
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
  // from "host URL mangled" without leaking credential prefixes/suffixes.
  // `baseURL` is logged verbatim because it is a public endpoint; every
  // other string option is reduced to length-only metadata.
  const redactedLength = (value: string) => `<len=${value.length} redacted>`
  const optionsShape = Object.entries(options).map(([key, value]) => {
    if (key === 'baseURL' && typeof value === 'string') return `${key}=${value}`
    if (typeof value === 'string') return `${key}=${redactedLength(value)}`
    return `${key}=<${typeof value}>`
  })
  diagnostics.push({ scope: 'runtime', message: `provider=${providerId} options {${optionsShape.join(', ')}}` })

  return {
    config: {
      npm: provider.npm,
      name: provider.name,
      options,
      models: provider.models,
    },
    diagnostics,
  }
}

export function buildProviderRuntimeConfig(
  providerId: string,
  provider: NonNullable<ReturnType<typeof getAppConfig>['providers']['custom']>[string],
  settings: CoworkSettings,
  selectedProviderId: string | null,
) {
  const result = buildProviderRuntimeConfigResult(providerId, provider, settings, selectedProviderId)
  emitRuntimeConfigBuildDiagnostics(result.diagnostics)
  return result.config
}

function buildBuiltinProviderRuntimeConfig(
  providerId: string,
  settings: CoworkSettings,
) {
  const descriptor = getAppConfig().providers.descriptors?.[providerId]
  if (!descriptor) return null
  const credentialValues = Object.fromEntries(
    descriptor.credentials.flatMap((credential) => {
      const value = getProviderCredentialValue(settings, providerId, credential.key)
      return value ? [[credential.key, value]] : []
    }),
  )
  return buildConfiguredDescriptorProviderRuntimeConfig(descriptor, credentialValues)
}

function buildEffectiveProviderRuntimeConfigResult(
  providerId: string,
  settings: CoworkSettings,
  selectedProviderId: string | null,
): { config: ProviderConfig | null; diagnostics: RuntimeConfigBuildDiagnostic[] } {
  if (isBuiltinRuntimeProvider(providerId)) {
    return { config: buildBuiltinProviderRuntimeConfig(providerId, settings), diagnostics: [] }
  }

  const customProvider = getAppConfig().providers.custom?.[providerId]
  if (customProvider) {
    return buildProviderRuntimeConfigResult(providerId, customProvider, settings, selectedProviderId)
  }
  return { config: null, diagnostics: [] }
}

export function buildEffectiveProviderRuntimeConfig(
  providerId: string,
  settings: CoworkSettings,
  selectedProviderId: string | null,
) {
  const result = buildEffectiveProviderRuntimeConfigResult(providerId, settings, selectedProviderId)
  emitRuntimeConfigBuildDiagnostics(result.diagnostics)
  return result.config
}

function applyUserPermissionPolicy(
  defaultPolicy: PermissionAction,
  selectedPolicy: PermissionAction | undefined,
  legacyEnabled: boolean,
): PermissionAction {
  return legacyEnabled ? selectedPolicy || defaultPolicy : 'deny'
}

function webSearchPolicy(web: PermissionAction, enabled: boolean): PermissionAction {
  return enabled ? web : 'deny'
}

function isGlobalMcpToolPattern(pattern: string) {
  return pattern === 'mcp__*'
}

function isKnownMcpToolPattern(pattern: string, mcpToolPatterns: ReadonlySet<string>) {
  return isGlobalMcpToolPattern(pattern) || mcpToolPatterns.has(pattern)
}

function stripProviderPrefix(providerId: string, modelId: string | null | undefined) {
  const trimmed = modelId?.trim()
  if (!trimmed) return ''
  const prefix = `${providerId}/`
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed
}

function resolveRuntimeSmallModelId(input: {
  providerId: string
  selectedModelId: string
  selectedSmallModelId?: string | null
  appConfig: ReturnType<typeof getAppConfig>
}) {
  const settingsSmallModel = stripProviderPrefix(input.providerId, input.selectedSmallModelId)
  if (settingsSmallModel) return settingsSmallModel
  const descriptorSmallModel = input.appConfig.providers.descriptors?.[input.providerId]?.smallModel
  const customSmallModel = input.appConfig.providers.custom?.[input.providerId]?.smallModel
  return stripProviderPrefix(input.providerId, descriptorSmallModel || customSmallModel)
    || input.selectedModelId
}

function buildRuntimeConfigWithCustomMcpsResult(
  projectDirectory: string | null | undefined,
  customMcps: CustomMcpConfig[],
  resolvedCustomMcpEntries?: Map<string, ResolvedRuntimeMcpEntry>,
): { config: Config; diagnostics: RuntimeConfigBuildDiagnostic[] } {
  const diagnostics: RuntimeConfigBuildDiagnostic[] = []
  const settings = getEffectiveSettings()
  const appConfig = getAppConfig()
  const appPermissions = appConfig.permissions
  const bashPolicy = applyUserPermissionPolicy(appPermissions.bash, settings.bashPermission, settings.enableBash)
  const fileWritePolicy = applyUserPermissionPolicy(appPermissions.fileWrite, settings.fileWritePermission, settings.enableFileWrite)
  const webPolicy = applyUserPermissionPolicy(appPermissions.web, settings.webPermission, true)
  const effectiveWebSearchPolicy = webSearchPolicy(webPolicy, settings.webSearchEnabled && appPermissions.webSearch)
  const taskPolicy = applyUserPermissionPolicy(appPermissions.task, settings.taskPermission, true)
  const externalDirectoryPolicy = applyUserPermissionPolicy('allow', settings.externalDirectoryPermission, true)
  const mcpPolicy = applyUserPermissionPolicy('allow', settings.mcpPermission, true)
  const providerId = settings.effectiveProviderId || appConfig.providers.defaultProvider || 'openrouter'
  const configModel = settings.effectiveModel
    || (providerId === appConfig.providers.defaultProvider ? appConfig.providers.defaultModel || '' : '')
  const modelId = stripProviderPrefix(providerId, configModel)
  const modelStr = modelId ? `${providerId}/${modelId}` : `${providerId}`
  const smallModelId = resolveRuntimeSmallModelId({
    providerId,
    selectedModelId: modelId,
    selectedSmallModelId: settings.effectiveSmallModel || settings.selectedSmallModelId,
    appConfig,
  })
  const smallModelStr = smallModelId ? `${providerId}/${smallModelId}` : modelStr

  const mcpConfig: NonNullable<Config['mcp']> = {}
  const compactionConfig = getAppConfig().compaction
  // Enforce the configured provider allow-list at the runtime layer. Without
  // `enabled_providers`, OpenCode's `provider.list()` returns the entire
  // models.dev catalogue regardless of `providers.available`, so the UI filter
  // was the only thing scoping providers. Passing the allow-list through makes
  // the runtime itself reject providers outside it. Only set it when non-empty
  // — an empty array would disable every provider at runtime.
  const enabledProviders = Array.from(new Set(appConfig.providers.available))
  const config: Config = {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'manual',
    ...(enabledProviders.length > 0 ? { enabled_providers: enabledProviders } : {}),
    model: modelStr,
    small_model: smallModelStr,
    compaction: {
      auto: compactionConfig.auto,
      prune: compactionConfig.prune,
      reserved: compactionConfig.reserved,
    },
    skills: {
      paths: [getRuntimeSkillCatalogDir()],
    },
    mcp: mcpConfig,
  }

  const providerConfigEntries: Record<string, ProviderConfig> = {}
  for (const [id, provider] of Object.entries(getAppConfig().providers.custom || {})) {
    if (isBuiltinRuntimeProvider(id)) continue
    const result = buildProviderRuntimeConfigResult(id, provider, settings, providerId)
    providerConfigEntries[id] = result.config
    diagnostics.push(...result.diagnostics)
  }
  if (providerId && !providerConfigEntries[providerId]) {
    const selectedProviderConfig = buildEffectiveProviderRuntimeConfigResult(providerId, settings, providerId)
    diagnostics.push(...selectedProviderConfig.diagnostics)
    if (selectedProviderConfig.config) {
      providerConfigEntries[providerId] = selectedProviderConfig.config
    }
  }
  if (Object.keys(providerConfigEntries).length > 0) {
    config.provider = providerConfigEntries
  }

  const contextOptions = { directory: projectDirectory || null }
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
    'command-not-installed': [],
  }
  if (mcpPolicy === 'deny') {
    diagnostics.push({ scope: 'mcp', message: 'Skipping MCP registration because MCP tools are disabled by user settings.' })
  } else {
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
      diagnostics.push({ scope: 'mcp', message: `Skipping bundled MCPs — ${skipSummary}` })
    }
    for (const customMcp of customMcps) {
      try {
        if (customMcp.type === 'stdio') {
          validateCustomMcpStdioCommand(customMcp)
        }
      } catch (error) {
        diagnostics.push({
          scope: 'runtime',
          message: `Skipping invalid local MCP ${customMcp.name}: ${error instanceof Error ? error.message : String(error)}`,
        })
        continue
      }
      const entry = resolvedCustomMcpEntries
        ? resolvedCustomMcpEntries.get(customMcp.name) || null
        : resolveCustomMcpRuntimeEntry(customMcp)
      if (!entry) continue
      mcpConfig[customMcp.name] = entry
    }
  }

  const configuredTools = getConfiguredToolsFromConfig()
  const configuredSkills = getConfiguredSkillsFromConfig()
  const managedSkillNames = Array.from(new Set(availableSkills.map((skill) => skill.name)))

  // User-created agents are native OpenCode agent markdown files in the
  // managed runtime config home. Do not also inject them into `config.agent`;
  // registering the same agent through two OpenCode surfaces can create
  // duplicate task execution. We only build descriptors here so built-in
  // primary agents can mention them and grant task delegation by name.
  const customDelegationAgents = buildRuntimeCustomAgents({
    state: {
      customMcps,
      customSkills,
      customAgents: customAgentsRaw,
    },
    builtinTools: configuredTools,
    builtinSkills: configuredSkills,
    availableSkills,
  })
  const customMcpPermissionPatterns = (customMcp: CustomMcpConfig) =>
    customMcp.name
      ? expandMcpToolPermissionPatterns([`mcp__${customMcp.name}__*`])
      : []
  const trustedCustomMcpPatterns = customMcps
    .filter((customMcp) => customMcp.permissionMode === 'allow')
    .flatMap(customMcpPermissionPatterns)
  const approvalCustomMcpPatterns = customMcps
    .filter((customMcp) => customMcp.permissionMode !== 'allow')
    .flatMap(customMcpPermissionPatterns)
  const customMcpPatterns = Array.from(new Set([
    ...trustedCustomMcpPatterns,
    ...approvalCustomMcpPatterns,
  ]))
  const configuredMcpPatterns = configuredTools.flatMap((tool) => {
    const patterns = getConfiguredToolPatterns(tool)
    return patterns.some((pattern) => pattern === 'mcp__*' || pattern.startsWith('mcp__')) ? patterns : []
  })
  const mcpToolPatterns = new Set([
    ...configuredMcpPatterns,
    ...customMcpPatterns,
  ])
  const rawAllowedPatterns = Array.from(new Set([
    ...configuredTools.flatMap((tool) => getConfiguredToolAllowPatterns(tool)),
    ...trustedCustomMcpPatterns,
  ]))
  const rawAskPatterns = Array.from(new Set([
    ...configuredTools.flatMap((tool) => getConfiguredToolAskPatterns(tool)),
    ...approvalCustomMcpPatterns,
  ]))
  const isMcpPattern = (pattern: string) => isKnownMcpToolPattern(pattern, mcpToolPatterns)
  const allowedPatterns = rawAllowedPatterns.filter((pattern) => !isMcpPattern(pattern) || mcpPolicy === 'allow')
  const askPatterns = Array.from(new Set([
    ...rawAskPatterns.filter((pattern) => !isMcpPattern(pattern)),
    ...(mcpPolicy === 'allow'
      ? rawAskPatterns.filter(isMcpPattern)
      : mcpPolicy === 'ask'
        ? [...rawAllowedPatterns, ...rawAskPatterns].filter(isMcpPattern)
        : []),
  ]))
  const allToolPatterns = Array.from(new Set([
    ...configuredTools.flatMap((tool) => getConfiguredToolPatterns(tool)),
    ...customMcpPatterns,
  ]))
  const deniedPatterns: string[] = mcpPolicy === 'deny' ? ['mcp__*', ...Array.from(mcpToolPatterns)] : []
  const permission = buildCoworkRuntimePermissionConfig({
    managedSkillNames,
    allowPatterns: allowedPatterns,
    askPatterns,
    deniedPatterns,
    bash: bashPolicy,
    fileWrite: fileWritePolicy,
    task: taskPolicy,
    web: webPolicy,
    webSearch: effectiveWebSearchPolicy,
    externalDirectory: externalDirectoryPolicy,
    projectDirectory,
  })

  config.permission = permission
  config.agent = buildOpenCoworkAgentConfig({
    allToolPatterns,
    allowToolPatterns: allowedPatterns,
    askToolPatterns: askPatterns,
    deniedToolPatterns: deniedPatterns,
    managedSkillNames,
    availableSkillNames: managedSkillNames,
    bash: bashPolicy,
    fileWrite: fileWritePolicy,
    task: taskPolicy,
    web: webPolicy,
    webSearch: effectiveWebSearchPolicy,
    externalDirectory: externalDirectoryPolicy,
    projectDirectory,
    customDelegationAgents,
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

  diagnostics.push({ scope: 'runtime', message: `Config built: provider=${providerId} model=${modelStr}` })

  return { config, diagnostics }
}

function buildRuntimeConfigWithCustomMcps(
  projectDirectory: string | null | undefined,
  customMcps: CustomMcpConfig[],
  resolvedCustomMcpEntries?: Map<string, ResolvedRuntimeMcpEntry>,
): Config {
  const result = buildRuntimeConfigWithCustomMcpsResult(projectDirectory, customMcps, resolvedCustomMcpEntries)
  emitRuntimeConfigBuildDiagnostics(result.diagnostics)
  return result.config
}

async function listRuntimeEligibleCustomMcps(projectDirectory?: string | null) {
  const diagnostics: RuntimeConfigBuildDiagnostic[] = []
  const contextOptions = { directory: projectDirectory || null }
  const customMcps = listCustomMcps(contextOptions)
  const eligible: CustomMcpConfig[] = []

  for (const customMcp of customMcps) {
    if (customMcp.type === 'http' && customMcp.url) {
      const verdict = await evaluateHttpMcpUrlResolved(customMcp.url, {
        allowPrivateNetwork: customMcp.allowPrivateNetwork,
      })
      if (!verdict.ok) {
        diagnostics.push({ scope: 'mcp', message: `Skipping HTTP MCP ${customMcp.name}: ${verdict.reason}` })
        continue
      }
    }
    eligible.push(customMcp)
  }

  return { customMcps: eligible, diagnostics }
}

export function buildRuntimeConfig(projectDirectory?: string | null): Config {
  return buildRuntimeConfigWithCustomMcps(
    projectDirectory,
    listCustomMcps({ directory: projectDirectory || null }),
  )
}

export async function buildRuntimeConfigForRuntime(projectDirectory?: string | null): Promise<Config> {
  const settings = getEffectiveSettings()
  const mcpPolicy = applyUserPermissionPolicy('allow', settings.mcpPermission, true)
  if (mcpPolicy === 'deny') {
    const result = buildRuntimeConfigWithCustomMcpsResult(
      projectDirectory,
      listCustomMcps({ directory: projectDirectory || null }),
      new Map(),
    )
    emitRuntimeConfigBuildDiagnostics(result.diagnostics)
    return result.config
  }
  const eligible = await listRuntimeEligibleCustomMcps(projectDirectory)
  const resolvedCustomMcpEntries = new Map<string, ResolvedRuntimeMcpEntry>()
  for (const customMcp of eligible.customMcps) {
    const entry = await resolveCustomMcpRuntimeEntryForRuntime(customMcp)
    if (entry) resolvedCustomMcpEntries.set(customMcp.name, entry)
  }
  const result = buildRuntimeConfigWithCustomMcpsResult(
    projectDirectory,
    eligible.customMcps,
    resolvedCustomMcpEntries,
  )
  emitRuntimeConfigBuildDiagnostics([...eligible.diagnostics, ...result.diagnostics])
  return result.config
}
