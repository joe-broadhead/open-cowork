import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { clearChannelSession, clearChannelSessionsForTest, getChannelSession, listChannelSessions, setChannelSession } from '../channel-sessions.js'
import { createRoadmap, createWorkTask } from '../work-store.js'

describe('channel sessions', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-channel-sessions-test-'))

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    clearChannelSessionsForTest()
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
  })

  it('stores chat-to-session mappings by provider', () => {
    setChannelSession('whatsapp', 'chat-1', 'ses_1')
    setChannelSession('telegram', 'chat-1', 'ses_2')

    expect(getChannelSession('whatsapp', 'chat-1')).toBe('ses_1')
    expect(getChannelSession('telegram', 'chat-1')).toBe('ses_2')
  })

  it('links Telegram and WhatsApp targets to the same durable session', () => {
    setChannelSession('telegram', 'tg-chat', 'ses_shared', { title: 'Durable work' })
    setChannelSession('whatsapp', 'wa-chat', 'ses_shared', { title: 'Durable work' })

    expect(listChannelSessions({ sessionId: 'ses_shared' }).map(link => `${link.provider}:${link.chatId}`).sort()).toEqual(['telegram:tg-chat', 'whatsapp:wa-chat'])
  })

  it('stores thread-specific binding metadata in SQLite', () => {
    const roadmap = createRoadmap({ title: 'Launch' })
    const task = createWorkTask({ title: 'Fix bug', roadmapId: roadmap.id })
    setChannelSession('telegram', 'chat-1', 'ses_1', { threadId: 'topic-1', mode: 'task', taskId: task.id, title: 'Fix bug' })
    setChannelSession('telegram', 'chat-1', 'ses_2', { threadId: 'topic-2', mode: 'roadmap', roadmapId: roadmap.id, title: 'Launch' })

    expect(getChannelSession('telegram', 'chat-1', 'topic-1')).toBe('ses_1')
    expect(getChannelSession('telegram', 'chat-1', 'topic-2')).toBe('ses_2')
    expect(listChannelSessions({ provider: 'telegram', chatId: 'chat-1' })).toHaveLength(2)
    expect(listChannelSessions({ provider: 'telegram', chatId: 'chat-1', threadId: 'topic-1' })[0]).toMatchObject({
      sessionId: 'ses_1',
      mode: 'task',
      taskId: task.id,
      title: 'Fix bug',
    })
  })

  it('clears a single chat/thread binding', () => {
    setChannelSession('telegram', 'chat-1', 'ses_1', { threadId: 'topic-1' })

    expect(clearChannelSession('telegram', 'chat-1', 'topic-1')).toBe(true)
    expect(getChannelSession('telegram', 'chat-1', 'topic-1')).toBeUndefined()
  })
})
