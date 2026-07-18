import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHmac } from 'node:crypto'
import { channelCommandMenuActions } from '../channel-commands.js'
import { claimCodeFingerprint, claimCodeHash, createChannelClaimCode, extractClaimCode, formatClaimCode } from '../channel-claims.js'
import { mapWhatsAppMessages, whatsappChannel } from '../channels/whatsapp.js'
import { clearConfigCacheForTest, getConfig, updateConfig } from '../config.js'
import { TransientInboundError } from '../security.js'
import { permissionRequestMessage, questionRequestMessage } from '../opencode-requests.js'
import { clearWorkStateForTest, createChannelClaimCodeRecord, listWorkEvents } from '../work-store.js'
import { clearEventsForTest, getQueuedEvents } from '../wakeup.js'

describe('whatsapp channel', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-whatsapp-test-'))

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    process.env['WHATSAPP_ACCESS_TOKEN'] = 'test-whatsapp-access-token'
    process.env['WHATSAPP_PHONE_NUMBER_ID'] = 'wa-phone-number-id-fixture'
    process.env['WHATSAPP_VERIFY_TOKEN'] = 'test-whatsapp-verify-token'
    process.env['WHATSAPP_APP_SECRET'] = 'test-whatsapp-app-secret'
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    clearConfigCacheForTest()
    clearWorkStateForTest(path.join(testDir, 'gateway.db'))
    clearEventsForTest()
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    delete process.env['WHATSAPP_ACCESS_TOKEN']
    delete process.env['WHATSAPP_PHONE_NUMBER_ID']
    delete process.env['WHATSAPP_VERIFY_TOKEN']
    delete process.env['WHATSAPP_APP_SECRET']
    clearConfigCacheForTest()
    clearEventsForTest()
    vi.unstubAllGlobals()
  })

  it('maps text messages into gateway channel messages', () => {
    const [msg] = mapWhatsAppMessages({ entry: [{ changes: [{ value: { messages: [{ from: 'wa-fixture-target', timestamp: '1760000000', type: 'text', text: { body: 'hello' } }] } }] }] })

    expect(msg).toMatchObject({ provider: 'whatsapp', chatId: 'wa-fixture-target', userId: 'wa-fixture-target', text: 'hello' })
  })

  it('maps interactive replies and media captions', () => {
    const messages = mapWhatsAppMessages({ entry: [{ changes: [{ value: { messages: [
      { from: '1', type: 'interactive', interactive: { button_reply: { id: 'approve', title: 'Approve' } } },
      { from: '2', type: 'image', image: { id: 'media-1', caption: 'see this', mime_type: 'image/png' } },
    ] } }] }] })

    expect(messages[0]!.text).toBe('approve')
    expect(messages[1]!.text).toBe('see this')
    expect(messages[1]!.attachments?.[0]).toMatchObject({ name: 'image-media-1', url: 'media-1', mimeType: 'image/png' })
  })

  it('maps WhatsApp command list replies back to slash commands', () => {
    const [msg] = mapWhatsAppMessages({ entry: [{ changes: [{ value: { messages: [
      { from: '1', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: '/commands', title: 'Commands' } } },
    ] } }] }] })

    expect(msg!.text).toBe('/commands')
  })

  it('verifies webhook POST signatures using the app secret', () => {
    const raw = JSON.stringify({ object: 'whatsapp_business_account' })
    const signature = 'sha256=' + createHmac('sha256', 'test-whatsapp-app-secret').update(raw).digest('hex')

    expect(whatsappChannel.verifySignature(signature, raw)).toBe(true)
    expect(whatsappChannel.verifySignature('sha256=bad', raw)).toBe(false)
    delete process.env['WHATSAPP_APP_SECRET']
    expect(whatsappChannel.verifySignature(signature, raw)).toBe(false)
  })

  it('verifies WhatsApp challenge tokens and rejects mismatches locally', () => {
    const ok = new URL('http://localhost/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=test-whatsapp-verify-token&hub.challenge=challenge-fixture')
    const mismatch = new URL('http://localhost/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=challenge-fixture')
    const wrongMode = new URL('http://localhost/webhooks/whatsapp?hub.mode=unsubscribe&hub.verify_token=test-whatsapp-verify-token&hub.challenge=challenge-fixture')

    const missingToken = new URL('http://localhost/webhooks/whatsapp?hub.mode=subscribe&hub.challenge=challenge-fixture')
    const truncatedToken = new URL('http://localhost/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=test-whatsapp-verify&hub.challenge=challenge-fixture')

    expect(whatsappChannel.verifyWebhook(ok)).toBe('challenge-fixture')
    expect(whatsappChannel.verifyWebhook(mismatch)).toBeNull()
    expect(whatsappChannel.verifyWebhook(wrongMode)).toBeNull()
    expect(whatsappChannel.verifyWebhook(missingToken)).toBeNull()
    expect(whatsappChannel.verifyWebhook(truncatedToken)).toBeNull()
    delete process.env['WHATSAPP_VERIFY_TOKEN']
    expect(whatsappChannel.verifyWebhook(ok)).toBeNull()
  })

  it('does not report full readiness when inbound webhook signatures cannot be verified', async () => {
    delete process.env['WHATSAPP_APP_SECRET']
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await whatsappChannel.start()

    const queued = getQueuedEvents().join('\n')
    expect(queued).toContain('WhatsApp outbound ready; inbound webhooks blocked: app secret missing')
    expect(queued).not.toContain('WhatsApp channel ready')
    expect(consoleSpy.mock.calls.flat().join('\n')).toContain('inbound webhook signature verification is blocked')
  })

  it('reports WhatsApp ready only when outbound credentials and inbound signing secret are configured', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await whatsappChannel.start()

    expect(getQueuedEvents().join('\n')).toContain('WhatsApp channel ready: outbound and signed inbound webhooks configured')
    expect(consoleSpy.mock.calls.flat().join('\n')).toContain('Webhook channel ready at /webhooks/whatsapp')
  })

  it('rejects WhatsApp inbound messages outside the configured allowlist', async () => {
    updateConfig({ security: { channelAllowlists: { whatsapp: [{ chatId: 'wa-fixture-target' }], telegram: [] } } } as any)
    const handled: string[] = []
    whatsappChannel.onMessage(async msg => { handled.push(msg.chatId) })

    const count = await whatsappChannel.handleWebhook({ entry: [{ changes: [{ value: { messages: [
      { from: 'wa-untrusted-target', type: 'text', text: { body: 'blocked' } },
      { from: 'wa-fixture-target', type: 'text', text: { body: 'allowed' } },
    ] } }] }] })

    expect(count).toBe(1)
    expect(handled).toEqual(['wa-fixture-target'])
    const queued = getQueuedEvents().join('\n')
    expect(queued).toContain('WhatsApp rejected untrusted inbound: whatsapp:target:')
    expect(queued).not.toContain('wa-untrusted-target')
    const audit = listWorkEvents(20).find(event => event.type === 'audit.security' && event.payload['operation'] === 'channel.inbound')
    expect(audit).toMatchObject({
      subjectId: expect.stringContaining('whatsapp:target:'),
      payload: {
        actor: 'whatsapp',
        source: expect.stringContaining('whatsapp:target:'),
        operation: 'channel.inbound',
        target: expect.stringContaining('whatsapp:target:'),
        result: 'denied',
        details: expect.objectContaining({
          provider: 'whatsapp',
          reason: 'untrusted_target',
          evidence: 'provider-native',
          redacted: true,
        }),
      },
    })
    const serializedEvents = JSON.stringify(listWorkEvents(20))
    expect(serializedEvents).not.toContain('wa-untrusted-target')
    expect(serializedEvents).not.toContain('blocked')
  })

  it('propagates transient inbound failures so Meta retries the webhook delivery', async () => {
    updateConfig({ security: { channelAllowlists: { whatsapp: [{ chatId: 'wa-fixture-target' }], telegram: [], discord: [] } } } as any)
    const handled: string[] = []
    let attempts = 0
    whatsappChannel.onMessage(async msg => {
      attempts++
      // First delivery fails transiently (OpenCode restarting); the redelivery succeeds.
      if (attempts === 1) throw new TransientInboundError('bound channel session check failed transiently')
      handled.push(msg.text)
    })
    const payload = { entry: [{ changes: [{ value: { messages: [
      { from: 'wa-fixture-target', type: 'text', text: { body: 'retry me after the outage' } },
    ] } }] }] }

    await expect(whatsappChannel.handleWebhook(payload)).rejects.toBeInstanceOf(TransientInboundError)
    expect(handled).toEqual([])
    // The message was not acknowledged as processed: no poison-skip evidence.
    expect(listWorkEvents(20).some(event => event.type === 'whatsapp.inbound.skipped')).toBe(false)

    // Meta redelivers the same payload after the non-2xx response.
    await expect(whatsappChannel.handleWebhook(payload)).resolves.toBe(1)
    expect(handled).toEqual(['retry me after the outage'])
  })

  it('skips a poison inbound message with a redacted note and keeps the webhook acknowledged', async () => {
    updateConfig({ security: { channelAllowlists: { whatsapp: [{ chatId: 'wa-fixture-target' }], telegram: [], discord: [] } } } as any)
    const handled: string[] = []
    whatsappChannel.onMessage(async msg => {
      if (msg.text === 'poison') throw new Error('permanent handler failure')
      handled.push(msg.text)
    })

    const count = await whatsappChannel.handleWebhook({ entry: [{ changes: [{ value: { messages: [
      { from: 'wa-fixture-target', type: 'text', text: { body: 'poison' } },
      { from: 'wa-fixture-target', type: 'text', text: { body: 'after poison' } },
    ] } }] }] })

    expect(count).toBe(1)
    expect(handled).toEqual(['after poison'])
    expect(getQueuedEvents().join('\n')).toContain('WhatsApp inbound message failed and was skipped: permanent handler failure')
    expect(listWorkEvents(20)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'whatsapp.inbound.skipped',
        payload: expect.objectContaining({ error: 'permanent handler failure' }),
      }),
    ]))
  })

  it('allows WhatsApp setup commands before trust but keeps stateful commands blocked', async () => {
    updateConfig({ security: { channelAllowlists: { whatsapp: [{ chatId: 'wa-trusted-target' }], telegram: [], discord: [] } } } as any)
    const handled: string[] = []
    whatsappChannel.onMessage(async msg => { handled.push(msg.text) })

    const count = await whatsappChannel.handleWebhook({ entry: [{ changes: [{ value: { messages: [
      { from: 'wa-untrusted-target', type: 'text', text: { body: '/help' } },
      { from: 'wa-untrusted-target', type: 'text', text: { body: '/status' } },
    ] } }] }] })

    expect(count).toBe(1)
    expect(handled).toEqual(['/help'])
    const queued = getQueuedEvents().join('\n')
    expect(queued).toContain('WhatsApp rejected untrusted inbound: whatsapp:target:')
    expect(queued).not.toContain('wa-untrusted-target')
    const serializedEvents = JSON.stringify(listWorkEvents(20))
    expect(serializedEvents).not.toContain('/help')
    expect(serializedEvents).not.toContain('/status')
  })

  it('accepts a claim code from an untrusted WhatsApp sender without dispatching message context', async () => {
    updateConfig({ security: { channelAllowlists: { whatsapp: [], telegram: [], discord: [] } } } as any)
    const claim = createChannelClaimCode({ provider: 'whatsapp', ttlMs: 60_000, createdBy: 'test' })
    const handled: string[] = []
    whatsappChannel.onMessage(async msg => { handled.push(msg.text) })

    const count = await whatsappChannel.handleWebhook({ entry: [{ changes: [{ value: { messages: [
      { from: 'wa-claim-target', type: 'text', text: { body: `please claim ${claim.code}` } },
    ] } }] }] })

    expect(count).toBe(1)
    expect(handled).toEqual([])
    expect(getConfig().security.channelAllowlists.whatsapp).toEqual([{ chatId: 'wa-claim-target' }])
    expect(getConfig().security.unsafeAllowAllChannelTargets.whatsapp).toBe(false)
    const events = listWorkEvents(50)
    expect(events.map(event => event.type)).toEqual(expect.arrayContaining(['channel.claim.created', 'channel.claim.accepted', 'audit.security']))
    expect(events.some(event => event.type === 'audit.security' && event.payload['operation'] === 'channel.inbound')).toBe(false)
    expect(JSON.stringify(events)).not.toContain('wa-claim-target')
  })

  it('preserves claim payloads that naturally start with GW through formatting and acceptance', async () => {
    updateConfig({ security: { channelAllowlists: { whatsapp: [], telegram: [], discord: [] } } } as any)
    const normalizedCode = 'GWABCDEFGH'
    const formattedCode = formatClaimCode(normalizedCode)
    createChannelClaimCodeRecord({
      id: 'claim_payload_starts_with_gw',
      provider: 'whatsapp',
      action: 'trust_target',
      codeHash: claimCodeHash(normalizedCode),
      codeFingerprint: claimCodeFingerprint(normalizedCode),
      createdBy: 'test',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    })
    const handled: string[] = []
    whatsappChannel.onMessage(async msg => { handled.push(msg.text) })

    expect(formattedCode).toBe('GW-GWAB-CDEF-GH')
    expect(extractClaimCode(normalizedCode)?.normalized).toBe(normalizedCode)
    expect(extractClaimCode(formattedCode)?.normalized).toBe(normalizedCode)
    expect(claimCodeHash(formattedCode)).toBe(claimCodeHash(normalizedCode))

    const count = await whatsappChannel.handleWebhook({ entry: [{ changes: [{ value: { messages: [
      { from: 'wa-gw-prefix-target', type: 'text', text: { body: formattedCode } },
    ] } }] }] })

    expect(count).toBe(1)
    expect(handled).toEqual([])
    expect(getConfig().security.channelAllowlists.whatsapp).toEqual([{ chatId: 'wa-gw-prefix-target' }])
    expect(JSON.stringify(listWorkEvents(50))).not.toContain('wa-gw-prefix-target')
  })

  it('denies expired, replayed, wrong-provider, and wrong-code WhatsApp claims without trust mutation', async () => {
    updateConfig({ security: { channelAllowlists: { whatsapp: [], telegram: [], discord: [] } } } as any)
    const expired = createChannelClaimCode({ provider: 'whatsapp', ttlMs: 60_000, now: new Date(Date.now() - 120_000) })
    const accepted = createChannelClaimCode({ provider: 'whatsapp', ttlMs: 60_000 })
    const telegram = createChannelClaimCode({ provider: 'telegram', ttlMs: 60_000 })
    const handled: string[] = []
    whatsappChannel.onMessage(async msg => { handled.push(msg.text) })

    await whatsappChannel.handleWebhook({ entry: [{ changes: [{ value: { messages: [
      { from: 'wa-expired-target', type: 'text', text: { body: expired.code } },
      { from: 'wa-accepted-target', type: 'text', text: { body: accepted.code } },
      { from: 'wa-replay-target', type: 'text', text: { body: accepted.code } },
      { from: 'wa-wrong-provider-target', type: 'text', text: { body: telegram.code } },
      { from: 'wa-wrong-code-target', type: 'text', text: { body: 'GW-ABCD-EFGH-JK' } },
    ] } }] }] })

    expect(getConfig().security.channelAllowlists.whatsapp).toEqual([{ chatId: 'wa-accepted-target' }])
    expect(handled).toEqual([])
    const serializedEvents = JSON.stringify(listWorkEvents(100))
    expect(serializedEvents).toContain('expired')
    expect(serializedEvents).toContain('replay')
    expect(serializedEvents).toContain('wrong_provider')
    expect(serializedEvents).toContain('wrong_code')
    expect(serializedEvents).not.toContain('wa-expired-target')
    expect(serializedEvents).not.toContain('wa-replay-target')
    expect(serializedEvents).not.toContain('wa-wrong-provider-target')
    expect(serializedEvents).not.toContain('wa-wrong-code-target')
  })

  it('sends command help as a WhatsApp interactive list', async () => {
    const calls: Array<{ url: string; body: any }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body || '{}')) })
      return new Response('{}', { status: 200 })
    }))

    await whatsappChannel.sendCommandMenu?.('wa-fixture-target', 'Gateway commands:', channelCommandMenuActions())

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain('/v20.0/wa-phone-number-id-fixture/messages')
    expect(calls[0]!.body).toMatchObject({
      messaging_product: 'whatsapp',
      to: 'wa-fixture-target',
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: 'Gateway commands:' },
        action: {
          button: 'Commands',
          sections: [{ title: 'Gateway', rows: expect.arrayContaining([expect.objectContaining({ id: '/status', title: 'Status' })]) }],
        },
      },
    })
  })

  it('sends OpenCode permission and question cards as WhatsApp interactive lists', async () => {
    const calls: Array<{ url: string; body: any }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body || '{}')) })
      return new Response('{}', { status: 200 })
    }))

    await whatsappChannel.sendStructuredMessage?.('wa-fixture-target', permissionRequestMessage({
      id: 'perm_1',
      sessionID: 'ses_permission',
      permission: 'edit',
      patterns: ['src/**'],
      metadata: {},
      always: [],
    }))
    await whatsappChannel.sendStructuredMessage?.('wa-fixture-target', questionRequestMessage({
      id: 'question_1',
      sessionID: 'ses_question',
      questions: [{ header: 'Choice', question: 'Pick one?', options: [{ label: 'A' }] }],
    }))

    expect(calls).toHaveLength(2)
    expect(calls[0]!.url).toContain('/v20.0/wa-phone-number-id-fixture/messages')
    expect(calls[0]!.body).toMatchObject({
      messaging_product: 'whatsapp',
      to: 'wa-fixture-target',
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: expect.stringContaining('Permission required') },
        action: {
          button: 'Respond',
          sections: [{ title: 'Permission required', rows: expect.arrayContaining([
            expect.objectContaining({ id: '/approve perm_1 once', title: 'Approve once' }),
            expect.objectContaining({ id: '/approve perm_1 always', title: 'Approve always' }),
            expect.objectContaining({ id: '/deny perm_1', title: 'Deny' }),
          ]) }],
        },
      },
    })
    expect(calls[0]!.body.interactive.body.text).toContain('Typed fallback: /approve perm_1 once')
    expect(calls[1]!.body.interactive.action.sections[0].rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: '/answer question_1 A', title: 'A' }),
      expect.objectContaining({ id: '/reject-question question_1', title: 'Reject' }),
    ]))
    expect(JSON.stringify(calls)).not.toContain('test-whatsapp-access-token')
  })

  it('falls back to WhatsApp text when structured interactive delivery fails', async () => {
    const calls: Array<{ url: string; body: any }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body || '{}')) })
      return new Response(calls.length === 1 ? 'interactive rejected' : '{}', { status: calls.length === 1 ? 400 : 200 })
    }))

    await whatsappChannel.sendStructuredMessage?.('wa-fixture-target', permissionRequestMessage({
      id: 'perm_1',
      sessionID: 'ses_permission',
      permission: 'bash',
      patterns: ['npm test'],
      metadata: {},
      always: [],
    }))

    expect(calls).toHaveLength(2)
    expect(calls[0]!.body.type).toBe('interactive')
    expect(calls[1]!.body).toMatchObject({
      messaging_product: 'whatsapp',
      to: 'wa-fixture-target',
      type: 'text',
      text: { body: expect.stringContaining('Permission required') },
    })
    expect(calls[1]!.body.text.body).toContain('/approve perm_1 once')
    expect(getQueuedEvents().join('\n')).toContain('WhatsApp structured message fallback: WhatsApp send failed: HTTP 400')
  })
})
