import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildChannelConnectorRegistry } from '../channel-connectors.js'
import { clearConfigCacheForTest, getConfig, updateConfig } from '../config.js'
import { clearWorkStateForTest, upsertChannelBinding } from '../work-store.js'

describe('channel connector registry', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-channel-connectors-test-'))

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    clearChannelEnv()
    clearConfigCacheForTest()
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    fs.mkdirSync(testDir, { recursive: true })
    clearWorkStateForTest(path.join(testDir, 'gateway.db'))
  })

  afterEach(() => {
    clearChannelEnv()
    clearConfigCacheForTest()
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
  })

  it('lists stable built-in providers with redacted status payloads', () => {
    const registry = buildChannelConnectorRegistry({ config: getConfig(), generatedAt: '2026-06-17T00:00:00.000Z' })

    expect(registry.connectors.map(row => row.provider)).toEqual(['discord', 'telegram', 'whatsapp'])
    expect(registry.connectors.every(row => row.redacted)).toBe(true)
    expect(registry.connectors.every(row => row.onboardingFlow.redacted)).toBe(true)
    expect(registry.connectors.every(row => row.onboardingFlow.path.join('>') === 'connect>verify>trust>bind>monitor')).toBe(true)
    expect(registry.counts).toMatchObject({
      credentials_needed: expect.any(Number),
      not_configured: expect.any(Number),
      provider_connected: expect.any(Number),
    })
  })

  it('reports WhatsApp missing credentials with safe env and config keys only', () => {
    const whatsapp = buildChannelConnectorRegistry({ config: getConfig() }).connectors.find(c => c.provider === 'whatsapp')!

    expect(whatsapp.state).toBe('credentials_needed')
    expect(whatsapp.onboardingFlow).toMatchObject({
      currentStep: 'connect',
      primaryAction: expect.objectContaining({
        label: 'Connect',
        command: 'opencode-gateway channel setup whatsapp',
      }),
    })
    expect(whatsapp.onboardingFlow.steps.find(step => step.id === 'connect')).toMatchObject({
      status: 'blocked',
      blockers: expect.arrayContaining(['missing_credentials']),
    })
    expect(whatsapp.activeSetupPath).toBe('cloud_api_direct')
    expect(whatsapp.setupPaths).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'cloud_api_direct', implementationStatus: 'implemented', active: true, configured: false }),
    ]))
    expect(whatsapp.missingPrerequisites).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'whatsapp_access_token', env: 'WHATSAPP_ACCESS_TOKEN', configKey: 'channels.whatsapp.accessToken', secret: true }),
      expect.objectContaining({ key: 'whatsapp_phone_number_id', env: 'WHATSAPP_PHONE_NUMBER_ID', configKey: 'channels.whatsapp.phoneNumberId', secret: false }),
      expect.objectContaining({ key: 'whatsapp_verify_token', env: 'WHATSAPP_VERIFY_TOKEN', configKey: 'channels.whatsapp.verifyToken', secret: true }),
      expect.objectContaining({ key: 'whatsapp_app_secret', env: 'WHATSAPP_APP_SECRET', configKey: 'channels.whatsapp.appSecret', secret: true }),
    ]))
    expect(JSON.stringify(whatsapp)).not.toMatch(/EA[A-Za-z0-9]{10,}|phone-secret|verify-secret/)
  })

  it('separates WhatsApp webhook callback and signature readiness from trust readiness', () => {
    updateConfig({
      security: { publicWebhookMode: true, channelAllowlists: { whatsapp: [] } },
      channels: {
        whatsapp: {
          accessToken: 'whatsapp-access-secret',
          phoneNumberId: 'phone-secret-id',
          verifyToken: 'verify-secret-token',
          appSecret: 'app-secret-value',
        },
      },
    } as any)

    const trustedPending = buildChannelConnectorRegistry({ config: getConfig() }).connectors.find(c => c.provider === 'whatsapp')!
    expect(trustedPending.state).toBe('trusted_target_pending')
    expect(trustedPending.callback).toMatchObject({
      required: true,
      routeExposure: 'public_webhook_mode',
      challenge: 'ready',
      signature: 'ready',
      verifier: {
        state: 'warning',
        publicWebhookRoutesOnly: true,
        nonWebhookRoutesProtected: true,
        httpAuthConfigured: false,
      },
    })
    expect(trustedPending.callback.verifier.issues.map(issue => issue.code)).toContain('no_http_capability_tokens')
    expect(JSON.stringify(trustedPending)).not.toContain('whatsapp-access-secret')
    expect(JSON.stringify(trustedPending)).not.toContain('phone-secret-id')

    updateConfig({
      security: { publicWebhookMode: false },
      channels: {
        whatsapp: {
          accessToken: 'whatsapp-access-secret',
          phoneNumberId: 'phone-secret-id',
          verifyToken: 'verify-secret-token',
          appSecret: '',
        },
      },
    } as any)

    const webhookPending = buildChannelConnectorRegistry({ config: getConfig() }).connectors.find(c => c.provider === 'whatsapp')!
    expect(webhookPending.state).toBe('webhook_needed')
    expect(webhookPending.callback).toMatchObject({
      routeExposure: 'local_only',
      challenge: 'ready',
      signature: 'missing',
    })
    expect(webhookPending.diagnostics.map(row => row.code)).toEqual(expect.arrayContaining(['callback_url_missing', 'signature_verification_missing']))
  })

  it('reports Telegram ready once trusted and bound without leaking token values', () => {
    const unconfigured = buildChannelConnectorRegistry({ config: getConfig() }).connectors.find(c => c.provider === 'telegram')!
    expect(unconfigured.state).toBe('credentials_needed')

    updateConfig({
      channels: { telegram: { botToken: '123456:telegram-secret-token-value' } },
      security: { channelAllowlists: { telegram: [{ chatId: 'private-chat-id' }] } },
    } as any)
    upsertChannelBinding({ provider: 'telegram', chatId: 'private-chat-id', sessionId: 'ses_private' })

    const configured = buildChannelConnectorRegistry({ config: getConfig() }).connectors.find(c => c.provider === 'telegram')!
    expect(configured.state).toBe('ready')
    expect(configured.trusted).toBe(true)
    expect(configured.bindingCount).toBe(1)
    expect(configured.onboardingFlow.currentStep).toBe('monitor')
    expect(JSON.stringify(configured)).not.toContain('telegram-secret-token-value')
    expect(JSON.stringify(configured)).not.toContain('private-chat-id')
  })

  it('reports Telegram trusted-target pending until a binding exists', () => {
    updateConfig({
      channels: { telegram: { botToken: '123456:telegram-secret-token-value' } },
      security: { channelAllowlists: { telegram: [{ chatId: 'private-chat-id' }] } },
    } as any)

    const configured = buildChannelConnectorRegistry({ config: getConfig() }).connectors.find(c => c.provider === 'telegram')!
    expect(configured.state).toBe('trusted_target_pending')
    expect(configured.trusted).toBe(true)
    expect(configured.bindingCount).toBe(0)
    expect(configured.missingPrerequisites.map(row => row.code)).toContain('binding_missing')
  })

  it('reports Discord disabled separately from missing provider credentials', () => {
    const discord = buildChannelConnectorRegistry({ config: getConfig() }).connectors.find(c => c.provider === 'discord')!

    expect(discord.state).toBe('not_configured')
    expect(discord.enabled).toBe(false)
    expect(discord.onboardingFlow).toMatchObject({
      currentStep: 'connect',
      primaryAction: expect.objectContaining({ command: 'opencode-gateway channel setup discord' }),
    })
    expect(discord.onboardingFlow.steps.find(step => step.id === 'connect')?.blockers).toContain('provider_disabled')
    expect(discord.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'provider_disabled' }),
    ]))
  })
})

function clearChannelEnv(): void {
  delete process.env['TELEGRAM_BOT_TOKEN']
  delete process.env['WHATSAPP_ACCESS_TOKEN']
  delete process.env['WHATSAPP_PHONE_NUMBER_ID']
  delete process.env['WHATSAPP_VERIFY_TOKEN']
  delete process.env['WHATSAPP_APP_SECRET']
  delete process.env['OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED']
  delete process.env['DISCORD_BOT_TOKEN']
  delete process.env['DISCORD_APPLICATION_ID']
  delete process.env['DISCORD_PUBLIC_KEY']
}
