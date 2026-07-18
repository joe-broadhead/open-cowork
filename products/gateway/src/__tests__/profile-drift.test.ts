import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { detectGatewayProfileDrift, formatProfileDrift } from '../profile-drift.js'
import { clearConfigCacheForTest, getConfig } from '../config.js'

describe('Gateway profile drift', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-profile-drift-test-'))

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    clearConfigCacheForTest()
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    clearConfigCacheForTest()
  })

  it('passes for current defaults', () => {
    expect(detectGatewayProfileDrift(getConfig())).toEqual([])
  })

  it('detects stale review, verifier, and missing supervisor profiles', () => {
    const config = getConfig()
    const drift = detectGatewayProfileDrift({
      ...config,
      profiles: {
        ...config.profiles,
        reviewer: { ...config.profiles['reviewer']!, model: { providerID: 'openrouter', modelID: 'deepseek/deepseek-v4-pro', variant: 'high' }, skills: ['gateway-stage'] },
        verifier: { ...config.profiles['verifier']!, agent: 'gateway-reviewer' },
        supervisor: undefined as any,
      },
    })

    expect(drift.map(row => row.profile).sort()).toEqual(['reviewer', 'supervisor', 'verifier'])
    expect(formatProfileDrift(drift)).toContain('reviewer')
    expect(formatProfileDrift(drift)).toContain('missing profile')
  })
})
