import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { clearChannelSessionsForTest, setChannelSession } from '../channel-sessions.js'
import { notifyOpenCodeRequest } from '../daemon.js'
import { clearWorkStateForTest, createRoadmap, createWorkTask, listAlerts, listWorkEvents, startWorkTaskRun } from '../work-store.js'

describe('OpenCode request channel notifications', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-request-notifications-test-'))

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })
  const store = path.join(testDir, 'gateway.db')
  let sent: Array<{ provider: string; chatId: string; text?: string; structured?: any; threadId?: string }>

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    clearChannelSessionsForTest()
    clearWorkStateForTest(store)
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    sent = []
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
  })

  it('sends question notifications to directly bound channels', async () => {
    setChannelSession('telegram', 'chat-1', 'ses_question', { threadId: 'topic-1' })

    await notifyOpenCodeRequest({
      type: 'question.asked',
      payload: { properties: { id: 'q1', sessionID: 'ses_question', questions: [{ header: 'Choice', question: 'Pick one?', options: [{ label: 'A' }] }] } },
    }, channels())

    expect(sent).toEqual([{ provider: 'telegram', chatId: 'chat-1', threadId: 'topic-1', text: expect.stringContaining('Question: q1') }])
    expect(sent[0]!.text).toContain('Session: ses_question')
    expect(sent[0]!.text).toContain('Decision owner: OpenCode')
    expect(sent[0]!.text).toContain('Decision state: requires_open_code')
    expect(sent[0]!.text).toContain('Wait owner: OpenCode')
    expect(sent[0]!.text).toContain('Action route: OpenCode Web/TUI or a trusted channel bound to Session ses_question; Gateway forwards replies only.')
    expect(sent[0]!.text).toContain('Surface sync: Web/TUI=aligned')
    expect(sent[0]!.text).toContain('Trusted channel=aligned')
    expect(sent[0]!.text).toContain('Receipt owner: opencode_reply=required')
    expect(sent[0]!.text).toContain('Web/TUI recovery:')
    expect(sent[0]!.text).toContain('Gateway only forwards')
  })

  it('sends permission notifications to directly bound channels', async () => {
    setChannelSession('whatsapp', 'chat-2', 'ses_permission')

    await notifyOpenCodeRequest({
      type: 'permission.asked',
      payload: { properties: { id: 'p1', sessionID: 'ses_permission', permission: 'bash', patterns: ['npm test'], metadata: {}, always: [] } },
    }, channels())

    expect(sent).toEqual([{ provider: 'whatsapp', chatId: 'chat-2', text: expect.stringContaining('Permission: p1') }])
    expect(sent[0]!.text).toContain('Session: ses_permission')
    expect(sent[0]!.text).toContain('Risk: Runs shell commands')
    expect(sent[0]!.text).toContain('Decision owner: OpenCode')
    expect(sent[0]!.text).toContain('Wait owner: OpenCode')
    expect(sent[0]!.text).toContain('Action route: OpenCode Web/TUI or a trusted channel bound to Session ses_permission; Gateway forwards replies only.')
    expect(sent[0]!.text).toContain('Surface sync: Web/TUI=aligned')
    expect(sent[0]!.text).toContain('Trusted channel=aligned')
    expect(sent[0]!.text).toContain('Mission Control=aligned')
    expect(sent[0]!.text).toContain('Receipt owner: opencode_reply=required')
    expect(sent[0]!.text).toContain('Gateway does not bypass OpenCode')
  })

  it('uses structured question notifications with safe actions when the channel supports them', async () => {
    setChannelSession('telegram', 'chat-1', 'ses_question', { threadId: 'topic-1' })

    await notifyOpenCodeRequest({
      type: 'question.asked',
      payload: { properties: { id: 'q-rich', sessionID: 'ses_question', questions: [{ header: 'Choice', question: 'Pick one?', options: [{ label: 'A' }] }] } },
    }, structuredChannels())

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ provider: 'telegram', chatId: 'chat-1', threadId: 'topic-1' })
    expect(sent[0]!.text).toBeUndefined()
    expect(sent[0]!.structured).toMatchObject({
      title: 'Question required',
      status: 'pending',
      severity: 'warning',
      actions: expect.arrayContaining([
        expect.objectContaining({ label: 'A', command: '/answer q-rich A' }),
        expect.objectContaining({ label: 'Reject', command: '/reject-question q-rich' }),
      ]),
    })
    expect(sent[0]!.structured.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'facts',
        facts: expect.arrayContaining([
          expect.objectContaining({ label: 'Decision owner', value: 'OpenCode' }),
          expect.objectContaining({ label: 'Decision state', value: 'requires_open_code' }),
          expect.objectContaining({ label: 'Wait owner', value: 'OpenCode' }),
          expect.objectContaining({ label: 'Action route', value: 'OpenCode Web/TUI or a trusted channel bound to Session ses_question; Gateway forwards replies only.' }),
          expect.objectContaining({ label: 'Trusted channel', value: expect.stringContaining('aligned') }),
          expect.objectContaining({ label: 'Surface sync', value: expect.stringContaining('Web/TUI=aligned') }),
          expect.objectContaining({ label: 'Mission Control', value: expect.stringContaining('state=requires_open_code') }),
        ]),
      }),
      expect.objectContaining({
        type: 'details',
        title: 'Surface recovery',
        body: expect.stringContaining('Web/TUI: aligned; state=requires_open_code'),
      }),
      expect.objectContaining({
        type: 'details',
        title: 'Receipt ownership',
        body: expect.stringContaining('opencode_reply=required'),
      }),
    ]))
  })

  it('uses structured permission notifications with approve and deny actions when the channel supports them', async () => {
    setChannelSession('whatsapp', 'chat-2', 'ses_permission')

    await notifyOpenCodeRequest({
      type: 'permission.asked',
      payload: { properties: { id: 'p-rich', sessionID: 'ses_permission', permission: 'edit', patterns: ['src/**'], metadata: {}, always: [] } },
    }, structuredChannels())

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ provider: 'whatsapp', chatId: 'chat-2' })
    expect(sent[0]!.structured).toMatchObject({
      title: 'Permission required',
      actions: expect.arrayContaining([
        expect.objectContaining({ label: 'Approve once', command: '/approve p-rich once' }),
        expect.objectContaining({ label: 'Approve always', command: '/approve p-rich always' }),
        expect.objectContaining({ label: 'Deny', command: '/deny p-rich' }),
      ]),
    })
    expect(sent[0]!.structured.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'facts',
        facts: expect.arrayContaining([
          expect.objectContaining({ label: 'Decision owner', value: 'OpenCode' }),
          expect.objectContaining({ label: 'Wait owner', value: 'OpenCode' }),
          expect.objectContaining({ label: 'Action route', value: 'OpenCode Web/TUI or a trusted channel bound to Session ses_permission; Gateway forwards replies only.' }),
          expect.objectContaining({ label: 'Authority', value: expect.stringContaining('OpenCode owns permission enforcement') }),
          expect.objectContaining({ label: 'Surface sync', value: expect.stringContaining('CLI/MCP=aligned') }),
          expect.objectContaining({ label: 'Trusted channel', value: expect.stringContaining('aligned') }),
        ]),
      }),
      expect.objectContaining({
        type: 'details',
        title: 'Surface recovery',
        body: expect.stringContaining('Mission Control: aligned; state=requires_open_code'),
      }),
      expect.objectContaining({
        type: 'details',
        title: 'Receipt ownership',
        body: expect.stringContaining('gateway_notification=recorded_by_owner'),
      }),
    ]))
  })

  it('does not resend duplicate request notifications to the same target', async () => {
    setChannelSession('telegram', 'chat-1', 'ses_question', { threadId: 'topic-1' })
    const event = {
      type: 'question.asked',
      payload: { properties: { id: 'q1', sessionID: 'ses_question', questions: [{ header: 'Choice', question: 'Pick one?' }] } },
    }

    await notifyOpenCodeRequest(event, channels())
    await notifyOpenCodeRequest(event, channels())

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ provider: 'telegram', chatId: 'chat-1', threadId: 'topic-1' })
  })

  it('does not send concurrent duplicate request notifications to the same target', async () => {
    setChannelSession('telegram', 'chat-1', 'ses_question', { threadId: 'topic-1' })
    const event = {
      type: 'question.asked',
      payload: { properties: { id: 'q1', sessionID: 'ses_question', questions: [{ header: 'Choice', question: 'Pick one?' }] } },
    }
    let releaseSend!: () => void
    const sendGate = new Promise<void>(resolve => { releaseSend = resolve })
    const slowChannels = channels(async (provider, chatId, text, options) => {
      await sendGate
      sent.push({ provider, chatId, text, ...(options?.threadId ? { threadId: options.threadId } : {}) })
    })

    const first = notifyOpenCodeRequest(event, slowChannels)
    const second = notifyOpenCodeRequest(event, slowChannels)
    await flushAsync()
    expect(sent).toHaveLength(0)

    releaseSend()
    await Promise.all([first, second])

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ provider: 'telegram', chatId: 'chat-1', threadId: 'topic-1' })
  })

  it('does not mark failed request notifications as delivered and retries later', async () => {
    setChannelSession('telegram', 'chat-1', 'ses_question')
    const event = {
      type: 'question.asked',
      payload: { properties: { id: 'q1', sessionID: 'ses_question', questions: [{ header: 'Choice', question: 'Pick one?' }] } },
    }
    let fail = true

    await notifyOpenCodeRequest(event, channels(async () => {
      if (fail) throw new Error('HTTP 400 token=secret-token')
    }))
    fail = false
    await notifyOpenCodeRequest(event, channels())
    await notifyOpenCodeRequest(event, channels())

    expect(sent).toHaveLength(1)
    const events = listWorkEvents(50, store)
    expect(events.filter(row => row.type === 'opencode.request.notified')).toHaveLength(1)
    expect(events.find(row => row.type === 'opencode.request.notify_failed')?.payload['error']).toContain('token=<redacted>')
    const requestEvents = events.filter(row => row.type.startsWith('opencode.request.'))
    expect(JSON.stringify(requestEvents)).not.toContain('chat-1')
    expect(listAlerts({ status: 'open' }, store)).toContainEqual(expect.objectContaining({ source: 'opencode.requests', severity: 'warning' }))
  })

  it('falls back to task bindings and does not duplicate the same target', async () => {
    const roadmap = createRoadmap({ title: 'Notify task' }, store)
    const task = createWorkTask({ title: 'Bound task', roadmapId: roadmap.id }, store)
    const run = startWorkTaskRun(task.id, 'implement', 'ses_task_run', 'implementer', store)!.run
    setChannelSession('telegram', 'chat-3', run.sessionId, { mode: 'task', taskId: task.id })

    await notifyOpenCodeRequest({
      type: 'question.v2.asked',
      payload: { properties: { id: 'q2', sessionID: run.sessionId, questions: [{ header: 'Confirm', question: 'Continue?' }] } },
    }, channels())

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ provider: 'telegram', chatId: 'chat-3' })
    expect(sent[0]!.text).toContain('Question: q2')
  })

  it('falls back to roadmap bindings for task run requests', async () => {
    const roadmap = createRoadmap({ title: 'Notify roadmap' }, store)
    const task = createWorkTask({ title: 'Roadmap-bound task', roadmapId: roadmap.id }, store)
    const run = startWorkTaskRun(task.id, 'implement', 'ses_roadmap_run', 'implementer', store)!.run
    setChannelSession('whatsapp', 'chat-4', 'ses_roadmap_binding', { mode: 'roadmap', roadmapId: roadmap.id })

    await notifyOpenCodeRequest({
      type: 'permission.v2.asked',
      payload: { properties: { id: 'p2', sessionID: run.sessionId, permission: 'edit', patterns: ['src/**'], metadata: {}, always: [] } },
    }, channels())

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ provider: 'whatsapp', chatId: 'chat-4' })
    expect(sent[0]!.text).toContain('Permission: p2')
  })

  function channels(send?: (provider: string, chatId: string, text: string, options?: { threadId?: string }) => Promise<void>): Map<string, any> {
    return new Map(['telegram', 'whatsapp'].map(provider => [provider, {
      sendMessage: async (chatId: string, text: string, options?: { threadId?: string }) => {
        if (send) return send(provider, chatId, text, options)
        sent.push({ provider, chatId, text, ...(options?.threadId ? { threadId: options.threadId } : {}) })
      },
    }]))
  }

  function structuredChannels(): Map<string, any> {
    return new Map(['telegram', 'whatsapp'].map(provider => [provider, {
      sendMessage: async (chatId: string, text: string, options?: { threadId?: string }) => {
        sent.push({ provider, chatId, text, ...(options?.threadId ? { threadId: options.threadId } : {}) })
      },
      sendStructuredMessage: async (chatId: string, structured: any, options?: { threadId?: string }) => {
        sent.push({ provider, chatId, structured, ...(options?.threadId ? { threadId: options.threadId } : {}) })
      },
    }]))
  }
})

function flushAsync(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}
