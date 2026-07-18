import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { clearConfigCacheForTest } from '../config.js'
import { clearWorkStateForTest } from '../work-store.js'
import { clearAgentPresencesForTest, createAgentPresence, createAgentPresenceForTest, listAgentPresences, resolveAgentPresenceForChannel, updateAgentPresence } from '../agent-presence.js'
import { createPersona, listPersonas } from '../persona.js'
import { listOpenCodeAgents } from '../opencode-assets.js'

describe('AgentPresence + persona factory', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-agent-presence-'))
  const store = path.join(testDir, 'gateway.db')
  const opencodeDir = path.join(testDir, 'opencode')

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_CONFIG_DIR'] = opencodeDir
    fs.mkdirSync(opencodeDir, { recursive: true })
    clearWorkStateForTest(store)
    clearAgentPresencesForTest(store)
    clearConfigCacheForTest()
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_CONFIG_DIR']
    clearConfigCacheForTest()
    try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {}
  })

  it('creates primary-mode personas and lists them', () => {
    const { agent } = createPersona({
      name: 'concierge',
      description: 'Always-on helper',
      prompt: 'You are concierge.',
      configDir: opencodeDir,
    })
    expect(agent).toMatchObject({ mode: 'primary', description: 'Always-on helper' })
    expect(listOpenCodeAgents(opencodeDir)['concierge']).toBeTruthy()
    const personas = listPersonas(opencodeDir)
    expect(personas.find(row => row.name === 'concierge')?.mode).toBe('primary')
  })

  it('creates AgentPresence only when OpenCode agent exists', () => {
    expect(() => createAgentPresence({ name: 'bot', opencodeAgent: 'missing-agent' }, store)).toThrow(/not found/)
    createPersona({ name: 'house-bot', configDir: opencodeDir })
    const row = createAgentPresenceForTest({ name: 'bot', opencodeAgent: 'house-bot' }, store)
    expect(row.presenceId).toMatch(/^ap_/)
    expect(listAgentPresences({}, store)).toHaveLength(1)
  })

  it('resolves sticky channel AgentPresence and pauses it', () => {
    const created = createAgentPresenceForTest({
      name: 'tg-bot',
      opencodeAgent: 'gateway-assistant',
      provider: 'telegram',
      chatId: '12345',
      status: 'active',
      sessionId: 'ses_sticky',
    }, store)
    const resolved = resolveAgentPresenceForChannel('telegram', '12345', undefined, store)
    expect(resolved?.presenceId).toBe(created.presenceId)
    expect(resolved?.sessionId).toBe('ses_sticky')
    const paused = updateAgentPresence(created.presenceId, { status: 'paused' }, store)
    expect(paused?.status).toBe('paused')
    expect(resolveAgentPresenceForChannel('telegram', '12345', undefined, store)).toBeUndefined()
  })
})
