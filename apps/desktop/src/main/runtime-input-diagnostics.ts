import { getEffectiveSettings } from '@open-cowork/runtime-host/settings'
import { getBundledOpencodeVersion } from '@open-cowork/runtime-host/runtime-opencode-cli'
import { evaluateBuiltInMcp } from '@open-cowork/runtime-host/runtime-mcp'
import { buildEffectiveProviderRuntimeConfig } from '@open-cowork/runtime-host/runtime-config-builder'
import { listCustomMcps, listCustomSkills } from '@open-cowork/runtime-host/native-customizations'
import { evaluateHttpMcpUrl } from '@open-cowork/runtime-host/mcp-url-policy'
import { validateCustomMcpStdioCommand } from '@open-cowork/runtime-host/mcp-stdio-policy'
import { listEffectiveSkillsSync } from '@open-cowork/runtime-host/effective-skills'
import { getActiveManagedPolicy, isManagedPolicyExtensionClassEnabled } from '@open-cowork/runtime-host/managed-policy'
import type {
  RuntimeCapabilityConflictRecord,
  RuntimeCapabilityProvenanceRecord,
  RuntimeCapabilityStatus,
  RuntimeCompatibilityReport,
  RuntimeInputDiagnostics,
} from '@open-cowork/shared'
import { getAppConfig, getConfiguredMcpsFromConfig, getConfiguredSkillsFromConfig, getPublicAppConfig, getProviderDescriptor, resolveCustomProviderConfig } from './config-loader.ts'
import { getOpencodeCompatibilityReport } from './opencode-compatibility.ts'
function isSensitiveOptionKey(key: string) {
  return /(token|secret|password|authorization|headers?|cookie|api[-_]?key|private[-_]?key)/i.test(key)
}

function sanitizeProviderOptions(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => {
      if (isSensitiveOptionKey(key)) return []
      if (Array.isArray(entry)) {
        return [[key, entry]]
      }
      if (entry && typeof entry === 'object') {
        const nested = sanitizeProviderOptions(entry)
        return Object.keys(nested).length > 0 ? [[key, nested]] : []
      }
      return [[key, entry]]
    }),
  )
}

function getProviderSource(selectedProviderId: string | null, effectiveProviderId: string | null, defaultProviderId: string | null): RuntimeInputDiagnostics['providerSource'] {
  if (selectedProviderId && selectedProviderId === effectiveProviderId) return 'settings'
  if (!selectedProviderId && effectiveProviderId === defaultProviderId) return 'default'
  return 'fallback'
}

function getModelSource(selectedModelId: string | null, effectiveModelId: string | null, defaultModelId: string | null): RuntimeInputDiagnostics['modelSource'] {
  if (selectedModelId && selectedModelId === effectiveModelId) return 'settings'
  if (!selectedModelId && effectiveModelId === defaultModelId) return 'default'
  return 'fallback'
}

function mcpSkipStatus(reason: string): RuntimeCapabilityStatus {
  if (reason === 'disabled-by-user') return 'disabled'
  if (reason === 'not-signed-in-google' || reason === 'awaiting-oauth-opt-in') return 'auth-pending'
  return 'missing'
}

function buildBuiltInMcpCapabilityRecords(settings: ReturnType<typeof getEffectiveSettings>): RuntimeCapabilityProvenanceRecord[] {
  return getConfiguredMcpsFromConfig().map((mcp): RuntimeCapabilityProvenanceRecord => {
    const resolution = evaluateBuiltInMcp(mcp, settings)
    const configuredCredentialKeys = Object.entries(settings.integrationCredentials?.[mcp.name] || {})
      .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
      .map(([key]) => key)
      .sort()
    const credentialKeys = (mcp.credentials || []).map((credential) => credential.key).sort()

    if (resolution.status === 'ready') {
      return {
        id: mcp.name,
        kind: 'mcp',
        status: 'active',
        reasonCode: 'mcp.configured',
        source: 'builtin',
        productMode: 'desktop-local',
        evidence: {
          type: mcp.type,
          authMode: mcp.authMode,
          credentialKeys,
          configuredCredentialKeys,
        },
        redacted: true,
      }
    }

    if (resolution.status === 'skipped') {
      return {
        id: mcp.name,
        kind: 'mcp',
        status: mcpSkipStatus(resolution.reason),
        reasonCode: `mcp.${resolution.reason}`,
        source: 'builtin',
        productMode: 'desktop-local',
        evidence: {
          type: mcp.type,
          authMode: mcp.authMode,
          credentialKeys,
          configuredCredentialKeys,
        },
        redacted: true,
      }
    }

    return {
      id: mcp.name,
      kind: 'mcp',
      status: 'blocked',
      reasonCode: 'mcp.invalid',
      source: 'builtin',
      productMode: 'desktop-local',
      evidence: {
        type: mcp.type,
        authMode: mcp.authMode,
      },
      redacted: true,
    }
  })
}

function buildCompatibilityCapabilityRecords(compatibility: RuntimeCompatibilityReport): RuntimeCapabilityProvenanceRecord[] {
  return compatibility.assumptions
    .filter((assumption) => assumption.category === 'plugin')
    .map((assumption): RuntimeCapabilityProvenanceRecord => ({
      id: assumption.id,
      kind: 'opencode-plugin',
      status: assumption.status === 'blocked' ? 'unsupported' : 'available',
      reasonCode: assumption.status === 'blocked'
        ? 'plugin.product-mode-unsupported'
        : `plugin.${assumption.status}`,
      source: 'opencode-compatibility-registry',
      productMode: assumption.productModes?.join(',') || 'desktop-local',
      evidence: {
        owner: assumption.owner,
        sourceVersion: assumption.sourceVersion,
        tests: assumption.tests,
      },
      redacted: true,
    }))
}

function buildCustomMcpCapabilityRecords(): RuntimeCapabilityProvenanceRecord[] {
  return listCustomMcps().map((mcp): RuntimeCapabilityProvenanceRecord => {
    if (mcp.type === 'stdio') {
      try {
        validateCustomMcpStdioCommand(mcp)
      } catch {
        return {
          id: mcp.name,
          kind: 'mcp',
          status: 'blocked',
          reasonCode: 'mcp.stdio-policy-blocked',
          source: 'custom',
          productMode: 'desktop-local',
          evidence: {
            type: mcp.type,
            scope: mcp.scope,
            permissionMode: mcp.permissionMode || 'ask',
          },
          redacted: true,
        }
      }
      return {
        id: mcp.name,
        kind: 'mcp',
        status: 'active',
        reasonCode: 'mcp.custom-stdio-configured',
        source: 'custom',
        productMode: 'desktop-local',
        evidence: {
          type: mcp.type,
          scope: mcp.scope,
          permissionMode: mcp.permissionMode || 'ask',
        },
        redacted: true,
      }
    }

    const verdict = evaluateHttpMcpUrl(mcp.url || '', {
      allowPrivateNetwork: mcp.allowPrivateNetwork,
    })
    if (!verdict.ok) {
      return {
        id: mcp.name,
        kind: 'mcp',
        status: 'blocked',
        reasonCode: 'mcp.url-policy-blocked',
        source: 'custom',
        productMode: 'desktop-local',
        evidence: {
          type: mcp.type,
          scope: mcp.scope,
          permissionMode: mcp.permissionMode || 'ask',
        },
        redacted: true,
      }
    }

    return {
      id: mcp.name,
      kind: 'mcp',
      status: 'active',
      reasonCode: 'mcp.custom-http-configured',
      source: 'custom',
      productMode: 'desktop-local',
      evidence: {
        type: mcp.type,
        scope: mcp.scope,
        permissionMode: mcp.permissionMode || 'ask',
        host: verdict.url.hostname,
      },
      redacted: true,
    }
  })
}

function buildSkillCapabilityRecords(): RuntimeCapabilityProvenanceRecord[] {
  const allowCustomSkills = isManagedPolicyExtensionClassEnabled(getActiveManagedPolicy(), 'customSkills')
  const activeSkills = listEffectiveSkillsSync({ includeCustomSkills: allowCustomSkills })
  const activeNames = new Set(activeSkills.map((skill) => skill.name))
  const active = activeSkills.map((skill): RuntimeCapabilityProvenanceRecord => ({
    id: skill.name,
    kind: 'skill',
    status: 'active',
    reasonCode: `skill.${skill.source}`,
    source: skill.source,
    productMode: 'desktop-local',
    evidence: {
      origin: skill.origin,
      scope: skill.scope || 'runtime',
      toolIds: skill.toolIds || [],
    },
    redacted: true,
  }))
  const missing = getConfiguredSkillsFromConfig()
    .filter((skill) => !activeNames.has(skill.sourceName))
    .map((skill): RuntimeCapabilityProvenanceRecord => ({
      id: skill.sourceName,
      kind: 'skill',
      status: 'missing',
      reasonCode: 'skill.configured-missing',
      source: 'builtin',
      productMode: 'desktop-local',
      evidence: {
        toolIds: skill.toolIds || [],
      },
      redacted: true,
    }))
  const disabledCustom = allowCustomSkills ? [] : listCustomSkills()
    .map((skill): RuntimeCapabilityProvenanceRecord => ({
      id: skill.name,
      kind: 'skill',
      status: 'disabled',
      reasonCode: 'skill.custom-disabled-by-policy',
      source: 'custom',
      productMode: 'desktop-local',
      evidence: {
        scope: skill.scope,
      },
      redacted: true,
    }))
  return [...active, ...missing, ...disabledCustom]
}

function buildCapabilityConflictRecords(input: {
  providerId: string | null
  modelId: string | null
  providerSource: RuntimeInputDiagnostics['providerSource']
  modelSource: RuntimeInputDiagnostics['modelSource']
  defaultProviderId: string | null
  defaultModelId: string | null
}): RuntimeCapabilityConflictRecord[] {
  const conflicts: RuntimeCapabilityConflictRecord[] = []

  if (input.providerId && input.defaultProviderId && input.providerId !== input.defaultProviderId) {
    conflicts.push({
      id: input.providerId,
      kind: 'provider',
      winnerSource: input.providerSource,
      loserSources: [`default:${input.defaultProviderId}`],
      reasonCode: 'provider.source-conflict-winner',
      redacted: true,
    })
  }

  if (input.modelId && input.defaultModelId && input.modelId !== input.defaultModelId) {
    conflicts.push({
      id: input.modelId,
      kind: 'model',
      winnerSource: input.modelSource,
      loserSources: [`default:${input.defaultModelId}`],
      reasonCode: 'model.source-conflict-winner',
      redacted: true,
    })
  }

  const configuredSkillNames = new Set(getConfiguredSkillsFromConfig().map((skill) => skill.sourceName))
  const allowCustomSkills = isManagedPolicyExtensionClassEnabled(getActiveManagedPolicy(), 'customSkills')
  if (!allowCustomSkills) return conflicts
  for (const customSkill of listCustomSkills()) {
    if (!configuredSkillNames.has(customSkill.name)) continue
    conflicts.push({
      id: customSkill.name,
      kind: 'skill',
      winnerSource: `custom:${customSkill.scope}`,
      loserSources: ['builtin:open-cowork'],
      reasonCode: 'skill.custom-overrides-managed',
      redacted: true,
    })
  }

  const builtinMcpNames = new Set(getConfiguredMcpsFromConfig().map((mcp) => mcp.name))
  for (const customMcp of listCustomMcps()) {
    if (!builtinMcpNames.has(customMcp.name)) continue
    conflicts.push({
      id: customMcp.name,
      kind: 'mcp',
      winnerSource: `custom:${customMcp.scope}`,
      loserSources: ['builtin'],
      reasonCode: 'mcp.custom-overrides-builtin',
      redacted: true,
    })
  }

  return conflicts
}

export function getRuntimeInputDiagnostics(): RuntimeInputDiagnostics {
  const publicConfig = getPublicAppConfig()
  const settings = getEffectiveSettings()
  const providerId = settings.effectiveProviderId
  const modelId = settings.effectiveModel
  const providerDescriptor = getProviderDescriptor(providerId)
  const isBuiltinProvider = Boolean(providerId && getAppConfig().providers.descriptors?.[providerId]?.runtime === 'builtin')
  const customProviderConfig = providerId ? resolveCustomProviderConfig(providerId) : null
  // Diagnostics intentionally derive from the same runtime builder path as the
  // actual runtime config so the UI shows what Cowork will really hand to
  // OpenCode, not a parallel interpretation.
  const effectiveProviderConfig = providerId
    ? buildEffectiveProviderRuntimeConfig(providerId, settings, providerId)
    : null
  const providerOptions = sanitizeProviderOptions(effectiveProviderConfig?.options)
  const credentialOverrideKeys = providerId
    ? Object.entries(settings.providerCredentials?.[providerId] || {})
      .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
      .map(([key]) => key)
      .sort()
    : []
  const providerSource = getProviderSource(settings.selectedProviderId, providerId, publicConfig.providers.defaultProvider)
  const modelSource = getModelSource(settings.selectedModelId, modelId, publicConfig.providers.defaultModel)
  const compatibility = getOpencodeCompatibilityReport()

  return {
    opencodeVersion: getBundledOpencodeVersion(),
    providerId,
    providerName: providerDescriptor?.name || null,
    providerPackage: isBuiltinProvider ? null : (customProviderConfig?.npm || null),
    modelId,
    runtimeModel: providerId && modelId ? `${providerId}/${modelId}` : (providerId || null),
    defaultProviderId: publicConfig.providers.defaultProvider,
    defaultModelId: publicConfig.providers.defaultModel,
    providerSource,
    modelSource,
    providerOptions,
    credentialOverrideKeys,
    capabilities: [
      {
        id: providerId || 'provider',
        kind: 'provider',
        status: providerId ? 'active' : 'missing',
        reasonCode: providerId ? `provider.${providerSource}` : 'provider.missing',
        source: providerSource,
        productMode: 'desktop-local',
        evidence: {
          providerName: providerDescriptor?.name || null,
          providerPackage: isBuiltinProvider ? null : (customProviderConfig?.npm || null),
          credentialOverrideKeys,
        },
        redacted: true,
      },
      {
        id: modelId || 'model',
        kind: 'model',
        status: modelId ? 'active' : 'missing',
        reasonCode: modelId ? `model.${modelSource}` : 'model.missing',
        source: modelSource,
        productMode: 'desktop-local',
        evidence: {
          runtimeModel: providerId && modelId ? `${providerId}/${modelId}` : null,
          defaultModelId: publicConfig.providers.defaultModel,
        },
        redacted: true,
      },
      ...buildBuiltInMcpCapabilityRecords(settings),
      ...buildCustomMcpCapabilityRecords(),
      ...buildSkillCapabilityRecords(),
      ...buildCompatibilityCapabilityRecords(compatibility),
      {
        id: 'subagent-delegation',
        kind: 'agent',
        status: 'ask-gated',
        reasonCode: 'agent.delegation-parent-permission-gated',
        source: 'agent-config',
        productMode: 'desktop-local',
        evidence: {
          parentDenyRulesInherited: true,
          delegatedRemoteApproval: 'policy-gated',
        },
        redacted: true,
      },
    ],
    conflicts: buildCapabilityConflictRecords({
      providerId,
      modelId,
      providerSource,
      modelSource,
      defaultProviderId: publicConfig.providers.defaultProvider,
      defaultModelId: publicConfig.providers.defaultModel,
    }),
    compatibility,
  }
}
