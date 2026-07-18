import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { clearConfigCacheForTest } from '../config.js'
import {
  clearWorkStateForTest,
  createRoadmap,
} from '../work-store.js'
import {
  createSqliteWorkStoreBindingsPort,
} from '../work-store/bindings-port.js'

describe('work-store bindings mutation port', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-bindings-port-test-'))

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })
  const store = path.join(testDir, 'gateway.db')

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    clearConfigCacheForTest()
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    fs.mkdirSync(testDir, { recursive: true })
    clearWorkStateForTest(store)
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    clearConfigCacheForTest()
  })

  it('owns project binding mutations and mirrored channel rows behind a local SQLite port', () => {
    const port = createSqliteWorkStoreBindingsPort({ filePath: store })
    const first = createRoadmap({ title: 'Binding port alpha' }, store)
    const second = createRoadmap({ title: 'Binding port beta' }, store)

    const binding = port.upsertProjectBinding({
      alias: 'Alpha Project',
      roadmapId: first.id,
      sessionId: 'ses_alpha',
      provider: 'telegram',
      chatId: 'chat-alpha',
      threadId: 'topic-one',
      title: first.title,
    })

    expect(binding).toMatchObject({ alias: 'alpha-project', roadmapId: first.id, sessionId: 'ses_alpha', provider: 'telegram', chatId: 'chat-alpha', threadId: 'topic-one' })
    expect(port.resolveProjectContext({ provider: 'telegram', chatId: 'chat-alpha', threadId: 'topic-one' })).toMatchObject({ status: 'resolved', reason: 'bound chat/thread context', binding: { id: binding.id } })
    expect(port.getChannelBinding('telegram', 'chat-alpha', 'topic-one')).toMatchObject({ mode: 'roadmap', roadmapId: first.id, sessionId: 'ses_alpha' })

    expect(() => port.upsertProjectBinding({
      alias: 'beta-project',
      roadmapId: second.id,
      sessionId: 'ses_beta',
      provider: 'telegram',
      chatId: 'chat-alpha',
      threadId: 'topic-one',
    })).toThrow('project surface already bound')

    expect(() => port.upsertProjectBinding({
      alias: 'missing-chat',
      roadmapId: second.id,
      sessionId: 'ses_missing_chat',
      provider: 'telegram',
    })).toThrow('chatId must be a string')

    const updated = port.updateProjectBinding(binding.id, { chatId: 'chat-updated', threadId: 'topic-two', sessionId: 'ses_updated' })
    expect(updated).toMatchObject({ id: binding.id, chatId: 'chat-updated', threadId: 'topic-two', sessionId: 'ses_updated' })
    expect(port.getChannelBinding('telegram', 'chat-alpha', 'topic-one')).toBeUndefined()
    expect(port.getChannelBinding('telegram', 'chat-updated', 'topic-two')).toMatchObject({ mode: 'roadmap', roadmapId: first.id, sessionId: 'ses_updated' })

    const discord = port.upsertProjectBinding({
      alias: 'Discord Project',
      roadmapId: second.id,
      sessionId: 'ses_discord',
      scope: 'discord',
      provider: 'discord',
      chatId: 'channel-alpha',
      threadId: 'thread-one',
      title: second.title,
    })
    expect(discord).toMatchObject({ alias: 'discord-project', scope: 'discord', provider: 'discord', chatId: 'channel-alpha', threadId: 'thread-one' })
    expect(port.resolveProjectContext({ provider: 'discord', chatId: 'channel-alpha', threadId: 'thread-one' })).toMatchObject({ status: 'resolved', binding: { id: discord.id } })
    expect(port.getChannelBinding('discord', 'channel-alpha', 'thread-one')).toMatchObject({ mode: 'roadmap', roadmapId: second.id, sessionId: 'ses_discord' })

    expect(port.deleteProjectBinding(binding.id)).toBe(true)
    expect(port.getProjectBinding(binding.id)).toBeUndefined()
    expect(port.getChannelBinding('telegram', 'chat-updated', 'topic-two')).toBeUndefined()
  })

})
