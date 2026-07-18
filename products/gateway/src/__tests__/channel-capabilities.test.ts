import { describe, expect, it } from 'vitest'
import {
  CHANNEL_ADAPTER_CAPABILITY_KEYS,
  CHANNEL_CONNECTOR_STATE_DEFINITIONS,
  CHANNEL_ONBOARDING_ACTIONS,
  actionDeliveryForCapabilities,
  getChannelCapabilities,
  listChannelCapabilities,
  supportsChannelCapability,
  telegramAdapterCapabilities,
  type ChannelConnectorState,
} from '../channels/capabilities.js'
import { telegramChannel } from '../channels/telegram.js'
import { whatsappChannel } from '../channels/whatsapp.js'

describe('channel capability matrix', () => {
  it('loads explicit capability declarations for current and planned surfaces', () => {
    const providers = listChannelCapabilities().map(capability => capability.provider)

    expect(providers).toEqual(expect.arrayContaining(['telegram', 'whatsapp', 'discord']))
    for (const provider of providers) {
      const capabilities = getChannelCapabilities(provider)
      expect(capabilities?.displayName).toBeTruthy()
      expect(Object.keys(capabilities?.categories || {}).sort()).toEqual([...CHANNEL_ADAPTER_CAPABILITY_KEYS].sort())
      expect(capabilities?.fallback.semantics.length).toBeGreaterThan(0)
      expect(capabilities?.onboarding.states.length).toBeGreaterThan(0)
      expect(capabilities?.onboarding.actions.length).toBeGreaterThan(0)
      expect(capabilities?.onboarding.diagnostics.length).toBeGreaterThan(0)
    }
  })

  it('documents the universal connector states and setup actions', () => {
    expect(Object.keys(CHANNEL_CONNECTOR_STATE_DEFINITIONS)).toEqual([
      'not_configured',
      'credentials_needed',
      'provider_connected',
      'webhook_needed',
      'polling_ready',
      'verification_pending',
      'trusted_target_pending',
      'bound',
      'ready',
      'degraded',
      'blocked',
    ])
    expect(CHANNEL_ONBOARDING_ACTIONS).toEqual(['connect', 'verify', 'trust', 'bind', 'repair', 'disconnect'])
    for (const state of Object.keys(CHANNEL_CONNECTOR_STATE_DEFINITIONS) as ChannelConnectorState[]) {
      expect(CHANNEL_CONNECTOR_STATE_DEFINITIONS[state].summary).toBeTruthy()
      expect(CHANNEL_CONNECTOR_STATE_DEFINITIONS[state].nextActions.length).toBeGreaterThan(0)
    }
  })

  it('maps current providers to setup modes without provider-specific product branches', () => {
    expect(getChannelCapabilities('telegram')?.onboarding.modes).toEqual(['polling'])
    expect(getChannelCapabilities('telegram')?.onboarding.states).toContain('polling_ready')
    expect(getChannelCapabilities('telegram')?.onboarding.webhook).toBeUndefined()

    const whatsapp = getChannelCapabilities('whatsapp')!
    expect(whatsapp.onboarding.modes).toEqual(['webhook', 'embeddedSignup', 'providerManaged'])
    expect(whatsapp.onboarding.webhook?.routes.map(route => `${route.method} ${route.path}`)).toEqual(['GET /webhooks/whatsapp', 'POST /webhooks/whatsapp'])
    expect(whatsapp.onboarding.credentials.map(credential => credential.env)).toEqual([
      'WHATSAPP_ACCESS_TOKEN',
      'WHATSAPP_PHONE_NUMBER_ID',
      'WHATSAPP_VERIFY_TOKEN',
      'WHATSAPP_APP_SECRET',
    ])
    expect(whatsapp.onboarding.credentials.filter(credential => credential.secret).map(credential => credential.key)).toEqual([
      'whatsapp_access_token',
      'whatsapp_verify_token',
      'whatsapp_app_secret',
    ])
    expect(whatsapp.onboarding.diagnostics.map(diagnostic => diagnostic.code)).toEqual(expect.arrayContaining([
      'missing_credentials',
      'callback_url_missing',
      'verify_token_mismatch',
      'signature_verification_missing',
      'unsafe_route_exposure',
      'missing_allowlist',
      'binding_missing',
    ]))

    expect(getChannelCapabilities('discord')?.onboarding.webhook?.routes.map(route => `${route.method} ${route.path}`)).toEqual(['POST /webhooks/discord'])
  })

  it('keeps onboarding metadata redaction-safe', () => {
    for (const capabilities of listChannelCapabilities()) {
      const serialized = JSON.stringify(capabilities.onboarding)
      expect(serialized).not.toMatch(/\b\d{8,}:[A-Za-z0-9_-]{20,}\b/)
      expect(serialized).not.toMatch(/\b\d{10,15}\b/)
      for (const credential of capabilities.onboarding.credentials.filter(credential => credential.secret)) {
        expect(credential.env || credential.configKey).toBeTruthy()
        expect(serialized).not.toContain('test-token')
        expect(serialized).not.toContain('secret-token')
      }
    }
  })

  it('keeps existing adapters wired to explicit capability declarations', () => {
    expect(telegramChannel.capabilities.provider).toBe('telegram')
    expect(telegramChannel.capabilities.categories.threading.status).toBe('supported')
    expect(telegramChannel.capabilities.markdown).toBe(true)

    expect(whatsappChannel.capabilities.provider).toBe('whatsapp')
    expect(whatsappChannel.capabilities.categories.callbacks.status).toBe('partial')
    expect(whatsappChannel.capabilities.richBlocks).toBe(false)
  })

  it('makes native action fallback decisions from capabilities instead of provider names', () => {
    expect(actionDeliveryForCapabilities(whatsappChannel.capabilities, true)).toBe('native')
    expect(actionDeliveryForCapabilities(whatsappChannel.capabilities, false)).toBe('text')
    expect(actionDeliveryForCapabilities({ plainText: true }, true)).toBe('text')
    expect(supportsChannelCapability(telegramAdapterCapabilities({ richMessagesEnabled: false }), 'inlineActions')).toBe(false)
  })
})
