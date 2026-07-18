import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { __telegramTest, telegramChannel } from '../channels/telegram.js'
import { CHANNEL_ACTION_TYPING_HEARTBEAT_MS, CHANNEL_ACTION_TYPING_TIMEOUT_MS, telegramNativeSlashCommandManifest } from '../channel-actions.js'
import { createChannelClaimCode } from '../channel-claims.js'
import {
  createStructuredMessage,
  gateApprovalCard,
  progressCard,
  runResultCard,
} from '../channels/renderer.js'
import { permissionRequestMessage, questionRequestMessage } from '../opencode-requests.js'
import { TransientInboundError, isTrustedChannelActor } from '../security.js'
import { clearConfigCacheForTest, getConfig, updateConfig } from '../config.js'
import { clearWorkStateForTest, listWorkEvents } from '../work-store.js'
import { clearEventsForTest, getQueuedEvents } from '../wakeup.js'

describe('telegram channel', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-telegram-test-'))

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    process.env['TELEGRAM_BOT_TOKEN'] = '123456:test-token'
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    clearConfigCacheForTest()
    clearWorkStateForTest(path.join(testDir, 'gateway.db'))
    clearEventsForTest()
    __telegramTest.resetTypingFailureThrottle()
    __telegramTest.resetPollingCursorForTest()
    __telegramTest.setTransientRetryBackoffForTest()
  })

  afterEach(async () => {
    await telegramChannel.stop()
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    delete process.env['TELEGRAM_BOT_TOKEN']
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    clearConfigCacheForTest()
    clearEventsForTest()
  })

  it('does not throw when startup verification fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down')
    }))

    await expect(telegramChannel.start()).resolves.toBeUndefined()

    const events = getQueuedEvents().join('\n')
    expect(events).toContain('Telegram startup failed: network down')
    expect(events).not.toContain('test-token')
  })

  it('redacts token-bearing Telegram API URLs from fetch errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('request to https://api.telegram.org/bot123456:test-token/getMe failed')
    }))

    await expect(telegramChannel.start()).resolves.toBeUndefined()

    const events = getQueuedEvents().join('\n')
    expect(events).toContain('https://api.telegram.org/bot[redacted]/getMe')
    expect(events).not.toContain('123456:test-token')
    expect(events).not.toContain('bot123456')
  })

  it('registers the native Telegram slash command menu at startup', async () => {
    const calls: Array<{ url: string; body: any }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const endpoint = String(url)
      calls.push({ url: endpoint, body: init?.body ? JSON.parse(String(init.body)) : {} })
      if (endpoint.includes('/getMe')) return new Response(JSON.stringify({ ok: true, result: { username: 'test_bot' } }), { status: 200 })
      if (endpoint.includes('/setMyCommands')) return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 })
      if (endpoint.includes('/getUpdates')) {
        await telegramChannel.stop()
        return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }))

    await telegramChannel.start()
    await vi.waitFor(() => expect(calls.some(call => call.url.includes('/setMyCommands'))).toBe(true))

    const commandCall = calls.find(call => call.url.includes('/setMyCommands'))!
    const manifest = telegramNativeSlashCommandManifest()
    expect(manifest.valid).toBe(true)
    expect(commandCall.body.commands).toHaveLength(manifest.commandCount)
    expect(manifest.argumentAutocomplete).toBe('deferred')
    expect(commandCall.body.commands).toEqual(expect.arrayContaining([
      { command: 'status', description: 'Show Channel binding and Issue queue status' },
      { command: 'project', description: 'Create, bind, inspect, and manage a Project' },
      { command: 'needs_attention', description: 'Alias for attention' },
      { command: 'reject_question', description: 'Reject an OpenCode question' },
    ]))
    expect(commandCall.body.commands.every((entry: any) => /^[a-z0-9_]{1,32}$/.test(entry.command))).toBe(true)
    expect(commandCall.body.commands.some((entry: any) => /[<[]/.test(entry.description))).toBe(false)
  })

  it('backs off native command registration while Telegram rate limit is active', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const endpoint = String(url)
      calls.push(endpoint)
      if (endpoint.includes('/getMe')) return new Response(JSON.stringify({ ok: true, result: { username: 'test_bot' } }), { status: 200 })
      if (endpoint.includes('/setMyCommands')) return new Response(JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 120', parameters: { retry_after: 120 } }), { status: 429 })
      if (endpoint.includes('/getUpdates')) {
        await telegramChannel.stop()
        return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }))

    await telegramChannel.start()
    await vi.waitFor(() => expect(calls.filter(call => call.includes('/setMyCommands'))).toHaveLength(1))
    await telegramChannel.stop()

    await telegramChannel.start()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(calls.filter(call => call.includes('/setMyCommands'))).toHaveLength(1)
    expect(getQueuedEvents().join('\n')).toContain('Telegram command menu registration degraded')
    expect(listWorkEvents(20).find(event => event.type === 'telegram.command_menu.registration.rate_limited')).toMatchObject({
      subjectId: 'telegram:commands',
      payload: expect.objectContaining({
        commandCount: expect.any(Number),
        retryUntil: expect.any(String),
      }),
    })
  })

  it('redacts the bot token from polling errors before they reach the service log', async () => {
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    })
    let updateCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const endpoint = String(url)
      if (endpoint.includes('/getMe')) return new Response(JSON.stringify({ ok: true, result: { username: 'test_bot' } }), { status: 200 })
      if (endpoint.includes('/setMyCommands')) return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 })
      if (endpoint.includes('/getUpdates')) {
        updateCalls++
        await telegramChannel.stop()
        // Simulate an HTTP-layer failure that carries the token-bearing request URL.
        throw new Error(`fetch failed for ${endpoint}`)
      }
      return new Response('{}', { status: 200 })
    }))

    await telegramChannel.start()
    await vi.waitFor(() => expect(errors.join('\n')).toContain('[telegram] polling error:'))

    expect(updateCalls).toBe(1)
    const logged = errors.join('\n')
    expect(logged).toContain('fetch failed for')
    expect(logged).not.toContain('test-token')
    expect(logged).not.toContain('123456:test-token')
    expect(logged).toContain('[redacted]')
  })

  it('persists the Telegram polling cursor and resumes from it after restart', async () => {
    updateConfig({ security: { channelAllowlists: { telegram: [{ chatId: 'chat-1' }], whatsapp: [], discord: [] } } } as any)
    const updateOffsets: string[] = []
    const handled: any[] = []
    telegramChannel.onMessage(async message => {
      handled.push(message)
      await telegramChannel.stop()
    })
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, _init?: RequestInit) => {
      const endpoint = String(url)
      if (endpoint.includes('/getMe')) return new Response(JSON.stringify({ ok: true, result: { username: 'test_bot' } }), { status: 200 })
      if (endpoint.includes('/setMyCommands')) return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 })
      if (endpoint.includes('/getUpdates')) {
        updateOffsets.push(new URL(endpoint).searchParams.get('offset') || '')
        if (updateOffsets.length === 1) {
          return new Response(JSON.stringify({
            ok: true,
            result: [{ update_id: 41, message: { message_id: 7, date: 1781452800, chat: { id: 'chat-1' }, text: '/status', from: { id: 9 } } }],
          }), { status: 200 })
        }
        await telegramChannel.stop()
        return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }))

    await telegramChannel.start()
    await vi.waitFor(() => expect(handled).toHaveLength(1))
    await telegramChannel.stop()

    const cursor = JSON.parse(fs.readFileSync(__telegramTest.pollingCursorPath(), 'utf-8'))
    expect(cursor).toMatchObject({ lastUpdateId: 41 })
    expect(JSON.stringify(cursor)).not.toContain('chat-1')
    expect(JSON.stringify(cursor)).not.toContain('/status')

    __telegramTest.resetInMemoryPollingCursorForTest()
    telegramChannel.onMessage(async () => {
      throw new Error('old updates should not replay')
    })

    await telegramChannel.start()
    await vi.waitFor(() => expect(updateOffsets).toContain('42'))

    expect(updateOffsets[0]).toBe('1')
    expect(updateOffsets.at(-1)).toBe('42')
  })

  it('retries a transiently failed update without advancing the polling cursor', async () => {
    updateConfig({ security: { channelAllowlists: { telegram: [{ chatId: 'chat-1', userIds: ['9'] }], whatsapp: [], discord: [] } } } as any)
    __telegramTest.setTransientRetryBackoffForTest(5)
    const handled: string[] = []
    const updateOffsets: string[] = []
    let attempts = 0
    telegramChannel.onMessage(async message => {
      attempts++
      // First delivery fails transiently (OpenCode restarting); the retry succeeds.
      if (attempts === 1) throw new TransientInboundError('bound channel session check failed transiently')
      handled.push(message.text)
    })
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const endpoint = String(url)
      if (endpoint.includes('/getMe')) return new Response(JSON.stringify({ ok: true, result: { username: 'test_bot' } }), { status: 200 })
      if (endpoint.includes('/setMyCommands')) return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 })
      if (endpoint.includes('/getUpdates')) {
        const offset = new URL(endpoint).searchParams.get('offset') || ''
        updateOffsets.push(offset)
        if (offset === '1') {
          return new Response(JSON.stringify({
            ok: true,
            result: [{ update_id: 61, message: { message_id: 7, date: 1781452800, chat: { id: 'chat-1' }, text: 'retry me after the outage', from: { id: 9 } } }],
          }), { status: 200 })
        }
        await telegramChannel.stop()
        return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }))

    await telegramChannel.start()
    await vi.waitFor(() => expect(handled).toEqual(['retry me after the outage']))
    await vi.waitFor(() => expect(updateOffsets.at(-1)).toBe('62'))
    await telegramChannel.stop()

    // The transient failure re-fetched the same offset instead of advancing.
    expect(attempts).toBe(2)
    expect(updateOffsets.filter(offset => offset === '1').length).toBeGreaterThanOrEqual(2)
    const cursor = JSON.parse(fs.readFileSync(__telegramTest.pollingCursorPath(), 'utf-8'))
    expect(cursor).toMatchObject({ lastUpdateId: 61 })
    // Transient deferrals are retried, never skipped as poison.
    expect(listWorkEvents(20).some(event => event.type === 'telegram.update.skipped')).toBe(false)
    expect(getQueuedEvents().join('\n')).not.toContain('failed and was skipped')
  })

  it('merges the claimant into a legacy trusted group rule so their free text flows again', async () => {
    updateConfig({ security: { channelAllowlists: { telegram: [{ chatId: '-100555666' }], whatsapp: [], discord: [] } } } as any)
    const claim = createChannelClaimCode({ provider: 'telegram', ttlMs: 60_000 })
    const handled: string[] = []
    telegramChannel.onMessage(async message => { handled.push(message.text) })

    // Legacy group rule with no userIds: members fail the free-text actor gate.
    expect(isTrustedChannelActor({ provider: 'telegram', chatId: '-100555666', userId: '777' }, getConfig()).allowed).toBe(false)

    await __telegramTest.handleInboundMessage(
      { update_id: 1 },
      { message_id: 99, date: 1781452800, chat: { id: -100555666 }, text: claim.code, from: { id: 777 } },
      claim.code,
    )

    expect(handled).toEqual([])
    expect(getConfig().security.channelAllowlists.telegram).toEqual([{ chatId: '-100555666', userIds: ['777'] }])
    expect(isTrustedChannelActor({ provider: 'telegram', chatId: '-100555666', userId: '777' }, getConfig()).allowed).toBe(true)
    const queued = getQueuedEvents().join('\n')
    expect(queued).toContain('Telegram claim accepted: telegram:target:')
    expect(queued).not.toContain('-100555666')
  })

  it('advances the polling cursor past a poisoned update and keeps processing later updates', async () => {
    updateConfig({ security: { channelAllowlists: { telegram: [{ chatId: 'chat-1' }], whatsapp: [], discord: [] } } } as any)
    const handled: string[] = []
    const updateOffsets: string[] = []
    telegramChannel.onMessage(async message => {
      if (message.text === '/poison') throw new Error('HTTP 403: bot was blocked by the user')
      handled.push(message.text)
    })
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const endpoint = String(url)
      if (endpoint.includes('/getMe')) return new Response(JSON.stringify({ ok: true, result: { username: 'test_bot' } }), { status: 200 })
      if (endpoint.includes('/setMyCommands')) return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 })
      if (endpoint.includes('/getUpdates')) {
        updateOffsets.push(new URL(endpoint).searchParams.get('offset') || '')
        if (updateOffsets.length === 1) {
          return new Response(JSON.stringify({
            ok: true,
            result: [
              { update_id: 51, message: { message_id: 7, date: 1781452800, chat: { id: 'chat-1' }, text: '/poison', from: { id: 9 } } },
              { update_id: 52, message: { message_id: 8, date: 1781452801, chat: { id: 'chat-1' }, text: 'hello after poison', from: { id: 9 } } },
            ],
          }), { status: 200 })
        }
        await telegramChannel.stop()
        return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }))

    await telegramChannel.start()
    await vi.waitFor(() => expect(handled).toEqual(['hello after poison']))
    await vi.waitFor(() => expect(updateOffsets.at(-1)).toBe('53'))
    await telegramChannel.stop()

    const cursor = JSON.parse(fs.readFileSync(__telegramTest.pollingCursorPath(), 'utf-8'))
    expect(cursor).toMatchObject({ lastUpdateId: 52 })
    expect(listWorkEvents(20)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'telegram.update.skipped',
        payload: expect.objectContaining({ updateId: 51 }),
      }),
    ]))
    expect(getQueuedEvents().join('\n')).toContain('Telegram inbound update 51 failed and was skipped')
  })

  it('falls back to plain text when markdown send fails', async () => {
    const calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body || '{}')))
      return new Response('{}', { status: calls.length === 1 ? 400 : 200 })
    }))

    await telegramChannel.sendMessage('chat-1', '*not markdown safe')

    expect(calls).toHaveLength(2)
    expect(calls[0].parse_mode).toBe('Markdown')
    expect(calls[1].parse_mode).toBeUndefined()
  })

  it('logs bounded send failures without leaking the token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad request', { status: 400 })))

    await expect(telegramChannel.sendMessage('chat-1', 'hello')).rejects.toThrow('HTTP 400')

    const events = getQueuedEvents().join('\n')
    expect(events).toContain('Telegram send failed: HTTP 400: bad request')
    expect(events).not.toContain('test-token')
  })

  it('surfaces chat-not-found as a hard target failure without fallback sends', async () => {
    const calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body || '{}')))
      return new Response('Bad Request: chat not found', { status: 400 })
    }))

    await expect(telegramChannel.sendMessage('chat-missing', 'hello')).rejects.toThrow('HTTP 400: Bad Request: chat not found')

    expect(calls).toHaveLength(1)
    expect(getQueuedEvents().join('\n')).toContain('Telegram send failed: HTTP 400: Bad Request: chat not found')
  })

  it('sends structured messages through sendRichMessage when enabled', async () => {
    const calls: Array<{ url: string; body: any }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body || '{}')) })
      return new Response('{}', { status: 200 })
    }))

    await telegramChannel.sendStructuredMessage?.('chat-1', progressCard({
      title: 'Gateway status',
      status: 'ready',
      summary: 'All systems nominal',
      facts: [{ label: 'Queue', value: '2 running' }],
      actions: [
        { label: 'Open runbook', url: 'https://example.com/runbook', style: 'primary' },
        { label: 'Copy status', command: '/status' },
      ],
    }), { threadId: '42' })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain('/sendRichMessage')
    expect(calls[0]!.body.message_thread_id).toBe('42')
    expect(calls[0]!.body.rich_message.html).toContain('<h2>Gateway status</h2>')
    expect(calls[0]!.body.rich_message.html).toContain('<b>Status:</b> ready')
    expect(calls[0]!.body.rich_message.skip_entity_detection).toBe(true)
    expect(calls[0]!.body.reply_markup.inline_keyboard[0][0]).toMatchObject({ text: 'Open runbook', url: 'https://example.com/runbook', style: 'primary' })
    expect(calls[0]!.body.reply_markup.inline_keyboard[0][1]).toMatchObject({ text: 'Copy status', callback_data: '/status' })
  })

  it('renders rich Telegram payloads for core workflow cards', async () => {
    const calls: Array<{ url: string; body: any }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body || '{}')) })
      return new Response('{}', { status: 200 })
    }))

    await telegramChannel.sendStructuredMessage?.('chat-1', progressCard({
      title: 'Roadmap progress',
      status: 'running',
      currentStep: 'Verify release contract',
      completed: 3,
      total: 5,
      percent: 60,
      steps: [
        { label: 'Implement renderer', status: 'done' },
        { label: 'Verify release contract', status: 'running' },
      ],
      nextAction: 'Finish focused channel tests',
      actions: [{ label: 'Copy status', command: '/status', style: 'primary' }],
    }))
    await telegramChannel.sendStructuredMessage?.('chat-1', gateApprovalCard({
      gateId: 'gate_1',
      title: 'Approve production deploy',
      reason: 'The release is staged and needs operator approval.',
      taskId: 'task_1',
      stage: 'deploy',
      approveCommand: '/gate approve gate_1 once',
      rejectCommand: '/gate reject gate_1',
    }))
    await telegramChannel.sendStructuredMessage?.('chat-1', runResultCard({
      runId: 'run_1',
      title: 'Verification finished',
      status: 'passed',
      stage: 'verify',
      summary: 'All required checks passed.',
      sessionId: 'ses_1',
      metrics: [{ label: 'Tests', value: '42 passed' }],
      nextAction: 'Open a draft PR',
      actions: [{ label: 'Open logs', url: 'https://example.com/logs' }],
    }))

    expect(calls).toHaveLength(3)
    expect(calls.every(call => call.url.includes('/sendRichMessage'))).toBe(true)

    const [progress, gate, run] = calls.map(call => call.body)
    expect(progress.rich_message.html).toContain('<h2>Roadmap progress</h2>')
    expect(progress.rich_message.html).toContain('<b>Status:</b> running')
    expect(progress.rich_message.html).toContain('<b>Current step:</b> Verify release contract')
    expect(progress.rich_message.html).toContain('<b>Next action:</b> Finish focused channel tests')
    expect(progress.rich_message.html).toContain('<table><tr><th>Step</th><th>Status</th></tr>')
    expect(progress.reply_markup.inline_keyboard[0][0]).toMatchObject({ text: 'Copy status', callback_data: '/status', style: 'primary' })

    expect(gate.rich_message.html).toContain('<h2>Approve production deploy</h2>')
    expect(gate.rich_message.html).toContain('<b>Status:</b> approval_required')
    expect(gate.rich_message.html).toContain('<b>Severity:</b> warning')
    expect(gate.rich_message.html).toContain('The release is staged and needs operator approval.')
    expect(gate.rich_message.html).toContain('<b>Gate:</b> gate_1')
    expect(gate.rich_message.html).toContain('<b>Next action:</b> Review the request and choose Approve once or Reject.')
    expect(gate.reply_markup.inline_keyboard[0][0]).toMatchObject({ text: 'Approve once', callback_data: '/gate approve gate_1 once', style: 'primary' })
    expect(gate.reply_markup.inline_keyboard[0][1]).toMatchObject({ text: 'Reject', callback_data: '/gate reject gate_1', style: 'danger' })

    expect(run.rich_message.html).toContain('<h2>Verification finished</h2>')
    expect(run.rich_message.html).toContain('<b>Status:</b> passed')
    expect(run.rich_message.html).toContain('<b>Run:</b> run_1')
    expect(run.rich_message.html).toContain('<b>Tests:</b> 42 passed')
    expect(run.rich_message.html).toContain('<b>Next action:</b> Open a draft PR')
    expect(run.reply_markup.inline_keyboard[0][0]).toMatchObject({ text: 'Open logs', url: 'https://example.com/logs' })
  })

  it('renders OpenCode permission and question cards with safe Telegram actions', async () => {
    const calls: Array<{ url: string; body: any }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body || '{}')) })
      return new Response('{}', { status: 200 })
    }))

    await telegramChannel.sendStructuredMessage?.('chat-1', permissionRequestMessage({
      id: 'perm_1',
      sessionID: 'ses_permission',
      permission: 'bash',
      patterns: ['npm test'],
      metadata: {},
      always: [],
    }))
    await telegramChannel.sendStructuredMessage?.('chat-1', questionRequestMessage({
      id: 'question_1',
      sessionID: 'ses_question',
      questions: [{ header: 'Choice', question: 'Pick one?', options: [{ label: 'A' }, { label: 'B', description: 'Second option' }] }],
    }))

    expect(calls).toHaveLength(2)
    expect(calls.every(call => call.url.includes('/sendRichMessage'))).toBe(true)
    expect(calls[0]!.body.rich_message.html).toContain('<h2>Permission required</h2>')
    expect(calls[0]!.body.rich_message.html).toContain('<b>Risk:</b> Runs shell commands in the Session environment.')
    expect(calls[0]!.body.reply_markup.inline_keyboard.flat()).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'Approve once', callback_data: '/approve perm_1 once', style: 'primary' }),
      expect.objectContaining({ text: 'Approve always', callback_data: '/approve perm_1 always' }),
      expect.objectContaining({ text: 'Deny', callback_data: '/deny perm_1', style: 'danger' }),
    ]))
    expect(calls[1]!.body.rich_message.html).toContain('<h2>Question required</h2>')
    expect(calls[1]!.body.rich_message.html).toContain('<details><summary>Question details</summary>')
    expect(calls[1]!.body.reply_markup.inline_keyboard.flat()).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'A', callback_data: '/answer question_1 A', style: 'primary' }),
      expect.objectContaining({ text: 'B', callback_data: '/answer question_1 B', style: 'primary' }),
      expect.objectContaining({ text: 'Reject', callback_data: '/reject-question question_1', style: 'danger' }),
    ]))
    expect(JSON.stringify(calls.map(call => call.body))).not.toContain('test-token')
  })

  it('falls back to sendMessage when rich messages are disabled globally', async () => {
    updateConfig({ channels: { richMessages: { enabled: false } } } as any)
    const calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body || '{}')))
      return new Response('{}', { status: 200 })
    }))

    expect(telegramChannel.capabilities?.richBlocks).toBe(false)
    await telegramChannel.sendStructuredMessage?.('chat-1', progressCard({ title: 'Gateway status', status: 'ready' }))

    expect(calls).toHaveLength(1)
    expect(calls[0].text).toContain('## Gateway status')
    expect(calls[0].parse_mode).toBe('Markdown')
  })

  it('falls back to sendMessage when rich messages are disabled for Telegram', async () => {
    updateConfig({ channels: { telegram: { richMessages: { enabled: false } } } } as any)
    const calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body || '{}')))
      return new Response('{}', { status: 200 })
    }))

    expect(telegramChannel.capabilities?.richBlocks).toBe(false)
    await telegramChannel.sendStructuredMessage?.('chat-1', progressCard({ title: 'Gateway status', status: 'ready' }))

    expect(calls[0].text).toContain('## Gateway status')
  })

  it('falls back to sendMessage when Telegram rejects rich payloads', async () => {
    const calls: Array<{ url: string; body: any }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body || '{}')) })
      return new Response(calls.length === 1 ? 'rich rejected' : '{}', { status: calls.length === 1 ? 400 : 200 })
    }))

    await telegramChannel.sendStructuredMessage?.('chat-1', progressCard({ title: 'Gateway status', status: 'ready' }))

    expect(calls).toHaveLength(2)
    expect(calls[0]!.url).toContain('/sendRichMessage')
    expect(calls[1]!.url).toContain('/sendMessage')
    expect(calls[1]!.body.text).toContain('## Gateway status')
    expect(getQueuedEvents().join('\n')).toContain('Telegram rich send degraded: rich rejected')
  })

  it('surfaces chat-not-found rich sends as hard target failures', async () => {
    const calls: Array<{ url: string; body: any }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body || '{}')) })
      return new Response('Bad Request: chat not found', { status: 400 })
    }))

    await expect(telegramChannel.sendStructuredMessage?.('chat-missing', progressCard({ title: 'Gateway status', status: 'ready' }))).rejects.toThrow('HTTP 400: Bad Request: chat not found')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain('/sendRichMessage')
    expect(getQueuedEvents().join('\n')).toContain('Telegram rich send failed: HTTP 400: Bad Request: chat not found')
    expect(getQueuedEvents().join('\n')).not.toContain('Telegram rich send degraded')
  })

  it('escapes rich text and redacts bot tokens', async () => {
    const calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body || '{}')))
      return new Response('{}', { status: 200 })
    }))

    await telegramChannel.sendStructuredMessage?.('chat-1', createStructuredMessage({
      kind: 'generic',
      title: 'Escaping',
      blocks: [
        { type: 'heading', text: '5 < 6 & token 123456:test-token', level: 2 },
        { type: 'text', text: 'Use <b>literal</b> & keep safe' },
      ],
    }))

    const html = calls[0].rich_message.html
    expect(html).toContain('5 &lt; 6 &amp; token [redacted]')
    expect(html).toContain('Use &lt;b&gt;literal&lt;/b&gt; &amp; keep safe')
    expect(html).not.toContain('test-token')
  })

  it('falls back for unsupported media and long rich messages', async () => {
    const calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body || '{}')))
      return new Response('{}', { status: 200 })
    }))

    await telegramChannel.sendStructuredMessage?.('chat-1', createStructuredMessage({
      kind: 'generic',
      title: 'Unsafe media',
      blocks: [{ type: 'media', url: 'file:///tmp/secret.png', alt: 'Secret file' }],
    }))
    await telegramChannel.sendStructuredMessage?.('chat-1', createStructuredMessage({
      kind: 'generic',
      title: 'Long message',
      blocks: [{ type: 'text', text: 'x'.repeat(33000) }],
    }))

    expect(calls).toHaveLength(2)
    expect(calls.every(call => call.text)).toBe(true)
    expect(calls[0].text).toContain('Secret file')
    expect(calls.at(-1).text.length).toBeLessThanOrEqual(4000)
    expect(calls.at(-1).text).toContain('... truncated')
  })

  it('uses copy-text actions when command payloads exceed Telegram callback limits', async () => {
    const calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body || '{}')))
      return new Response('{}', { status: 200 })
    }))

    const longCommand = `/task retry ${'task_'.repeat(20)}`
    await telegramChannel.sendStructuredMessage?.('chat-1', progressCard({
      title: 'Long action',
      status: 'ready',
      actions: [{ label: 'Retry with note', command: longCommand }],
    }))

    expect(calls[0].reply_markup.inline_keyboard[0][0]).toMatchObject({ text: 'Retry with note', copy_text: { text: longCommand } })
    expect(calls[0].reply_markup.inline_keyboard[0][0].callback_data).toBeUndefined()
  })

  it('normalizes Telegram callback actions into trusted channel messages', async () => {
    updateConfig({ security: { channelAllowlists: { telegram: [{ chatId: 'chat-1', threadId: '42' }] } } } as any)
    const calls: Array<{ url: string; body: any }> = []
    const handled: any[] = []
    telegramChannel.onMessage(async message => {
      handled.push(message)
      await telegramChannel.stop()
    })
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const endpoint = String(url)
      calls.push({ url: endpoint, body: init?.body ? JSON.parse(String(init.body)) : {} })
      if (endpoint.includes('/getMe')) return new Response(JSON.stringify({ ok: true, result: { username: 'test_bot' } }), { status: 200 })
      if (endpoint.includes('/getUpdates')) {
        return new Response(JSON.stringify({
          ok: true,
          result: [{
            update_id: 1,
            callback_query: {
              id: 'callback-1',
              from: { id: 7 },
              data: '/gate approve gate_1 once',
              message: { message_id: 99, date: 1781452800, chat: { id: 'chat-1' }, message_thread_id: 42 },
            },
          }],
        }), { status: 200 })
      }
      if (endpoint.includes('/answerCallbackQuery')) {
        expect(JSON.parse(String(init?.body || '{}'))).toEqual({ callback_query_id: 'callback-1' })
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }))

    await telegramChannel.start()
    await vi.waitFor(() => expect(handled).toHaveLength(1))

    expect(handled[0]).toMatchObject({
      provider: 'telegram',
      chatId: 'chat-1',
      threadId: '42',
      messageId: 'callback-1',
      userId: '7',
      text: '/gate approve gate_1 once',
      timestamp: '2026-06-14T16:00:00.000Z',
    })
    const typingCallIndex = calls.findIndex(call => call.url.includes('/sendChatAction'))
    const ackCallIndex = calls.findIndex(call => call.url.includes('/answerCallbackQuery'))
    expect(typingCallIndex).toBeGreaterThanOrEqual(0)
    expect(ackCallIndex).toBeGreaterThan(typingCallIndex)
    expect(calls[typingCallIndex]!.body).toEqual({
      chat_id: 'chat-1',
      message_thread_id: '42',
      action: 'typing',
    })
    expect(calls[ackCallIndex]!.body).toEqual({ callback_query_id: 'callback-1' })
  })

  it('shows Telegram typing feedback while trusted inbound work is handled', async () => {
    updateConfig({ security: { channelAllowlists: { telegram: [{ chatId: 'chat-1', threadId: '42' }] } } } as any)
    const calls: Array<{ url: string; body: any }> = []
    const handled: any[] = []
    telegramChannel.onMessage(async message => {
      handled.push(message)
    })
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body || '{}')) })
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 })
    }))

    await __telegramTest.handleInboundMessage(
      { update_id: 1 },
      { message_id: 99, date: 1781452800, chat: { id: 'chat-1' }, message_thread_id: 42, text: '/status', from: { id: 7 } },
      '/status',
    )

    expect(handled).toHaveLength(1)
    const typingCall = calls.find(call => call.url.includes('/sendChatAction'))
    expect(typingCall?.body).toEqual({
      chat_id: 'chat-1',
      message_thread_id: '42',
      action: 'typing',
    })
  })

  it('stops Telegram typing feedback after the bounded presence timeout', async () => {
    vi.useFakeTimers()
    try {
      updateConfig({ security: { channelAllowlists: { telegram: [{ chatId: 'chat-1' }] } } } as any)
      const calls: Array<{ url: string; body: any }> = []
      let release!: () => void
      telegramChannel.onMessage(async () => {
        await new Promise<void>(resolve => { release = resolve })
      })
      vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body || '{}')) })
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 })
      }))

      const run = __telegramTest.handleInboundMessage(
        { update_id: 1 },
        { message_id: 99, date: 1781452800, chat: { id: 'chat-1' }, text: '/status', from: { id: 7 } },
        '/status',
      )
      await vi.waitFor(() => expect(calls.filter(call => call.url.includes('/sendChatAction')).length).toBeGreaterThan(0))

      await vi.advanceTimersByTimeAsync(CHANNEL_ACTION_TYPING_TIMEOUT_MS + CHANNEL_ACTION_TYPING_HEARTBEAT_MS)
      const finalTypingCount = calls.filter(call => call.url.includes('/sendChatAction')).length
      await vi.advanceTimersByTimeAsync(CHANNEL_ACTION_TYPING_HEARTBEAT_MS * 3)

      expect(calls.filter(call => call.url.includes('/sendChatAction'))).toHaveLength(finalTypingCount)
      release()
      await run
    } finally {
      vi.useRealTimers()
    }
  })

  it('handles trusted inbound work without typing feedback when no token is available', async () => {
    delete process.env['TELEGRAM_BOT_TOKEN']
    updateConfig({ security: { channelAllowlists: { telegram: [{ chatId: 'chat-1' }] } } } as any)
    const handled: any[] = []
    telegramChannel.onMessage(async message => {
      handled.push(message)
    })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    await __telegramTest.handleInboundMessage(
      { update_id: 1 },
      { message_id: 99, date: 1781452800, chat: { id: 'chat-1' }, text: '/status', from: { id: 7 } },
      '/status',
    )

    expect(handled).toHaveLength(1)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('keeps trusted inbound work flowing when Telegram typing feedback fails', async () => {
    updateConfig({ security: { channelAllowlists: { telegram: [{ chatId: 'chat-1' }] } } } as any)
    const handled: any[] = []
    telegramChannel.onMessage(async message => {
      handled.push(message)
    })
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('chat action down')
    }))

    await __telegramTest.handleInboundMessage(
      { update_id: 1 },
      { message_id: 99, date: 1781452800, chat: { id: 'chat-1' }, text: '/status', from: { id: 7 } },
      '/status',
    )

    expect(handled).toHaveLength(1)
    expect(getQueuedEvents().join('\n')).toContain('Telegram typing feedback degraded: chat action down')
  })

  it('reports Telegram typing HTTP failures without blocking trusted inbound work', async () => {
    updateConfig({ security: { channelAllowlists: { telegram: [{ chatId: 'chat-1' }] } } } as any)
    const handled: any[] = []
    telegramChannel.onMessage(async message => {
      handled.push(message)
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Bad Request: chat not found', { status: 400 })))

    await __telegramTest.handleInboundMessage(
      { update_id: 1 },
      { message_id: 99, date: 1781452800, chat: { id: 'chat-1' }, text: '/status', from: { id: 7 } },
      '/status',
    )

    expect(handled).toHaveLength(1)
    const queued = getQueuedEvents().join('\n')
    expect(queued).toContain('Telegram typing feedback degraded: HTTP 400')
    expect(queued).toContain('Bad Request: chat not found')
  })

  it('accepts a Telegram claim code before ordinary trust checks without forwarding context', async () => {
    updateConfig({ security: { channelAllowlists: { telegram: [], whatsapp: [], discord: [] } } } as any)
    const claim = createChannelClaimCode({ provider: 'telegram', ttlMs: 60_000 })
    const handled: any[] = []
    telegramChannel.onMessage(async message => {
      handled.push(message)
    })

    await __telegramTest.handleInboundMessage(
      { update_id: 1 },
      { message_id: 99, date: 1781452800, chat: { id: 'claim-chat' }, text: claim.code },
      claim.code,
    )

    expect(handled).toEqual([])
    expect(getConfig().security.channelAllowlists.telegram).toEqual([{ chatId: 'claim-chat' }])
    expect(getQueuedEvents().join('\n')).toContain('Telegram claim accepted: telegram:target:')
    expect(getQueuedEvents().join('\n')).not.toContain('claim-chat')
    expect(listWorkEvents(20).some(event => event.type === 'audit.security' && event.payload['operation'] === 'channel.inbound')).toBe(false)
  })

  it('accepts a one-shot Telegram denial probe from a trusted chat without forwarding context', async () => {
    updateConfig({ security: { channelAllowlists: { telegram: [{ chatId: 'trusted-chat' }], whatsapp: [], discord: [] } } } as any)
    const claim = createChannelClaimCode({ provider: 'telegram', action: 'prove_denial', ttlMs: 60_000 })
    const handled: any[] = []
    telegramChannel.onMessage(async message => {
      handled.push(message)
    })

    await __telegramTest.handleInboundMessage(
      { update_id: 1 },
      { message_id: 99, date: 1781452800, chat: { id: 'trusted-chat' }, text: claim.code, from: { id: 7 } },
      claim.code,
    )

    expect(handled).toEqual([])
    expect(getConfig().security.channelAllowlists.telegram).toEqual([{ chatId: 'trusted-chat' }])
    const queued = getQueuedEvents().join('\n')
    expect(queued).toContain('Telegram denial probe accepted: telegram:target:')
    expect(queued).not.toContain('trusted-chat')
    const audit = listWorkEvents(20).find(event => event.type === 'audit.security' && event.payload['operation'] === 'channel.inbound')
    expect(audit).toMatchObject({
      subjectId: expect.stringContaining('telegram:target:'),
      payload: {
        actor: 'telegram',
        source: expect.stringContaining('telegram:target:'),
        operation: 'channel.inbound',
        target: expect.stringContaining('telegram:target:'),
        result: 'denied',
        details: expect.objectContaining({
          provider: 'telegram',
          action: 'prove_denial',
          reason: 'operator_denial_probe',
          evidence: 'provider-native',
          redacted: true,
        }),
      },
    })
    const serialized = JSON.stringify(listWorkEvents(20))
    expect(serialized).not.toContain('trusted-chat')
    expect(serialized).not.toContain(claim.code)
  })

  it('allows Telegram setup commands before trust but keeps stateful commands blocked', async () => {
    updateConfig({ security: { channelAllowlists: { telegram: [{ chatId: 'trusted-chat' }], whatsapp: [], discord: [] } } } as any)
    const handled: string[] = []
    telegramChannel.onMessage(async message => {
      handled.push(message.text)
    })

    await __telegramTest.handleInboundMessage(
      { update_id: 1 },
      { message_id: 99, date: 1781452800, chat: { id: 'private-chat-id' }, text: '/start', from: { id: 7 } },
      '/start',
    )
    await __telegramTest.handleInboundMessage(
      { update_id: 2 },
      { message_id: 100, date: 1781452801, chat: { id: 'private-chat-id' }, text: '/status', from: { id: 7 } },
      '/status',
    )

    expect(handled).toEqual(['/start'])
    const queued = getQueuedEvents().join('\n')
    expect(queued).toContain('Telegram rejected untrusted inbound: telegram:target:')
    expect(queued).not.toContain('private-chat-id')
    const serialized = JSON.stringify(listWorkEvents(20))
    expect(serialized).not.toContain('/start')
    expect(serialized).not.toContain('/status')
  })

  it('records provider-native redacted audit evidence for untrusted Telegram inbound', async () => {
    updateConfig({ security: { channelAllowlists: { telegram: [{ chatId: 'trusted-chat' }], whatsapp: [], discord: [] } } } as any)
    const handled: any[] = []
    telegramChannel.onMessage(async message => {
      handled.push(message)
    })

    await __telegramTest.handleInboundMessage(
      { update_id: 1 },
      { message_id: 99, date: 1781452800, chat: { id: 'private-chat-id' }, message_thread_id: 42, text: 'private probe token=secret', from: { id: 7 } },
      'private probe token=secret',
    )

    expect(handled).toEqual([])
    const queued = getQueuedEvents().join('\n')
    expect(queued).toContain('Telegram rejected untrusted inbound: telegram:target:')
    expect(queued).not.toContain('private-chat-id')
    const audit = listWorkEvents(20).find(event => event.type === 'audit.security' && event.payload['operation'] === 'channel.inbound')
    expect(audit).toMatchObject({
      subjectId: expect.stringContaining('telegram:target:'),
      payload: {
        actor: 'telegram',
        source: expect.stringContaining('telegram:target:'),
        operation: 'channel.inbound',
        target: expect.stringContaining('telegram:target:'),
        result: 'denied',
        details: expect.objectContaining({
          provider: 'telegram',
          reason: 'untrusted_target',
          evidence: 'provider-native',
          redacted: true,
        }),
      },
    })
    const serialized = JSON.stringify(listWorkEvents(20))
    expect(serialized).not.toContain('private-chat-id')
    expect(serialized).not.toContain('private probe')
    expect(serialized).not.toContain('token=secret')
  })
})
