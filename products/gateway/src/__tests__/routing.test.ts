import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { clearConfigCacheForTest } from '../config.js'
import { loadRouting, resolveAgent } from '../routing.js'

describe('routing', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-routing-test-'))

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    clearConfigCacheForTest()
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    clearConfigCacheForTest()
  })

  it('defaults user/channel messages to gateway-assistant', () => {
    expect(loadRouting().default).toBe('gateway-assistant')
    expect(resolveAgent('telegram', 'chat-1', 'hello')).toBe('gateway-assistant')
    expect(resolveAgent('whatsapp', 'chat-1', 'what needs me?')).toBe('gateway-assistant')
  })

  it('routes explicit specialist intents to specialist agents', () => {
    expect(resolveAgent('telegram', 'chat-1', 'create a roadmap')).toBe('gateway-planner')
    expect(resolveAgent('telegram', 'chat-1', 'show scheduler status')).toBe('gateway-coordinator')
    expect(resolveAgent('telegram', 'chat-1', 'run gateway doctor')).toBe('gateway-coordinator')
    expect(resolveAgent('telegram', 'chat-1', 'review this')).toBe('gateway-reviewer')
  })
})
