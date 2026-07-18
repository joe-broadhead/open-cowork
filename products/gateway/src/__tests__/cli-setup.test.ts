import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearConfigCacheForTest, getConfig } from '../config.js'
import { applySetupState, defaultSetupAnswers, parseModelRef } from '../cli-setup.js'
import { DEFAULT_ROUTING } from '../routing.js'

describe('cli setup', () => {
  let testDir: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-setup-'))
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    clearConfigCacheForTest()
  })

  afterEach(() => {
    clearConfigCacheForTest()
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  it('keeps nested provider model ids intact', () => {
    expect(parseModelRef('openrouter/deepseek/deepseek-v4-pro')).toEqual(['openrouter', 'deepseek/deepseek-v4-pro'])
  })

  it('rejects model refs without a provider and model id', () => {
    expect(() => parseModelRef('openrouter')).toThrow('provider/model')
  })

  it('creates config and routing idempotently', () => {
    const first = applySetupState(defaultSetupAnswers(), { mode: 'setup', installAssets: false })
    expect(first.configChanged).toBe(true)
    expect(first.routingChanged).toBe(true)
    expect(first.statePath).toBe(path.join(testDir, 'gateway.db'))

    const configPath = path.join(testDir, 'config.json')
    const routingPath = path.join(testDir, 'routing.json')
    const firstConfig = fs.readFileSync(configPath, 'utf-8')
    const firstRouting = fs.readFileSync(routingPath, 'utf-8')
    expect(JSON.parse(firstRouting)).toEqual(DEFAULT_ROUTING)

    clearConfigCacheForTest()
    const reloaded = getConfig()
    const second = applySetupState(defaultSetupAnswers(reloaded), { mode: 'update', installAssets: false, hadConfig: true, current: reloaded })
    expect(second.configChanged).toBe(false)
    expect(second.routingChanged).toBe(false)
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(firstConfig)
    expect(fs.readFileSync(routingPath, 'utf-8')).toBe(firstRouting)
  })

  it('reports state path from OPENCODE_GATEWAY_STATE_DIR when configured', () => {
    const stateDir = path.join(testDir, 'gateway-state')
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = stateDir

    const result = applySetupState(defaultSetupAnswers(), { mode: 'setup', installAssets: false })

    expect(result.statePath).toBe(path.join(stateDir, 'gateway.db'))
  })

  it('preserves and redacts secrets in update summaries', () => {
    const answers = { ...defaultSetupAnswers(), telegramBotToken: 'telegram-token-fixture' }
    const result = applySetupState(answers, { mode: 'setup', installAssets: false })

    expect(result.config.channels.telegram.botToken).toBe('telegram-token-fixture')
    expect(result.changes.join('\n')).not.toContain('super-secret-token')

    const update = applySetupState(defaultSetupAnswers(result.config), { mode: 'update', installAssets: false, hadConfig: true, current: result.config })
    expect(update.config.channels.telegram.botToken).toBe('telegram-token-fixture')
    expect(update.changes.join('\n')).not.toContain('super-secret-token')
  })

  it('preserves Agent Factory blueprint directories during update', () => {
    const initial = applySetupState(defaultSetupAnswers(), { mode: 'setup', installAssets: false })
    const current = {
      ...initial.config,
      agentFactory: { blueprintDirs: ['blueprints', 'team-catalog'] },
    }

    const update = applySetupState(defaultSetupAnswers(current), { mode: 'update', installAssets: false, hadConfig: true, current })

    expect(update.config.agentFactory.blueprintDirs).toEqual(['blueprints', 'team-catalog'])
  })
})
