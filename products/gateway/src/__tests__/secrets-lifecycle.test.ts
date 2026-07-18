import { describe, expect, it } from 'vitest'
import type { GatewayConfig } from '../config.js'
import {
  SECRET_INPUT_INVENTORY,
  buildSecretsLifecycleReport,
  buildSecretReferences,
  configuredSecretInputs,
  createLocalSecretVaultAdapter,
  formatSecretsLifecycleReport,
} from '../secrets-lifecycle.js'

describe('secrets lifecycle', () => {
  it('inventories current Gateway, channel, OpenCode, MCP, and future worker credential classes', () => {
    expect(SECRET_INPUT_INVENTORY.map(input => input.id)).toEqual(expect.arrayContaining([
      'gateway_http_admin_token',
      'telegram_bot_token',
      'whatsapp_access_token',
      'whatsapp_phone_number_id',
      'whatsapp_verify_token',
      'whatsapp_app_secret',
      'discord_bot_token',
      'discord_public_key',
      'model_provider_api_keys',
      'mcp_connector_credentials',
      'future_worker_secret_bundle',
    ]))
    expect(SECRET_INPUT_INVENTORY.find(input => input.id === 'model_provider_api_keys')).toMatchObject({
      owner: 'opencode',
      currentStorageModes: expect.arrayContaining(['opencode_config', 'not_gateway_managed']),
    })
    expect(SECRET_INPUT_INVENTORY.find(input => input.id === 'future_worker_secret_bundle')).toMatchObject({
      currentStorageModes: ['future_vault'],
      futureVaultScope: 'worker/lease/scoped_secret_bundle',
    })
    expect(SECRET_INPUT_INVENTORY.find(input => input.id === 'telegram_bot_token')).toMatchObject({ exactMatchRedaction: true })
    expect(SECRET_INPUT_INVENTORY.find(input => input.id === 'discord_alpha_enabled')).toMatchObject({ exactMatchRedaction: false })
    expect(SECRET_INPUT_INVENTORY.find(input => input.id === 'discord_public_key')).toMatchObject({ exactMatchRedaction: true })
  })

  it('reports configured references without exposing secret values', () => {
    const config = {
      ...baseConfig(),
      channels: {
        ...baseConfig().channels,
        telegram: { ...baseConfig().channels.telegram, botToken: 'fixture-telegram-value' },
      },
    }
    const report = buildSecretsLifecycleReport(config, { OPENCODE_GATEWAY_HTTP_READ_TOKEN: 'fixture-read-value' } as any)

    expect(report).toMatchObject({
      mode: 'local_operator_managed',
      releaseStatus: 'supported_public_local_beta',
      vaultStatus: 'local_reference_adapter_preview',
      hostedTeamStatus: 'unsupported_until_m25_decision',
      rawSecretPolicy: 'never_in_durable_work_or_evidence',
    })
    expect(report.configuredInputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'gateway_http_read_token', configuredVia: ['environment'], env: ['OPENCODE_GATEWAY_HTTP_READ_TOKEN'], referenceIds: [expect.stringMatching(/^secretref_gateway_http_read_token_/)] }),
      expect.objectContaining({ id: 'telegram_bot_token', configuredVia: ['local_config'], configKeys: ['channels.telegram.botToken'], referenceIds: [expect.stringMatching(/^secretref_telegram_bot_token_/)] }),
    ]))
    expect(report.secretReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({
        inputId: 'telegram_bot_token',
        source: 'local_config',
        scope: expect.objectContaining({ kind: 'channel', path: 'project/channel/telegram/bot_token', projectScoped: true }),
        rotation: expect.objectContaining({ posture: 'operator_managed' }),
        redaction: expect.objectContaining({ valueExposed: false, exactMatch: true }),
      }),
    ]))
    expect(report.scopedInjection).toMatchObject({
      implemented: true,
      defaultPolicy: 'deny_unknown_or_overbroad_requests',
      rawValuePolicy: 'in_memory_only',
      providerScopeEnforced: true,
      revokedReferencesDenied: true,
      staleRotationDenied: true,
    })
    expect(report).toMatchObject({
      teamPreviewStatus: 'bounded_scoped_injection_preview',
      operatorPosture: {
        mode: 'local_and_team_preview_secret_lifecycle',
        redacted: true,
        injectionGuardrails: expect.objectContaining({
          providerScopeEnforced: true,
          projectScopeRequired: true,
          workerLeaseRequired: true,
        }),
      },
    })
    expect(report.operatorPosture.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        inputId: 'telegram_bot_token',
        capability: 'channel:telegram',
        rotation: expect.objectContaining({ health: 'due' }),
        revocation: expect.objectContaining({ state: 'active' }),
        injection: expect.objectContaining({ destination: 'telegram_adapter' }),
      }),
    ]))
    expect(JSON.stringify(report)).not.toContain('fixture-read-value')
    expect(JSON.stringify(report)).not.toContain('fixture-telegram-value')
  })

  it('resolves configured local references only through the local vault adapter', () => {
    const config = baseConfig()
    const env = { TELEGRAM_BOT_TOKEN: 'fixture-telegram-value' } as any
    const references = buildSecretReferences(config, env)
    const telegram = references.find(reference => reference.inputId === 'telegram_bot_token')
    expect(telegram).toMatchObject({
      source: 'environment',
      envName: 'TELEGRAM_BOT_TOKEN',
      injection: expect.objectContaining({ allowedContextKinds: expect.arrayContaining(['channel', 'connector', 'subprocess']) }),
    })

    const vault = createLocalSecretVaultAdapter(config, env)
    const resolved = vault.resolve(telegram!.id)

    expect(resolved).toMatchObject({ ok: true, referenceId: telegram!.id })
    expect(resolved.value).toBe('fixture-telegram-value')
    expect(JSON.stringify(vault.listReferences())).not.toContain('fixture-telegram-value')
  })

  it('injects scoped local secrets only with exact references, context, and env allowlist', () => {
    const config = baseConfig()
    const env = { TELEGRAM_BOT_TOKEN: 'fixture-telegram-value', OPENCODE_GATEWAY_HTTP_READ_TOKEN: 'fixture-read-value' } as any
    const vault = createLocalSecretVaultAdapter(config, env)
    const telegram = vault.listReferences().find(reference => reference.inputId === 'telegram_bot_token')!

    const result = vault.injectScopedSecrets({
      context: { kind: 'channel', provider: 'telegram', projectId: 'project_local' },
      referenceIds: [telegram.id],
      allowEnv: ['TELEGRAM_BOT_TOKEN'],
      baseEnv: { SAFE: '1' },
    })

    expect(result).toMatchObject({
      allowed: true,
      env: { SAFE: '1', TELEGRAM_BOT_TOKEN: 'fixture-telegram-value' },
      injected: [expect.objectContaining({ referenceId: telegram.id, inputId: 'telegram_bot_token', envName: 'TELEGRAM_BOT_TOKEN' })],
      denied: [],
    })
  })

  it('denies unknown, over-broad, context-mismatched, and wrong-env scoped injection requests', () => {
    const vault = createLocalSecretVaultAdapter(baseConfig(), {
      TELEGRAM_BOT_TOKEN: 'fixture-telegram-value',
      OPENCODE_GATEWAY_HTTP_READ_TOKEN: 'fixture-read-value',
    } as any)
    const telegram = vault.listReferences().find(reference => reference.inputId === 'telegram_bot_token')!
    const http = vault.listReferences().find(reference => reference.inputId === 'gateway_http_read_token')!

    expect(vault.injectScopedSecrets({
      context: { kind: 'channel', provider: 'telegram' },
      referenceIds: [telegram.id],
      allowEnv: ['*'],
    })).toMatchObject({ allowed: false, denied: expect.arrayContaining([expect.objectContaining({ code: 'overbroad_allowlist' })]) })
    expect(vault.injectScopedSecrets({
      context: { kind: 'channel', provider: 'telegram' },
      referenceIds: ['secretref_unknown_reference_0000000000000000' as any],
      allowEnv: ['TELEGRAM_BOT_TOKEN'],
    })).toMatchObject({ allowed: false, denied: expect.arrayContaining([expect.objectContaining({ code: 'unknown_reference' })]) })
    expect(vault.injectScopedSecrets({
      context: { kind: 'worker', workerId: 'worker_1' },
      referenceIds: [telegram.id],
      allowEnv: ['TELEGRAM_BOT_TOKEN'],
    })).toMatchObject({ allowed: false, denied: expect.arrayContaining([expect.objectContaining({ code: 'context_not_allowed' })]) })
    expect(vault.injectScopedSecrets({
      context: { kind: 'channel', provider: 'telegram', projectId: 'project_local' },
      referenceIds: [telegram.id],
      allowEnv: ['OPENCODE_GATEWAY_HTTP_READ_TOKEN'],
    })).toMatchObject({ allowed: false, denied: expect.arrayContaining([
      expect.objectContaining({ code: 'unknown_allowlisted_env' }),
      expect.objectContaining({ code: 'env_not_allowlisted' }),
    ]) })
    expect(vault.injectScopedSecrets({
      context: { kind: 'channel', provider: 'telegram' },
      referenceIds: [http.id],
      allowEnv: ['OPENCODE_GATEWAY_HTTP_READ_TOKEN'],
    })).toMatchObject({ allowed: false, denied: expect.arrayContaining([expect.objectContaining({ code: 'context_not_allowed' })]) })
  })

  it('denies provider mismatches, revoked references, stale rotation, and missing project scope before resolving values', () => {
    const env = {
      TELEGRAM_BOT_TOKEN: 'fixture-telegram-value',
      WHATSAPP_ACCESS_TOKEN: 'fixture-whatsapp-value',
    } as any
    const initialVault = createLocalSecretVaultAdapter(baseConfig(), env)
    const telegram = initialVault.listReferences().find(reference => reference.inputId === 'telegram_bot_token')!
    const whatsapp = initialVault.listReferences().find(reference => reference.inputId === 'whatsapp_access_token')!
    const config = {
      ...baseConfig(),
      secretLifecycle: {
        revokedReferenceIds: [telegram.id],
        rotationHealthByReferenceId: { [whatsapp.id]: 'overdue' },
      },
    } as GatewayConfig
    const vault = createLocalSecretVaultAdapter(config, env)
    const revokedTelegram = vault.listReferences().find(reference => reference.inputId === 'telegram_bot_token')!
    const overdueWhatsApp = vault.listReferences().find(reference => reference.inputId === 'whatsapp_access_token')!

    expect(vault.injectScopedSecrets({
      context: { kind: 'channel', provider: 'whatsapp', projectId: 'project_local' },
      referenceIds: [revokedTelegram.id],
      allowEnv: ['TELEGRAM_BOT_TOKEN'],
    })).toMatchObject({ allowed: false, denied: [expect.objectContaining({ code: 'reference_revoked' })] })
    expect(vault.injectScopedSecrets({
      context: { kind: 'channel', provider: 'whatsapp', projectId: 'project_local' },
      referenceIds: [overdueWhatsApp.id],
      allowEnv: ['WHATSAPP_ACCESS_TOKEN'],
    })).toMatchObject({ allowed: false, denied: [expect.objectContaining({ code: 'rotation_stale' })] })
    expect(createLocalSecretVaultAdapter(baseConfig(), env).injectScopedSecrets({
      context: { kind: 'channel', provider: 'whatsapp', projectId: 'project_local' },
      referenceIds: [telegram.id],
      allowEnv: ['TELEGRAM_BOT_TOKEN'],
    })).toMatchObject({ allowed: false, denied: [expect.objectContaining({ code: 'provider_scope_mismatch' })] })
    expect(createLocalSecretVaultAdapter(baseConfig(), env).injectScopedSecrets({
      context: { kind: 'channel', provider: 'telegram' },
      referenceIds: [telegram.id],
      allowEnv: ['TELEGRAM_BOT_TOKEN'],
    })).toMatchObject({ allowed: false, denied: [expect.objectContaining({ code: 'project_scope_required' })] })
  })

  it('formats a value-free operator lifecycle view with rotation and revocation posture', () => {
    const config = {
      ...baseConfig(),
      secretLifecycle: { rotationHealthByInputId: { telegram_bot_token: 'overdue' } },
    } as GatewayConfig
    const report = buildSecretsLifecycleReport(config, { TELEGRAM_BOT_TOKEN: 'fixture-telegram-value' } as any)
    const text = formatSecretsLifecycleReport(report)

    expect(text).toContain('Team preview: bounded_scoped_injection_preview')
    expect(text).toContain('Rotation health:')
    expect(text).toContain('rotation=overdue')
    expect(text).toContain('provider scope')
    expect(text).not.toContain('fixture-telegram-value')
    expect(text).not.toContain('123456:')
  })

  it('flags local config secret storage and missing WhatsApp signing secret without leaking values', () => {
    const config = {
      ...baseConfig(),
      channels: {
        ...baseConfig().channels,
        whatsapp: {
          ...baseConfig().channels.whatsapp,
          accessToken: 'fixture-whatsapp-value',
          verifyToken: 'whatsapp-verify-secret',
        },
      },
    }
    const report = buildSecretsLifecycleReport(config, {})

    expect(report.risks).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'local_config_secret_storage', inputId: 'whatsapp_access_token', severity: 'warning' }),
      expect.objectContaining({ code: 'local_config_secret_storage', inputId: 'whatsapp_verify_token', severity: 'warning' }),
      expect.objectContaining({ code: 'whatsapp_signature_secret_missing', inputId: 'whatsapp_app_secret', severity: 'critical' }),
    ]))
    expect(JSON.stringify(report)).not.toContain('fixture-whatsapp-value')
    expect(JSON.stringify(report)).not.toContain('whatsapp-verify-secret')
  })

  it('does not treat disabled boolean flags or false-like env flags as configured secrets', () => {
    const config = baseConfig()
    const inputs = configuredSecretInputs(config, { OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED: 'false' } as any)
    const report = buildSecretsLifecycleReport(config, { OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED: 'false' } as any)

    expect(inputs.find(input => input.id === 'discord_alpha_enabled')).toBeUndefined()
    expect(report.configuredInputs.find(input => input.id === 'discord_alpha_enabled')).toBeUndefined()
    expect(report.risks).toEqual([])
  })
})

function baseConfig(): GatewayConfig {
  return {
    channels: {
      richMessages: { enabled: true },
      telegram: { richMessages: { enabled: true } },
      whatsapp: {},
      discord: { enabled: false, richMessages: { enabled: true } },
    },
  } as GatewayConfig
}
