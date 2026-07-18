import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { formatChannelCommand } from '../channel-cli.js'
import { clearConfigCacheForTest, updateConfig } from '../config.js'
import { clearWorkStateForTest, upsertChannelBinding } from '../work-store.js'

describe('channel CLI', () => {
  let testDir: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-channel-cli-'))
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    clearChannelEnv()
    clearConfigCacheForTest()
    clearWorkStateForTest(path.join(testDir, 'gateway.db'))
  })

  afterEach(() => {
    clearChannelEnv()
    clearConfigCacheForTest()
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  it('lists built-in providers through one connector UX', () => {
    const result = formatChannelCommand(['list'])

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('Channel connectors')
    expect(result.output).toContain('telegram')
    expect(result.output).toContain('whatsapp')
    expect(result.output).toContain('discord')
  })

  it('reports Telegram missing credentials and configured state without leaking token or target values', () => {
    const missing = formatChannelCommand(['status', 'telegram'])
    expect(missing.output).toContain('Telegram channel')
    expect(missing.output).toContain('TELEGRAM_BOT_TOKEN')
    expect(missing.output).toContain('channels.telegram.botToken')
    expect(missing.output).toContain('missing_credentials')

    updateConfig({
      channels: { telegram: { botToken: '123456:telegram-secret-token-value' } },
      security: { channelAllowlists: { telegram: [{ chatId: 'private-chat-id' }], whatsapp: [], discord: [] } },
    } as any)
    upsertChannelBinding({ provider: 'telegram', chatId: 'private-chat-id', sessionId: 'ses_private' })

    const configured = formatChannelCommand(['status', 'telegram'])
    expect(configured.output).toContain('Configured: yes')
    expect(configured.output).toContain('Trusted target: yes')
    expect(configured.output).toContain('Bindings: 1')
    expect(configured.output).not.toContain('telegram-secret-token-value')
    expect(configured.output).not.toContain('private-chat-id')

    const json = JSON.parse(formatChannelCommand(['status', '--json', 'telegram']).output)
    expect(json.connector.provider).toBe('telegram')
  })

  it('guides partially configured WhatsApp setup with exact safe keys and no private values', () => {
    updateConfig({
      channels: {
        whatsapp: {
          accessToken: 'EAAG-secret-access-token',
          phoneNumberId: '15551234567',
          verifyToken: 'verify-secret-token',
          appSecret: '',
        },
      },
      security: { publicWebhookMode: false, channelAllowlists: { telegram: [], whatsapp: [], discord: [] } },
    } as any)

    const setup = formatChannelCommand(['setup', 'whatsapp'])
    expect(setup.exitCode).toBe(0)
    expect(setup.output).toContain('Access token')
    expect(setup.output).toContain('Current step: Verify')
    expect(setup.output).toContain('Primary action:')
    expect(setup.output).toContain('Guided checklist')
    expect(setup.output).toContain('[blocked] Verify')
    expect(setup.output).toContain('opencode-gateway channel setup whatsapp')
    expect(setup.output).toContain('Cloud API direct')
    expect(setup.output).toContain('WHATSAPP_ACCESS_TOKEN')
    expect(setup.output).toContain('Phone number ID')
    expect(setup.output).toContain('WHATSAPP_PHONE_NUMBER_ID')
    expect(setup.output).toContain('Verify token')
    expect(setup.output).toContain('WHATSAPP_VERIFY_TOKEN')
    expect(setup.output).toContain('App secret')
    expect(setup.output).toContain('WHATSAPP_APP_SECRET')
    expect(setup.output).toContain('/webhooks/whatsapp')
    expect(setup.output).toContain('security.channelAllowlists.whatsapp')
    expect(setup.output).not.toContain('EAAG-secret-access-token')
    expect(setup.output).not.toContain('15551234567')
    expect(setup.output).not.toContain('verify-secret-token')

    const setupJson = JSON.parse(formatChannelCommand(['setup', '--json', 'whatsapp']).output)
    expect(setupJson.setup).toMatchObject({
      currentStep: 'verify',
      primaryAction: expect.objectContaining({ command: 'opencode-gateway channel verify whatsapp' }),
      redacted: true,
    })
    expect(setupJson.setup.steps.map((step: any) => step.id)).toEqual(['connect', 'verify', 'trust', 'bind', 'monitor'])

    const verify = formatChannelCommand(['verify', 'whatsapp'])
    expect(verify.output).toContain('No provider messages are sent')
    expect(verify.output).toContain('webhook route is not exposed')
    expect(verify.output).toContain('Signature: missing')

    const trust = formatChannelCommand(['trust', 'whatsapp'])
    expect(trust.output).toContain('security.channelAllowlists.whatsapp')
    expect(trust.output).not.toContain('15551234567')

    const repair = formatChannelCommand(['repair', 'whatsapp'])
    expect(repair.output).toContain('Missing prerequisites:')
    expect(repair.output).toContain('WHATSAPP_APP_SECRET')
  })

  it('reports Discord disabled as an alpha enablement blocker', () => {
    const result = formatChannelCommand(['status', 'discord'])

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('Discord channel')
    expect(result.output).toContain('Enabled: no')
    expect(result.output).toContain('provider_disabled')
    expect(result.output).toContain('OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED')
  })

  it('returns a non-zero result for unknown providers', () => {
    const result = formatChannelCommand(['status', 'matrix'])

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('Unknown channel provider: matrix')
    expect(result.output).toContain('Known providers:')
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
  delete process.env['DISCORD_PUBLIC_KEY']
}
