import type { ChannelConnectorStatus } from './channel-connectors.js'

export type ChannelServicePolicyStatus = 'ok' | 'degraded' | 'down'

export interface ChannelServicePolicyInput {
  provider: 'telegram' | 'whatsapp' | 'discord'
  displayName: string
  configured: boolean
  enabled: boolean
  trusted: boolean
  unsafeAllowAll: boolean
  connector?: Pick<ChannelConnectorStatus,
    | 'state'
    | 'stateSummary'
    | 'missingPrerequisites'
    | 'diagnostics'
    | 'nextActions'
    | 'activeSetupPath'
    | 'setupPaths'
  >
}

export interface ChannelServicePolicyResult {
  status: ChannelServicePolicyStatus
  summary: string
  remediation: string
  evidence: {
    configured: boolean
    enabled: boolean
    trusted: boolean
    unsafeAllowAll: boolean
    connectorState?: string
    activeSetupPath?: string
    setupPaths: Array<{ key: string; status: string; active: boolean; configured: boolean; state: string }>
    missingPrerequisites: string[]
    diagnostics: string[]
    nextActions: string[]
  }
}

export function evaluateChannelServicePolicy(input: ChannelServicePolicyInput): ChannelServicePolicyResult {
  const evidence = {
    configured: input.configured,
    enabled: input.enabled,
    trusted: input.trusted,
    unsafeAllowAll: input.unsafeAllowAll,
    connectorState: input.connector?.state,
    activeSetupPath: input.connector?.activeSetupPath,
    setupPaths: input.connector?.setupPaths.map(path => ({
      key: path.key,
      status: path.implementationStatus,
      active: path.active,
      configured: path.configured,
      state: path.state,
    })) || [],
    missingPrerequisites: input.connector?.missingPrerequisites.map(row => row.key) || [],
    diagnostics: input.connector?.diagnostics.map(row => row.code) || [],
    nextActions: input.connector?.nextActions || [],
  }
  const degraded = (summary: string, remediation = fallbackRemediation(input.provider, summary, input.connector)): ChannelServicePolicyResult => ({
    status: 'degraded',
    summary,
    remediation,
    evidence,
  })

  if (!input.configured) return degraded(`${input.provider} credentials are not configured; adapter disabled.`)
  if (input.unsafeAllowAll) return degraded('Unsafe allow-all override is enabled; rotate to explicit allowlists before production use.')
  if (input.connector?.state === 'blocked') {
    const summary = firstDiagnostic(input.connector)?.summary || `${input.displayName} connector setup is blocked.`
    return degraded(summary, firstRemediation(input.connector) || fallbackRemediation(input.provider, summary, input.connector))
  }

  const missing = firstMissing(input.connector)
  const missingAllowlist = findMissing(input.connector, 'missing_allowlist')
  if (missing?.code === 'missing_allowlist') {
    return degraded(
      input.provider === 'discord'
        ? 'Discord alpha is configured, but no channel allowlist is configured; inbound targets fail closed.'
        : 'Credentials are present, but no channel allowlist is configured; inbound targets fail closed.',
      missing.remediation,
    )
  }
  if (!input.trusted) {
    return degraded(
      input.provider === 'discord'
        ? 'Discord alpha is configured, but no channel allowlist is configured; inbound targets fail closed.'
        : 'Credentials are present, but no channel allowlist is configured; inbound targets fail closed.',
      missingAllowlist?.remediation || fallbackRemediation(input.provider, 'no channel allowlist configured', input.connector),
    )
  }

  if (!input.enabled) {
    const summary = disabledSummary(input)
    return degraded(summary, firstRemediation(input.connector) || fallbackRemediation(input.provider, summary, input.connector))
  }
  if (!input.connector) return degraded(`${input.displayName} lifecycle state is unavailable.`)

  if (input.connector.state !== 'ready') {
    const summary = connectorStateSummary(input)
    return degraded(summary, firstRemediation(input.connector) || fallbackRemediation(input.provider, summary, input.connector))
  }

  return {
    status: 'ok',
    summary: `${input.displayName} adapter is ready.`,
    remediation: 'No action required.',
    evidence,
  }
}

function connectorStateSummary(input: ChannelServicePolicyInput): string {
  const diagnostic = firstDiagnostic(input.connector)
  if (diagnostic?.summary) return diagnostic.summary
  if (input.connector?.state === 'trusted_target_pending') return `${input.displayName} is configured, but trusted target binding is incomplete.`
  return `${input.displayName} lifecycle state is ${input.connector?.state || 'unknown'}: ${input.connector?.stateSummary || 'no connector state summary available'}.`
}

function disabledSummary(input: ChannelServicePolicyInput): string {
  const missing = firstMissing(input.connector)
  if (input.provider === 'discord') {
    if (missing?.key === 'discord_bot_token') return 'Discord alpha is enabled, but botToken is missing; outbound notifications stay disabled.'
    if (missing?.key === 'discord_public_key') return 'Discord alpha is enabled, but publicKey is missing; signed interaction webhooks are rejected.'
    return 'Discord alpha is configured but disabled; set channels.discord.enabled=true or OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED=true.'
  }
  return firstDiagnostic(input.connector)?.summary || `${input.displayName} adapter is disabled.`
}

function fallbackRemediation(provider: string, summary: string, connector?: ChannelServicePolicyInput['connector']): string {
  const remediation = firstRemediation(connector)
  if (/credentials are not configured/i.test(summary)) return `Set ${provider} credentials in Gateway config or environment, then restart Gateway.`
  if (/Unsafe allow-all/i.test(summary)) return 'Replace unsafe allow-all with explicit channel allowlists before production use.'
  if (/allowlist/i.test(summary)) return `Add trusted ${provider} chat/thread targets to security.channelAllowlists.`
  if (remediation) return remediation
  if (/disabled/i.test(summary) && provider === 'discord') return 'Set channels.discord.enabled=true or OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED=true only for controlled alpha workspaces.'
  return 'Check channel credentials, allowlists, and recent Gateway logs.'
}

function firstMissing(connector?: ChannelServicePolicyInput['connector']) {
  return connector?.missingPrerequisites[0]
}

function findMissing(connector: ChannelServicePolicyInput['connector'] | undefined, code: string) {
  return connector?.missingPrerequisites.find(row => row.code === code)
}

function firstDiagnostic(connector?: ChannelServicePolicyInput['connector']) {
  return connector?.diagnostics[0]
}

function firstRemediation(connector?: ChannelServicePolicyInput['connector']): string | undefined {
  return connector?.missingPrerequisites[0]?.remediation || connector?.diagnostics[0]?.remediation
}
