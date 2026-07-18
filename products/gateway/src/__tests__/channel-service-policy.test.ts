import { describe, expect, it } from 'vitest'
import { evaluateChannelServicePolicy, type ChannelServicePolicyInput } from '../channel-service-policy.js'

describe('channel service policy', () => {
  it('reports ready connectors as ok with redacted evidence', () => {
    const result = evaluateChannelServicePolicy({
      provider: 'telegram',
      displayName: 'Telegram',
      configured: true,
      enabled: true,
      trusted: true,
      unsafeAllowAll: false,
      connector: connector({ state: 'ready' }),
    })

    expect(result).toMatchObject({
      status: 'ok',
      summary: 'Telegram adapter is ready.',
      remediation: 'No action required.',
      evidence: {
        connectorState: 'ready',
        missingPrerequisites: [],
        diagnostics: [],
      },
    })
  })

  it('keeps configured channels degraded until they reach the ready state', () => {
    const result = evaluateChannelServicePolicy({
      provider: 'telegram',
      displayName: 'Telegram',
      configured: true,
      enabled: true,
      trusted: true,
      unsafeAllowAll: false,
      connector: connector({
        state: 'trusted_target_pending',
        missingPrerequisites: [{
          kind: 'binding',
          code: 'binding_missing',
          key: 'telegram_binding',
          label: 'Telegram channel binding',
          remediation: 'Run /project bind or /bind session from the trusted target.',
        }],
      }),
    })

    expect(result).toMatchObject({
      status: 'degraded',
      evidence: {
        connectorState: 'trusted_target_pending',
        missingPrerequisites: ['telegram_binding'],
      },
    })
  })

  it('surfaces blocked setup paths from connector diagnostics', () => {
    const result = evaluateChannelServicePolicy({
      provider: 'whatsapp',
      displayName: 'WhatsApp',
      configured: true,
      enabled: true,
      trusted: true,
      unsafeAllowAll: false,
      connector: connector({
        state: 'blocked',
        activeSetupPath: 'embedded_signup_provider',
        diagnostics: [{
          code: 'provider_unavailable',
          state: 'blocked',
          severity: 'blocked',
          summary: 'Embedded Signup provider-managed token exchange is not implemented.',
          remediation: 'Use the direct Cloud API setup path until Embedded Signup exchange is implemented.',
        }],
        missingPrerequisites: [{
          kind: 'provider',
          code: 'provider_unavailable',
          key: 'whatsapp_embedded_signup_provider',
          label: 'Embedded Signup / provider-managed',
          remediation: 'Use the direct Cloud API setup path until Embedded Signup exchange is implemented.',
        }],
      }),
    })

    expect(result).toMatchObject({
      status: 'degraded',
      summary: 'Embedded Signup provider-managed token exchange is not implemented.',
      remediation: expect.stringContaining('direct Cloud API'),
      evidence: {
        activeSetupPath: 'embedded_signup_provider',
        diagnostics: ['provider_unavailable'],
        missingPrerequisites: ['whatsapp_embedded_signup_provider'],
      },
    })
  })

  it('fails closed for unsafe allow-all channel trust', () => {
    const result = evaluateChannelServicePolicy({
      provider: 'discord',
      displayName: 'Discord',
      configured: true,
      enabled: true,
      trusted: true,
      unsafeAllowAll: true,
      connector: connector({ state: 'ready' }),
    })

    expect(result).toMatchObject({
      status: 'degraded',
      summary: 'Unsafe allow-all override is enabled; rotate to explicit allowlists before production use.',
      remediation: expect.stringContaining('explicit channel allowlists'),
      evidence: expect.objectContaining({ unsafeAllowAll: true }),
    })
  })

  it('returns redaction-sensitive evidence without raw target identifiers or secret values', () => {
    const result = evaluateChannelServicePolicy({
      provider: 'discord',
      displayName: 'Discord',
      configured: true,
      enabled: true,
      trusted: false,
      unsafeAllowAll: false,
      connector: connector({
        state: 'trusted_target_pending',
        missingPrerequisites: [{
          kind: 'trust',
          code: 'missing_allowlist',
          key: 'discord_allowlist',
          label: 'Discord trusted target allowlist',
          configKey: 'security.channelAllowlists.discord',
          remediation: 'Run opencode-gateway channel claim discord or add security.channelAllowlists.discord.',
        }],
        diagnostics: [{
          code: 'missing_allowlist',
          state: 'trusted_target_pending',
          severity: 'blocked',
          summary: 'No trusted Discord target is configured.',
          remediation: 'Run opencode-gateway channel claim discord or add security.channelAllowlists.discord.',
        }],
      }),
    })

    expect(result).toMatchObject({
      status: 'degraded',
      summary: expect.stringContaining('no channel allowlist'),
      evidence: {
        configured: true,
        trusted: false,
        missingPrerequisites: ['discord_allowlist'],
        diagnostics: ['missing_allowlist'],
      },
    })
    expect(JSON.stringify(result)).not.toContain('discord-secret-token')
    expect(JSON.stringify(result)).not.toContain('discord-channel-raw-id')
  })
})

type ConnectorInput = NonNullable<ChannelServicePolicyInput['connector']>

function connector(overrides: Partial<ConnectorInput> & {
  state?: ConnectorInput['state']
} = {}): ConnectorInput {
  const state = overrides.state || 'ready'
  return {
    state,
    stateSummary: `${state} state`,
    activeSetupPath: overrides.activeSetupPath,
    setupPaths: overrides.setupPaths || [
      {
        key: 'direct',
        label: 'Direct',
        modes: ['webhook'],
        implementationStatus: 'implemented',
        active: true,
        configured: true,
        available: true,
        state,
        summary: 'Direct setup path.',
        nextActions: [],
        prerequisites: [],
        env: [],
        configKeys: [],
        docs: [],
        diagnostics: [],
      },
    ],
    missingPrerequisites: overrides.missingPrerequisites || [],
    diagnostics: overrides.diagnostics || [],
    nextActions: overrides.nextActions || [],
  }
}
