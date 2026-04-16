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
import { listCustomMcps, listCustomSkills } from './native-customizations.ts'
import { validateCustomMcpStdioCommand } from './mcp-stdio-policy.ts'
import { resolveConfiguredMcpRuntimeEntry, resolveCustomMcpRuntimeEntry } from './runtime-mcp.ts'

function resolveEnvPlaceholders<T>(value: T): T {
  if (typeof value === 'string') {
    return value.replace(/\{env:([A-Z0-9_]+)\}/g, (_match, envName) => process.env[envName] || '') as T
  }
  if (Array.isArray(value)) {
    return value.map((entry) => resolveEnvPlaceholders(entry)) as T
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, resolveEnvPlaceholders(entry)]),
    ) as T
  }
  return value
}

function isBuiltinRuntimeProvider(providerId: string) {
  return getAppConfig().providers.descriptors?.[providerId]?.runtime === 'builtin'
}

export function buildProviderRuntimeConfig(
  _providerId: string,
  provider: NonNullable<ReturnType<typeof getAppConfig>['providers']['custom']>[string],
  _settings: CoworkSettings,
  _selectedProviderId: string | null,
) {
  const options = resolveEnvPlaceholders(provider.options || {})

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

  const customMcps = listCustomMcps({ directory: projectDirectory || null })
  for (const builtin of getConfiguredMcpsFromConfig()) {
    const entry = resolveConfiguredMcpRuntimeEntry(builtin.name, settings)
    if (!entry) continue
    mcpConfig[builtin.name] = entry
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
  const managedSkillNames = Array.from(new Set([
    ...getConfiguredSkillsFromConfig().map((skill) => skill.sourceName),
    ...listCustomSkills({ directory: projectDirectory || null }).map((skill) => skill.name),
  ]))
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
  })

  config.permission = permission
  config.agent = buildOpenCoworkAgentConfig({
    allToolPatterns,
    allowToolPatterns: allowedPatterns,
    askToolPatterns: askPatterns,
    managedSkillNames,
    allowBash: settings.enableBash,
    allowEdits: settings.enableFileWrite,
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
