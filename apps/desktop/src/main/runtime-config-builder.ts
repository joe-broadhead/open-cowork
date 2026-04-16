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
import { getEffectiveSettings } from './settings.ts'
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

export function buildRuntimeConfig(projectDirectory?: string | null): Record<string, unknown> {
  const settings = getEffectiveSettings()
  const configModel = settings.effectiveModel || getAppConfig().providers.defaultModel || ''
  const providerId = settings.effectiveProviderId || getAppConfig().providers.defaultProvider || 'anthropic'
  const providerDescriptor = getProviderDescriptor(providerId)
  const fallbackSmallModel = providerDescriptor?.models?.find((model) => model.id !== configModel)?.id || configModel
  const modelStr = configModel ? `${providerId}/${configModel}` : `${providerId}`
  const smallModelStr = fallbackSmallModel ? `${providerId}/${fallbackSmallModel}` : modelStr

  const config: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'manual',
    model: modelStr,
    small_model: smallModelStr,
    compaction: {
      auto: true,
      prune: true,
      reserved: 10_000,
    },
    mcp: {},
  }

  const customProviders = getAppConfig().providers.custom || {}
  if (Object.keys(customProviders).length > 0) {
    config.provider = Object.fromEntries(
      Object.entries(customProviders).map(([id, provider]) => [
        id,
        {
          npm: provider.npm,
          name: provider.name,
          options: resolveEnvPlaceholders(provider.options || {}),
          models: provider.models,
        },
      ]),
    )
  }

  const customMcps = listCustomMcps({ directory: projectDirectory || null })
  const mcpConfig = config.mcp as Record<string, unknown>
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

  log('runtime', `Config built: provider=${providerId} model=${modelStr}`)

  return config
}
