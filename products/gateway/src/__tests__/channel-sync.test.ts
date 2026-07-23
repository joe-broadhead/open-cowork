import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ChannelSyncBridge, clearChannelSyncForTest, getChannelSyncSummary, readChannelSyncStateForTest } from '../channel-sync.js'
import { clearChannelSessionsForTest, setChannelSession } from '../channel-sessions.js'
import { clearEventsForTest } from '../wakeup.js'
import { clearCurrentDaemonLeadershipForTest, createDaemonLeadership, setCurrentDaemonLeadership } from '../daemon-leadership.js'

describe('channel sync bridge', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-channel-sync-test-'))

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })
  const stateFile = path.join(testDir, 'channel-sync.json')
  let messages: any[]
  let sent: Array<{ provider: string; chatId: string; text: string; threadId?: string }>
  let now: number

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    clearChannelSessionsForTest()
    clearChannelSyncForTest(stateFile)
    clearEventsForTest()
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    messages = []
    sent = []
    now = 1_000_000
    clearCurrentDaemonLeadershipForTest()
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    clearCurrentDaemonLeadershipForTest()
  })

  it('baselines existing history and forwards new Web-originated messages once', async () => {
    messages = [message('old', 'assistant', 'old reply', 900_000)]
    setChannelSession('telegram', 'chat-1', 'ses_1')
    const bridge = bridgeWithChannels(['telegram'])

    await bridge.initialize('ses_1', 'telegram', 'chat-1')
    messages.push(message('u1', 'user', 'do the thing', 1_000_100))
    messages.push(message('a1', 'assistant', 'done', 1_000_200))

    await bridge.syncOnce()
    await bridge.syncOnce()

    expect(sent).toEqual([
      { provider: 'telegram', chatId: 'chat-1', text: 'OpenCode Web:\ndo the thing' },
      { provider: 'telegram', chatId: 'chat-1', text: 'done' },
    ])
  })

  it('does not create delivery checkpoints when OpenCode message reads fail', async () => {
    setChannelSession('telegram', 'chat-1', 'ses_1')
    const bridge = new ChannelSyncBridge(
      { session: { messages: async () => { throw new Error('OpenCode unavailable') } } },
      new Map([['telegram', { sendMessage: async () => {} }]]),
      { stateFile, now: () => now },
    )

    await expect(bridge.initialize('ses_1', 'telegram', 'chat-1')).rejects.toThrow('OpenCode unavailable')

    if (fs.existsSync(stateFile)) {
      const state = readChannelSyncStateForTest(stateFile)!
      expect(state.deliveries || {}).toEqual({})
    }
    expect(sent).toEqual([])
  })

  it('does not echo a Telegram-originated user message back to Telegram', async () => {
    setChannelSession('telegram', 'chat-1', 'ses_1')
    const bridge = bridgeWithChannels(['telegram'])

    await bridge.initialize('ses_1', 'telegram', 'chat-1')
    bridge.recordInbound('ses_1', 'telegram', 'chat-1', 'hello')
    messages.push(message('u1', 'user', 'hello', 1_000_100))
    messages.push(message('a1', 'assistant', 'hi', 1_000_200))

    await bridge.syncOnce()

    expect(sent).toEqual([{ provider: 'telegram', chatId: 'chat-1', text: 'hi' }])
  })

  it('deduplicates inbound provider message IDs by provider chat and thread', () => {
    const bridge = bridgeWithChannels(['telegram'])

    expect(bridge.recordInbound('ses_1', 'telegram', 'chat-1', 'hello', 'topic-1', 'provider-message-1')).toBe(true)
    expect(bridge.recordInbound('ses_1', 'telegram', 'chat-1', 'hello again', 'topic-1', 'provider-message-1')).toBe(false)
    now += 31_000
    expect(bridge.recordInbound('ses_1', 'telegram', 'chat-1', 'hello again', 'topic-1', 'provider-message-1')).toBe(true)
    expect(bridge.recordInbound('ses_1', 'telegram', 'chat-1', 'hello again', 'topic-1', 'provider-message-2')).toBe(true)
    expect(bridge.recordInbound('ses_1', 'telegram', 'chat-1', 'hello again', 'topic-2', 'provider-message-1')).toBe(true)
    bridge.markInboundSubmitted('telegram', 'chat-1', 'hello again', 'topic-1', 'provider-message-1')
    expect(bridge.recordInbound('ses_1', 'telegram', 'chat-1', 'hello again', 'topic-1', 'provider-message-1')).toBe(false)

    const state = readChannelSyncStateForTest(stateFile)!
    expect(state.pendingInbound).toHaveLength(3)
    expect(Object.keys(state.inboundReceipts)).toHaveLength(3)
    expect(Object.values(state.inboundReceipts)).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerMessageId: 'provider-message-1', submittedAt: expect.any(Number) }),
    ]))
    expect(JSON.stringify(state)).not.toContain('hello again')
  })

  it('forgets unsubmitted inbound receipts after prompt submission fails', () => {
    const bridge = bridgeWithChannels(['telegram'])

    expect(bridge.recordInbound('ses_1', 'telegram', 'chat-1', 'retry me', 'topic-1', 'provider-message-1')).toBe(true)
    expect(bridge.recordInbound('ses_1', 'telegram', 'chat-1', 'retry me', 'topic-1', 'provider-message-1')).toBe(false)

    bridge.forgetInbound('telegram', 'chat-1', 'retry me', 'topic-1', 'provider-message-1')

    expect(bridge.recordInbound('ses_1', 'telegram', 'chat-1', 'retry me', 'topic-1', 'provider-message-1')).toBe(true)
    const state = readChannelSyncStateForTest(stateFile)!
    expect(state.pendingInbound).toHaveLength(1)
    expect(Object.keys(state.inboundReceipts)).toHaveLength(1)
  })

  it('syncs channel-originated user messages to other linked channels', async () => {
    setChannelSession('telegram', 'tg-chat', 'ses_1')
    setChannelSession('whatsapp', 'wa-chat', 'ses_1')
    const bridge = bridgeWithChannels(['telegram', 'whatsapp'])

    await bridge.initialize('ses_1', 'telegram', 'tg-chat')
    await bridge.initialize('ses_1', 'whatsapp', 'wa-chat')
    bridge.recordInbound('ses_1', 'telegram', 'tg-chat', 'hello from tg')
    messages.push(message('u1', 'user', 'hello from tg', 1_000_100))
    messages.push(message('a1', 'assistant', 'reply to both', 1_000_200))

    await bridge.syncOnce()

    expect(sent).toHaveLength(3)
    expect(sent).toEqual(expect.arrayContaining([
      { provider: 'telegram', chatId: 'tg-chat', text: 'reply to both' },
      { provider: 'whatsapp', chatId: 'wa-chat', text: 'Telegram:\nhello from tg' },
      { provider: 'whatsapp', chatId: 'wa-chat', text: 'reply to both' },
    ]))
  })

  it('does not checkpoint failed deliveries so they can retry', async () => {
    setChannelSession('telegram', 'chat-1', 'ses_1')
    let failures = 1
    const bridge = bridgeWithChannels(['telegram'], async (provider, chatId, text) => {
      if (failures > 0) {
        failures--
        throw new Error('network down')
      }
      sent.push({ provider, chatId, text })
    })

    await bridge.initialize('ses_1', 'telegram', 'chat-1')
    messages.push(message('a1', 'assistant', 'retry me', 1_000_100))

    await bridge.syncOnce()
    await bridge.syncOnce()

    expect(sent).toEqual([{ provider: 'telegram', chatId: 'chat-1', text: 'retry me' }])
  })

  it('records failed delivery attempts durably before retrying them', async () => {
    setChannelSession('telegram', 'chat-1', 'ses_1')
    let failures = 1
    const bridge = bridgeWithChannels(['telegram'], async (provider, chatId, text) => {
      if (failures > 0) {
        failures--
        throw new Error('network down')
      }
      sent.push({ provider, chatId, text })
    })

    await bridge.initialize('ses_1', 'telegram', 'chat-1')
    messages.push(message('a1', 'assistant', 'retry me durably', 1_000_100))

    await bridge.syncOnce()

    expect(sent).toEqual([])
    expect(readOutboxRows()).toEqual([
      expect.objectContaining({ status: 'pending', attempts: 1, last_error: 'network down', delivered_at: null }),
    ])

    await bridge.syncOnce()

    expect(sent).toEqual([{ provider: 'telegram', chatId: 'chat-1', text: 'retry me durably' }])
    expect(readOutboxRows()).toEqual([
      expect.objectContaining({ status: 'delivered', attempts: 2, last_error: null }),
    ])
  })

  it('backs off a provider on rate limits without advancing delivery checkpoints', async () => {
    setChannelSession('telegram', 'chat-1', 'ses_1')
    let failures = 1
    const bridge = bridgeWithChannels(['telegram'], async (provider, chatId, text) => {
      if (failures > 0) {
        failures--
        throw new Error('HTTP 429 retry_after 2')
      }
      sent.push({ provider, chatId, text })
    })

    await bridge.initialize('ses_1', 'telegram', 'chat-1')
    messages.push(message('a1', 'assistant', 'rate limited first', 1_000_100))
    messages.push(message('a2', 'assistant', 'waits behind provider backoff', 1_000_200))

    await bridge.syncOnce()

    expect(sent).toEqual([])
    expect(readOutboxRows()).toEqual([
      expect.objectContaining({ status: 'pending', attempts: 1, provider_error_kind: 'rate_limit', retry_after: new Date(now + 2000).toISOString() }),
    ])
    expect(getChannelSyncSummary({ stateFile, now }).outbox?.providerBackoff).toEqual([
      expect.objectContaining({ provider: 'telegram', retryAfter: new Date(now + 2000).toISOString(), pending: 1 }),
    ])
    const failedCheckpoint = readChannelSyncStateForTest(stateFile)!.deliveries['ses_1:telegram:chat-1:']!
    expect(failedCheckpoint).toBeDefined()
    expect(failedCheckpoint.seenMessageIds).toEqual([])

    await bridge.syncOnce()
    expect(sent).toEqual([])

    now += 2001
    await bridge.syncOnce()

    expect(sent).toEqual([
      { provider: 'telegram', chatId: 'chat-1', text: 'rate limited first' },
      { provider: 'telegram', chatId: 'chat-1', text: 'waits behind provider backoff' },
    ])
  })

  it('dead-letters terminal channel delivery failures without checkpointing the message', async () => {
    setChannelSession('whatsapp', 'chat-1', 'ses_1')
    const bridge = bridgeWithChannels(['whatsapp'], async () => {
      throw new Error('HTTP 400: Bad Request: chat not found')
    })

    await bridge.initialize('ses_1', 'whatsapp', 'chat-1')
    messages.push(message('a1', 'assistant', 'cannot deliver', 1_000_100))

    await bridge.syncOnce()
    await bridge.syncOnce()

    expect(sent).toEqual([])
    expect(readOutboxRows()).toEqual([
      expect.objectContaining({ status: 'dead_letter', attempts: 1, provider_error_kind: 'terminal', dead_lettered_at: new Date(now).toISOString() }),
    ])
    const checkpoint = readChannelSyncStateForTest(stateFile)!.deliveries['ses_1:whatsapp:chat-1:']!
    expect(checkpoint).toBeDefined()
    expect(checkpoint.seenMessageIds).not.toContain('a1')
    expect(getChannelSyncSummary({ stateFile }).outbox).toMatchObject({ deadLetter: 1 })
  })

  it('keeps the checkpoint behind a failed delivery and does not skip later messages across restart', async () => {
    setChannelSession('telegram', 'chat-1', 'ses_1')
    let failFirst = true
    const firstBridge = bridgeWithChannels(['telegram'], async (provider, chatId, text) => {
      if (text === 'first must retry' && failFirst) {
        failFirst = false
        throw new Error('temporary outage')
      }
      sent.push({ provider, chatId, text })
    })

    await firstBridge.initialize('ses_1', 'telegram', 'chat-1')
    messages.push(message('a1', 'assistant', 'first must retry', 1_000_100))
    messages.push(message('a2', 'assistant', 'second waits behind failure', 1_000_200))
    await firstBridge.syncOnce()

    const failedCheckpoint = readChannelSyncStateForTest(stateFile)!.deliveries['ses_1:telegram:chat-1:']!
    expect(failedCheckpoint).toBeDefined()
    expect(sent).toEqual([])
    expect(failedCheckpoint.lastMessageCreated).toBe(0)
    expect(failedCheckpoint.seenMessageIds).not.toContain('a2')

    const restartedBridge = bridgeWithChannels(['telegram'])
    await restartedBridge.syncOnce()

    expect(sent).toEqual([
      { provider: 'telegram', chatId: 'chat-1', text: 'first must retry' },
      { provider: 'telegram', chatId: 'chat-1', text: 'second waits behind failure' },
    ])
    const recoveredCheckpoint = readChannelSyncStateForTest(stateFile)!.deliveries['ses_1:telegram:chat-1:']!
    expect(recoveredCheckpoint).toBeDefined()
    expect(recoveredCheckpoint.lastMessageCreated).toBe(1_000_200)
    expect(recoveredCheckpoint.seenMessageIds).toEqual(expect.arrayContaining(['a1', 'a2']))
  })

  it('shares an in-flight sync pass instead of delivering duplicates', async () => {
    setChannelSession('telegram', 'chat-1', 'ses_1')
    let releaseSend!: () => void
    const sendGate = new Promise<void>(resolve => { releaseSend = resolve })
    const bridge = bridgeWithChannels(['telegram'], async (provider, chatId, text) => {
      await sendGate
      sent.push({ provider, chatId, text })
    })

    await bridge.initialize('ses_1', 'telegram', 'chat-1')
    messages.push(message('a1', 'assistant', 'send once', 1_000_100))
    const first = bridge.syncOnce()
    const second = bridge.syncOnce()

    await flushAsync()
    expect(sent).toHaveLength(0)

    releaseSend()
    await Promise.all([first, second])
    await bridge.syncOnce()

    expect(sent).toEqual([{ provider: 'telegram', chatId: 'chat-1', text: 'send once' }])
  })

  it('uses the durable outbox lease to prevent duplicate delivery across bridge instances', async () => {
    setChannelSession('telegram', 'chat-1', 'ses_1')
    let releaseSend!: () => void
    let sendStarted!: () => void
    const sendGate = new Promise<void>(resolve => { releaseSend = resolve })
    const firstSendStarted = new Promise<void>(resolve => { sendStarted = resolve })
    const send = async (provider: string, chatId: string, text: string) => {
      sendStarted()
      await sendGate
      sent.push({ provider, chatId, text })
    }
    const firstBridge = bridgeWithChannels(['telegram'], send)
    const secondBridge = bridgeWithChannels(['telegram'], send)

    await firstBridge.initialize('ses_1', 'telegram', 'chat-1')
    messages.push(message('a1', 'assistant', 'send once across processes', 1_000_100))

    const first = firstBridge.syncOnce()
    await firstSendStarted
    const second = secondBridge.syncOnce()

    await flushAsync()
    expect(sent).toHaveLength(0)

    releaseSend()
    await Promise.all([first, second])
    await secondBridge.syncOnce()

    expect(sent).toEqual([{ provider: 'telegram', chatId: 'chat-1', text: 'send once across processes' }])
    expect(readOutboxRows()).toEqual([
      expect.objectContaining({ status: 'delivered', attempts: 1 }),
    ])
  })

  it('does not sync or checkpoint while the daemon is standby', async () => {
    const dbPath = path.join(testDir, 'leadership.db')
    const writer = createDaemonLeadership({ filePath: dbPath, daemonId: 'writer-daemon', instanceId: 'writer-instance', leaseMs: 60_000, now: () => now })
    const standby = createDaemonLeadership({ filePath: dbPath, daemonId: 'standby-daemon', instanceId: 'standby-instance', leaseMs: 60_000, now: () => now })
    writer.acquireOrRenew()
    standby.acquireOrRenew()
    setCurrentDaemonLeadership(standby)

    setChannelSession('telegram', 'chat-1', 'ses_1')
    const bridge = bridgeWithChannels(['telegram'])
    messages.push(message('a1', 'assistant', 'standby must not send', 1_000_100))

    await bridge.initialize('ses_1', 'telegram', 'chat-1')
    bridge.recordInbound('ses_1', 'telegram', 'chat-1', 'from telegram')
    await bridge.syncOnce()

    expect(sent).toEqual([])
    expect(fs.existsSync(stateFile)).toBe(false)
    expect(fs.existsSync(`${stateFile}.sqlite`)).toBe(false)
  })

  it('does not advance checkpoints when a delivery lease is lost before completion', async () => {
    setChannelSession('telegram', 'chat-1', 'ses_1')
    const bridge = bridgeWithChannels(['telegram'], async (provider, chatId, text) => {
      sent.push({ provider, chatId, text })
      const db = new DatabaseSync(`${stateFile}.sqlite`)
      try {
        db.prepare("UPDATE channel_sync_outbox SET lease_owner = 'other-bridge'").run()
      } finally {
        db.close()
      }
    })

    await bridge.initialize('ses_1', 'telegram', 'chat-1')
    messages.push(message('a1', 'assistant', 'lease sensitive reply', 1_000_100))

    await bridge.syncOnce()

    expect(sent).toEqual([{ provider: 'telegram', chatId: 'chat-1', text: 'lease sensitive reply' }])
    const checkpoint = readChannelSyncStateForTest(stateFile)!.deliveries['ses_1:telegram:chat-1:']!
    expect(checkpoint).toBeDefined()
    expect(checkpoint.seenMessageIds).not.toContain('a1')
    expect(readOutboxRows()).toEqual([
      expect.objectContaining({ status: 'leased', lease_owner: 'other-bridge' }),
    ])
  })

  it('does not replay equal-timestamp messages already recorded at the checkpoint watermark', async () => {
    setChannelSession('telegram', 'chat-1', 'ses_1')
    fs.mkdirSync(testDir, { recursive: true })
    fs.writeFileSync(stateFile, JSON.stringify({
      savedAt: new Date(now).toISOString(),
      deliveries: {
        'ses_1:telegram:chat-1:': {
          sessionId: 'ses_1',
          provider: 'telegram',
          chatId: 'chat-1',
          initializedAt: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString(),
          lastMessageCreated: 1_000_100,
          lastMessageCreatedIds: ['a1'],
          seenMessageIds: [],
        },
      },
      pendingInbound: [],
    }, null, 2))
    messages.push(message('a1', 'assistant', 'already sent', 1_000_100))
    messages.push(message('a2', 'assistant', 'new same-timestamp reply', 1_000_100))
    const bridge = bridgeWithChannels(['telegram'])

    await bridge.syncOnce()

    expect(sent).toEqual([{ provider: 'telegram', chatId: 'chat-1', text: 'new same-timestamp reply' }])
  })

  it('persists successful delivery checkpoints across bridge restarts', async () => {
    setChannelSession('telegram', 'chat-1', 'ses_1')
    const firstBridge = bridgeWithChannels(['telegram'])

    await firstBridge.initialize('ses_1', 'telegram', 'chat-1')
    messages.push(message('a1', 'assistant', 'send once after restart', 1_000_100))
    await firstBridge.syncOnce()

    const restartedBridge = bridgeWithChannels(['telegram'])
    await restartedBridge.syncOnce()

    expect(sent).toEqual([{ provider: 'telegram', chatId: 'chat-1', text: 'send once after restart' }])
  })

  it('quarantines corrupt sync state and keeps processing instead of halting the channel', async () => {
    setChannelSession('telegram', 'chat-1', 'ses_1')
    fs.mkdirSync(testDir, { recursive: true })
    fs.writeFileSync(stateFile, '{not-json')
    messages.push(message('a1', 'assistant', 'baselined during reset', 1_000_100))
    const bridge = bridgeWithChannels(['telegram'])

    // The corrupt file is renamed aside and state reinitializes; existing history is
    // baselined (marked seen) rather than re-delivered.
    await bridge.syncOnce()
    expect(sent).toEqual([])
    const quarantined = fs.readdirSync(testDir).filter(name => name.startsWith(`${path.basename(stateFile)}.corrupt-`))
    expect(quarantined).toHaveLength(1)
    expect(fs.readFileSync(path.join(testDir, quarantined[0]!), 'utf-8')).toBe('{not-json')

    // New messages flow again after the reset.
    messages.push(message('a2', 'assistant', 'delivered after quarantine', 1_000_200))
    await bridge.syncOnce()
    expect(sent).toEqual([{ provider: 'telegram', chatId: 'chat-1', text: 'delivered after quarantine' }])

    // Inbound processing also continues instead of throwing.
    expect(bridge.recordInbound('ses_1', 'telegram', 'chat-1', 'still alive', undefined, 'm-1')).toBe(true)
  })

  it('defers incomplete assistant messages until final text is available', async () => {
    setChannelSession('telegram', 'chat-1', 'ses_1')
    const bridge = bridgeWithChannels(['telegram'])

    await bridge.initialize('ses_1', 'telegram', 'chat-1')
    messages.push({
      info: { id: 'a1', role: 'assistant', sessionID: 'ses_1', time: { created: 1_000_100 } },
      parts: [{ id: 'start-a1', type: 'step-start' }],
    })

    await bridge.syncOnce()
    messages[0] = message('a1', 'assistant', 'finished reply', 1_000_100)
    await bridge.syncOnce()

    expect(sent).toEqual([{ provider: 'telegram', chatId: 'chat-1', text: 'finished reply' }])
  })

  it('delivers replies back to the bound Telegram topic', async () => {
    setChannelSession('telegram', 'chat-1', 'ses_1', { threadId: 'topic-1' })
    const bridge = bridgeWithChannels(['telegram'])

    await bridge.initialize('ses_1', 'telegram', 'chat-1', 'topic-1')
    messages.push(message('a1', 'assistant', 'topic reply', 1_000_100))

    await bridge.syncOnce()

    expect(sent).toEqual([{ provider: 'telegram', chatId: 'chat-1', threadId: 'topic-1', text: 'topic reply' }])
  })

  it('does not persist pending inbound plaintext', () => {
    const bridge = bridgeWithChannels(['telegram'])

    bridge.recordInbound('ses_1', 'telegram', 'chat-1', 'sensitive customer note')

    const state = readChannelSyncStateForTest(stateFile)!
    expect(state.pendingInbound.some(row => typeof row.textHash === 'string' && row.textHash.length > 0)).toBe(true)
    expect(JSON.stringify(state)).not.toContain('sensitive customer note')
    for (const file of [stateFile, `${stateFile}.sqlite`, `${stateFile}.sqlite-wal`, `${stateFile}.sqlite-shm`]) {
      if (fs.existsSync(file)) expect(fs.readFileSync(file).includes(Buffer.from('sensitive customer note'))).toBe(false)
    }
  })

  it('does not persist delivered outbound plaintext in the durable outbox', async () => {
    const secretText = 'never-persist-this-unique-secret'
    setChannelSession('telegram', 'chat-1', 'ses_1')
    const bridge = bridgeWithChannels(['telegram'])

    await bridge.initialize('ses_1', 'telegram', 'chat-1')
    messages.push(message('a1', 'assistant', secretText, 1_000_100))
    await bridge.syncOnce()

    const rows = readOutboxRows()
    expect(rows).toEqual([
      expect.objectContaining({ status: 'delivered', text_hash: expect.any(String) }),
    ])
    expect(rows[0].text_hash).not.toBe(secretText)
    for (const file of [stateFile, `${stateFile}.sqlite`, `${stateFile}.sqlite-wal`, `${stateFile}.sqlite-shm`]) {
      if (fs.existsSync(file)) expect(fs.readFileSync(file).includes(Buffer.from(secretText))).toBe(false)
    }
  })

  it('backs off idle session transcript refetches and resumes on an activity signal', async () => {
    setChannelSession('telegram', 'chat-1', 'ses_1')
    let fetches = 0
    const bridge = new ChannelSyncBridge(
      { session: { messages: async () => { fetches++; return { data: messages } } } },
      new Map([['telegram', { sendMessage: async (chatId: string, text: string) => { sent.push({ provider: 'telegram', chatId, text }) } }]]),
      { stateFile, now: () => now },
    )
    await bridge.initialize('ses_1', 'telegram', 'chat-1')
    fetches = 0

    // First idle sync fetches and arms the backoff.
    await bridge.syncOnce()
    expect(fetches).toBe(1)

    // Within the backoff window the transcript is not refetched.
    await bridge.syncOnce()
    now += 3000
    await bridge.syncOnce()
    expect(fetches).toBe(1)

    // After the backoff elapses the session is polled again (and backs off further).
    now += 3100
    await bridge.syncOnce()
    expect(fetches).toBe(2)
    now += 3000
    await bridge.syncOnce()
    expect(fetches).toBe(2)

    // An activity signal resumes fast polling immediately and delivery works.
    messages.push(message('a1', 'assistant', 'reply after activity', now))
    bridge.notifySessionActivity('ses_1')
    await bridge.syncOnce()
    expect(fetches).toBe(3)
    expect(sent).toEqual([{ provider: 'telegram', chatId: 'chat-1', text: 'reply after activity' }])

    // A sync that saw unseen messages does not back off the next poll.
    await bridge.syncOnce()
    expect(fetches).toBe(4)
  })

  it('prunes settled outbox rows past retention while keeping pending deliveries', async () => {
    setChannelSession('telegram', 'chat-1', 'ses_1')
    const bridge = bridgeWithChannels(['telegram'])
    await bridge.initialize('ses_1', 'telegram', 'chat-1')
    messages.push(message('a1', 'assistant', 'settled reply', 1_000_100))
    await bridge.syncOnce()
    expect(readOutboxRows()).toEqual([expect.objectContaining({ status: 'delivered' })])

    // Seed an expired dead-letter row and a stale pending row alongside it.
    const db = new DatabaseSync(`${stateFile}.sqlite`)
    try {
      const staleIso = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString()
      const insert = db.prepare(`INSERT INTO channel_sync_outbox (
        id, session_id, provider, chat_id, thread_id, message_id, message_created, role, text_hash, status, attempts, created_at, updated_at, dead_lettered_at
      ) VALUES (?, 'ses_1', 'telegram', 'chat-1', '', ?, 1, 'assistant', 'hash', ?, 0, ?, ?, ?)`)
      insert.run('dead-old', 'm-dead', 'dead_letter', staleIso, staleIso, staleIso)
      insert.run('pending-old', 'm-pending', 'pending', staleIso, staleIso, null)
    } finally {
      db.close()
    }

    // Advance past both retention windows; the next sync runs maintenance.
    now += 31 * 24 * 60 * 60 * 1000
    await bridge.syncOnce()

    const rows = readOutboxRows()
    expect(rows).toEqual([expect.objectContaining({ status: 'pending' })])
  })

  it('stops admission and drains the current delivery before shutdown', async () => {
    setChannelSession('telegram', 'chat-1', 'ses_1')
    let releaseSend!: () => void
    let enteredSend!: () => void
    const entered = new Promise<void>(resolve => { enteredSend = resolve })
    const blocked = new Promise<void>(resolve => { releaseSend = resolve })
    const keys: string[] = []
    const bridge = new ChannelSyncBridge(
      { session: { messages: async () => ({ data: messages }) } },
      new Map([['telegram', {
        sendMessage: async (_chatId: string, _text: string, options?: { threadId?: string; idempotencyKey?: string }) => {
          keys.push(options?.idempotencyKey || '')
          enteredSend()
          await blocked
        },
      }]]),
      { stateFile, now: () => now },
    )
    await bridge.initialize('ses_1', 'telegram', 'chat-1')
    messages.push(message('a-drain', 'assistant', 'wait for delivery', now + 1))

    const sync = bridge.syncOnce()
    await entered
    let drained = false
    const stopping = bridge.stop().then(() => { drained = true })
    await bridge.syncOnce()
    await flushAsync()
    expect(drained).toBe(false)
    expect(keys).toHaveLength(1)

    releaseSend()
    await Promise.all([sync, stopping])
    expect(drained).toBe(true)
    expect(keys[0]).toMatch(/^[a-f0-9]{64}$/)
  })

  it('reconciles a provider receipt after lease expiry without resending', async () => {
    setChannelSession('telegram', 'chat-1', 'ses_1')
    const first = bridgeWithChannels(['telegram'], async () => { throw new Error('provider acknowledgement was interrupted') })
    await first.initialize('ses_1', 'telegram', 'chat-1')
    messages.push(message('a-receipt', 'assistant', 'receipt-backed delivery', now + 1))
    await first.syncOnce()

    const db = new DatabaseSync(`${stateFile}.sqlite`)
    try {
      db.prepare(`UPDATE channel_sync_outbox
        SET status = 'leased', lease_owner = 'crashed-writer', lease_expires_at = ?, provider_receipt_id = 'provider-123', provider_receipt_json = ?
        WHERE message_id = 'a-receipt'`).run(new Date(now - 1).toISOString(), JSON.stringify({ receiptId: 'provider-123' }))
    } finally {
      db.close()
    }

    let sends = 0
    const reconciled: string[] = []
    const second = new ChannelSyncBridge(
      { session: { messages: async () => ({ data: messages }) } },
      new Map([['telegram', {
        sendMessage: async () => { sends++ },
        reconcileDelivery: async (input: { receiptId: string }) => {
          reconciled.push(input.receiptId)
          return 'delivered' as const
        },
      } as any]]),
      { stateFile, now: () => now },
    )
    await second.syncOnce()

    expect(reconciled).toEqual(['provider-123'])
    expect(sends).toBe(0)
    expect(readOutboxRows()).toEqual([expect.objectContaining({ status: 'delivered' })])
  })

  function bridgeWithChannels(
    providers: string[],
    send: (provider: string, chatId: string, text: string, options?: { threadId?: string }) => Promise<void> = async (provider, chatId, text, options) => {
      sent.push({ provider, chatId, text, ...(options?.threadId ? { threadId: options.threadId } : {}) })
    },
  ): ChannelSyncBridge {
    const channels = new Map(providers.map(provider => [provider, {
      sendMessage: (chatId: string, text: string, options?: { threadId?: string }) => send(provider, chatId, text, options),
    }]))
    return new ChannelSyncBridge({ session: { messages: async () => ({ data: messages }) } }, channels, { stateFile, now: () => now })
  }

  function readOutboxRows(): any[] {
    const db = new DatabaseSync(`${stateFile}.sqlite`)
    try {
      return db.prepare('SELECT status, lease_owner, attempts, last_error, retry_after, dead_lettered_at, provider_error_kind, delivered_at, text_hash FROM channel_sync_outbox ORDER BY message_id').all()
    } finally {
      db.close()
    }
  }
})

function message(id: string, role: string, text: string, created: number) {
  return {
    info: { id, role, sessionID: 'ses_1', time: { created, completed: created + 1 } },
    parts: [{ id: `part-${id}`, type: 'text', text }],
  }
}

function flushAsync(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}
