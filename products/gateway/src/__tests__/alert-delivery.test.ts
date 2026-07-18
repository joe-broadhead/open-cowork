import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { deliverAlertNotifications } from '../alert-delivery.js'
import { clearConfigCacheForTest, getConfig, updateConfig } from '../config.js'
import { channelTargetFingerprint } from '../security.js'
import { appendWorkEvent, clearWorkStateForTest, listWorkEvents, type AlertRecord } from '../work-store.js'

describe('durable alert delivery', () => {
  let dir = ''
  let store = ''

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-alert-delivery-'))
    store = path.join(dir, 'gateway.db')
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = dir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = dir
    clearConfigCacheForTest()
    clearWorkStateForTest(store)
    updateConfig({
      alerts: { delivery: { enabled: true, maxAttempts: 2, targets: [{ provider: 'telegram', chatId: 'ops-chat', minimumSeverity: 'critical' }] } },
      security: { channelAllowlists: { telegram: [{ chatId: 'ops-chat' }], whatsapp: [], discord: [] } },
    } as any)
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    clearConfigCacheForTest()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('delivers each durable notification campaign once without storing raw target ids', async () => {
    const messages: string[] = []
    const channels = new Map([['telegram', { sendMessage: async (_chatId: string, text: string) => { messages.push(text) } }]])
    const alert = criticalAlert()

    expect(await deliverAlertNotifications([alert], channels, { config: getConfig(), filePath: store })).toMatchObject({ delivered: 1 })
    expect(await deliverAlertNotifications([alert], channels, { config: getConfig(), filePath: store })).toMatchObject({ attempted: 0, skipped: 1 })
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('[CRITICAL] OpenCode is unreachable')
    const serialized = JSON.stringify(listWorkEvents(100, store))
    expect(serialized).toContain('alert.notification.sent')
    expect(serialized).not.toContain('ops-chat')
  })

  it('retries failed delivery and durably dead-letters at the configured bound', async () => {
    let attempts = 0
    const channels = new Map([['telegram', { sendMessage: async () => { attempts += 1; throw new Error('token=private-channel-secret') } }]])
    const alert = criticalAlert()

    await deliverAlertNotifications([alert], channels, { config: getConfig(), filePath: store })
    const second = await deliverAlertNotifications([alert], channels, { config: getConfig(), filePath: store })
    const third = await deliverAlertNotifications([alert], channels, { config: getConfig(), filePath: store })

    expect(attempts).toBe(2)
    expect(second).toMatchObject({ failed: 1, deadLettered: 1 })
    expect(third).toMatchObject({ attempted: 0, deadLettered: 1 })
    const serialized = JSON.stringify(listWorkEvents(100, store))
    expect(serialized).toContain('alert.notification.dead_lettered')
    expect(serialized).not.toContain('private-channel-secret')
  })

  it('serializes overlapping cycles so one campaign target is sent once', async () => {
    let sends = 0
    let releaseSend!: () => void
    const sendBlocked = new Promise<void>(resolve => { releaseSend = resolve })
    const channels = new Map([['telegram', { sendMessage: async () => { sends += 1; await sendBlocked } }]])
    const alert = criticalAlert()

    const first = deliverAlertNotifications([alert], channels, { config: getConfig(), filePath: store })
    await viWaitFor(() => sends === 1)
    const second = deliverAlertNotifications([alert], channels, { config: getConfig(), filePath: store })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(sends).toBe(1)

    releaseSend()
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult).toMatchObject({ delivered: 1 })
    expect(secondResult).toMatchObject({ attempted: 0, skipped: 1 })
    expect(sends).toBe(1)
  })

  it('dead-letters an unresolved pre-send claim instead of blindly duplicating after a crash', async () => {
    let sends = 0
    const alert = criticalAlert()
    const campaign = `alert:${alert.id}:${alert.lastNotifiedAt}`
    const targetKey = channelTargetFingerprint('telegram', 'ops-chat')
    appendWorkEvent('alert.notification.claimed', campaign, {
      alertId: alert.id,
      targetKey,
      attempts: 1,
      state: 'claimed_before_send',
    }, store)

    const result = await deliverAlertNotifications([alert], new Map([
      ['telegram', { sendMessage: async () => { sends += 1 } }],
    ]), { config: getConfig(), filePath: store })

    expect(result).toMatchObject({ attempted: 0, delivered: 0, deadLettered: 1 })
    expect(sends).toBe(0)
    const events = listWorkEvents(100, store)
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'alert.notification.ambiguous', payload: expect.objectContaining({ targetKey, reason: expect.stringContaining('unknown') }) }),
      expect.objectContaining({ type: 'alert.notification.dead_lettered', payload: expect.objectContaining({ targetKey, reason: 'ambiguous_delivery_outcome' }) }),
    ]))
  })

  it('redacts notification content with the effective delivery config', async () => {
    const secret = 'effective-config-only-secret'
    const config = structuredClone(getConfig())
    config.channels.telegram.botToken = secret
    const messages: string[] = []
    const alert = { ...criticalAlert(), summary: `OpenCode failed with ${secret}`, evidence: [`token=${secret}`], nextAction: `rotate ${secret}` }

    await deliverAlertNotifications([alert], new Map([
      ['telegram', { sendMessage: async (_chatId: string, text: string) => { messages.push(text) } }],
    ]), { config, filePath: store })

    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('<redacted')
    expect(messages[0]).not.toContain(secret)
  })
})

async function viWaitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for alert delivery')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function criticalAlert(): AlertRecord {
  return {
    id: 'alert_critical_1',
    key: 'opencode:unreachable',
    status: 'active',
    severity: 'critical',
    source: 'gateway.alerts',
    summary: 'OpenCode is unreachable',
    evidence: ['connection refused'],
    nextAction: 'Start OpenCode.',
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
    lastNotifiedAt: '2026-01-01T00:00:00.000Z',
    dedupeCount: 0,
    details: {},
  }
}
