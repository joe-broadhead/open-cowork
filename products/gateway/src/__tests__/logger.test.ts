import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __setLogSinkForTest, createLogger, formatLogLine, logger } from '../logger.js'

describe('logger', () => {
  let lines: string[]

  beforeEach(() => {
    lines = []
    __setLogSinkForTest(line => lines.push(line))
    delete process.env['GATEWAY_LOG_FORMAT']
    delete process.env['GATEWAY_LOG_LEVEL']
  })

  afterEach(() => {
    __setLogSinkForTest(null)
    delete process.env['GATEWAY_LOG_FORMAT']
    delete process.env['GATEWAY_LOG_LEVEL']
  })

  it('emits a timestamped, leveled, human-readable line with a component', () => {
    logger.info('daemon listening', { component: 'gateway', port: 4097 })

    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z INFO \[gateway\] daemon listening port=4097$/)
  })

  it('threads correlationId and traceId into the structured fields', () => {
    const log = createLogger({ component: 'scheduler' })
    log.warn('run stalled', { correlationId: 'ses_abc', traceId: 'trace_run_123' })

    expect(lines[0]).toContain('WARN [scheduler] run stalled')
    expect(lines[0]).toContain('correlationId=ses_abc')
    expect(lines[0]).toContain('traceId=trace_run_123')
  })

  it('redacts secrets in the message and in string fields', () => {
    const telegram = '123456:abcdefghijklmnopqrstuvwxyzABCDEF'
    logger.error('auth failed', { component: 'gateway', bearer: 'Bearer abcdefghijklmnopqrstuvwxyz', token: telegram })

    const text = lines.join('\n')
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz')
    expect(text).not.toContain(telegram)
    expect(text).toContain('Bearer <redacted>')
  })

  it('emits valid JSON when GATEWAY_LOG_FORMAT=json, including correlationId', () => {
    process.env['GATEWAY_LOG_FORMAT'] = 'json'
    logger.info('dispatched run', { component: 'scheduler', correlationId: 'ses_json', traceId: 'trace_x', attempt: 2 })

    const parsed = JSON.parse(lines[0]!)
    expect(parsed).toMatchObject({ level: 'info', component: 'scheduler', message: 'dispatched run', correlationId: 'ses_json', traceId: 'trace_x', attempt: 2 })
    expect(typeof parsed.ts).toBe('string')
    expect(new Date(parsed.ts).toISOString()).toBe(parsed.ts)
  })

  it('suppresses levels below the configured minimum', () => {
    process.env['GATEWAY_LOG_LEVEL'] = 'warn'
    logger.debug('noise')
    logger.info('also noise')
    logger.warn('kept')
    logger.error('kept too')

    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('WARN')
    expect(lines[1]).toContain('ERROR')
  })

  it('redacts a secret nested one level deep in a field in BOTH human and json modes', () => {
    const secret = 'Bearer abcdefghijklmnopqrstuvwxyz'

    // Human mode.
    logger.info('done', { component: 'gateway', response: { apiKey: secret } })
    // JSON mode.
    process.env['GATEWAY_LOG_FORMAT'] = 'json'
    logger.info('done', { component: 'gateway', response: { apiKey: secret } })

    const human = lines[0]!
    const json = lines[1]!
    expect(human).not.toContain('abcdefghijklmnopqrstuvwxyz')
    expect(json).not.toContain('abcdefghijklmnopqrstuvwxyz')
    // The JSON line is still valid JSON with the secret redacted in the nested field.
    const parsed = JSON.parse(json)
    expect(parsed.response.apiKey).toContain('<redacted>')
    expect(JSON.stringify(parsed)).not.toContain('abcdefghijklmnopqrstuvwxyz')
  })

  it('never throws on circular or BigInt field values in json mode', () => {
    process.env['GATEWAY_LOG_FORMAT'] = 'json'
    const circular: Record<string, unknown> = { name: 'node' }
    circular['self'] = circular

    expect(() => logger.info('big', { n: 1n })).not.toThrow()
    expect(() => logger.info('cycle', { circular })).not.toThrow()

    // Both lines are still valid JSON.
    expect(() => JSON.parse(lines[0]!)).not.toThrow()
    expect(() => JSON.parse(lines[1]!)).not.toThrow()
    expect(JSON.parse(lines[1]!).circular.self).toBe('[circular]')
  })

  it('formatLogLine produces a stable, redacted line without a sink', () => {
    const line = formatLogLine('info', 'hello token=supersecretvalue', { component: 'test' }, new Date('2026-07-05T00:00:00.000Z'))
    expect(line).toBe('2026-07-05T00:00:00.000Z INFO [test] hello token=<redacted>')
  })
})
