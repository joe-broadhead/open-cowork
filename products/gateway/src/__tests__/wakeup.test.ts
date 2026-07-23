import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { queueEvent, getQueuedEvents, clearEventsForTest } from '../wakeup.js'
import { clearConfigCacheForTest } from '../config.js'

describe('wakeup', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-events-test-'))

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    clearEventsForTest()
    clearConfigCacheForTest()
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    delete process.env['OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN']
    clearConfigCacheForTest()
  })

  it('queues events', () => {
    queueEvent('test event')
    const events = getQueuedEvents()
    expect(events.length).toBeGreaterThan(0)
    expect(events[events.length - 1]).toContain('test event')
  })

  it('caps at 100 events', () => {
    for (let i = 0; i < 150; i++) queueEvent('event ' + i)
    const events = getQueuedEvents()
    expect(events.length).toBeLessThanOrEqual(100)
  })

  it('persists events for replay', () => {
    queueEvent('persist me')
    clearEventsForTest()
    const events = getQueuedEvents()
    expect(events.some(e => e.includes('persist me'))).toBe(true)
  })

  it('redacts token-like values before persisting events', () => {
    process.env['OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN'] = 'super-secret-http-token'

    queueEvent('failed request Authorization: Bearer super-secret-http-token token=abc123')

    const event = getQueuedEvents().at(-1) || ''
    expect(event).toContain('Bearer <redacted>')
    expect(event).toContain('token=<redacted>')
    expect(event).not.toContain('super-secret-http-token')
    expect(event).not.toContain('abc123')
  })

  it('writes the operational sidecar with private permissions (H3 SQLite)', () => {
    queueEvent('private event')
    const file = path.join(testDir, 'operational-sidecar.sqlite')

    expect(fs.existsSync(file)).toBe(true)
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600')
    expect((fs.statSync(testDir).mode & 0o777).toString(8)).toBe('700')
    expect(fs.existsSync(path.join(testDir, 'events.json'))).toBe(false)
  })

  it('imports legacy events.json once into the operational sidecar', () => {
    fs.mkdirSync(testDir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(
      path.join(testDir, 'events.json'),
      JSON.stringify({ events: ['2026-01-01T00:00:00.000Z: legacy event'] }, null, 2),
      { mode: 0o600 },
    )
    clearEventsForTest()
    const events = getQueuedEvents()
    expect(events.some(e => e.includes('legacy event'))).toBe(true)
  })
})
