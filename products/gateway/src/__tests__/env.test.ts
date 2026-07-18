import { describe, expect, it } from 'vitest'
import {
  ENV_KEYS,
  gatewayEnv,
  parseBooleanEnv,
  readBooleanEnv,
  readFirstRawEnv,
  readIntEnv,
  readListEnv,
  readRawEnv,
  readTrimmedEnv,
} from '../env.js'

describe('typed env accessor', () => {
  it('reads raw values without trimming and treats empty string as falsy for || defaults', () => {
    expect(readRawEnv('X', { X: '  spaced  ' })).toBe('  spaced  ')
    expect(readRawEnv('MISSING', {})).toBeUndefined()
    // `|| default` semantics: an empty string falls through to the default.
    expect(readRawEnv('X', { X: '' }) || 'fallback').toBe('fallback')
  })

  it('mirrors env.X?.trim(): undefined stays undefined, whitespace collapses to ""', () => {
    expect(readTrimmedEnv('X', { X: '  hi  ' })).toBe('hi')
    expect(readTrimmedEnv('X', { X: '   ' })).toBe('')
    expect(readTrimmedEnv('X', {})).toBeUndefined()
  })

  it('picks the first truthy raw value across candidate names', () => {
    expect(readFirstRawEnv(['A', 'B'], { A: '', B: 'second' })).toBe('second')
    expect(readFirstRawEnv(['A', 'B'], { A: 'first', B: 'second' })).toBe('first')
    expect(readFirstRawEnv(['A', 'B'], {})).toBeUndefined()
  })

  it('parses booleans across accepted spellings and rejects the rest', () => {
    for (const v of ['1', 'true', 'YES', 'On']) expect(parseBooleanEnv(v, 'X')).toBe(true)
    for (const v of ['0', 'false', 'no', 'OFF', '']) expect(parseBooleanEnv(v, 'X')).toBe(false)
    expect(() => parseBooleanEnv('maybe', 'MY_FLAG')).toThrow('MY_FLAG must be true or false')
  })

  it('readBooleanEnv returns undefined only when the variable is entirely unset', () => {
    expect(readBooleanEnv('X', {})).toBeUndefined()
    // Present-but-empty parses to false (matches historical daemon behavior).
    expect(readBooleanEnv('X', { X: '' })).toBe(false)
    expect(readBooleanEnv('X', { X: 'true' })).toBe(true)
  })

  it('validates bounded integers and applies default on unset/empty', () => {
    expect(readIntEnv('P', { min: 1, max: 65535 }, { P: '4097' })).toBe(4097)
    expect(readIntEnv('P', { min: 1, max: 65535 }, {})).toBeUndefined()
    expect(readIntEnv('P', { min: 1, max: 65535 }, { P: '' })).toBeUndefined()
    expect(() => readIntEnv('P', { min: 1, max: 65535, label: 'PORT' }, { P: '70000' })).toThrow('PORT must be an integer between 1 and 65535')
    expect(() => readIntEnv('P', { min: 1, max: 10 }, { P: '2.5' })).toThrow('must be an integer between 1 and 10')
  })

  it('rejects whitespace/hex/exponential garbage instead of coercing it via Number()', () => {
    // Whitespace-only must not become 0.
    expect(readIntEnv('P', { min: 1, max: 65535 }, { P: '   ' })).toBeUndefined()
    // Hex and exponential notation are rejected (Number would coerce to 31 / 1000).
    expect(readIntEnv('P', { min: 1, max: 65535 }, { P: '0x1F' })).toBeUndefined()
    expect(readIntEnv('P', { min: 1, max: 65535 }, { P: '1e3' })).toBeUndefined()
    // Plain base-10 integers still parse, including a negative sign.
    expect(readIntEnv('P', { min: -10, max: 65535 }, { P: '42' })).toBe(42)
    expect(readIntEnv('P', { min: -10, max: 65535 }, { P: '-3' })).toBe(-3)
    // Surrounding whitespace on an otherwise-valid integer is tolerated.
    expect(readIntEnv('P', { min: 1, max: 65535 }, { P: ' 42 ' })).toBe(42)
    // Empty stays undefined.
    expect(readIntEnv('P', { min: 1, max: 65535 }, { P: '' })).toBeUndefined()
  })

  it('parses delimited lists into trimmed, de-duplicated, non-empty entries', () => {
    expect(readListEnv('T', { T: 'a, b ,, a ,c' })).toEqual(['a', 'b', 'c'])
    expect(readListEnv('T', {})).toBeUndefined()
    expect(readListEnv('T', { T: '' })).toEqual([])
  })

  it('exposes typed named accessors that preserve call-site semantics', () => {
    expect(gatewayEnv.configDir({ [ENV_KEYS.configDir]: '/cfg' })).toBe('/cfg')
    expect(gatewayEnv.opencodeUrl({ [ENV_KEYS.opencodeUrl]: '  http://h  ' })).toBe('http://h')
    expect(gatewayEnv.httpPort({ OPENCODE_GATEWAY_HTTP_PORT: '', GATEWAY_HTTP_PORT: '4197' })).toBe('4197')
    expect(gatewayEnv.httpHost({ GATEWAY_HTTP_HOST: '  0.0.0.0  ' })).toBe('0.0.0.0')
    expect(gatewayEnv.httpHost({})).toBe('')
    expect(gatewayEnv.allowNonLocalHttp({ [ENV_KEYS.allowNonLocalHttp]: 'yes' })).toBe(true)
    expect(gatewayEnv.publicWebhookMode({})).toBeUndefined()
    expect(gatewayEnv.unsafeAllowNoAuth({ [ENV_KEYS.unsafeAllowNoAuth]: 'off' })).toBe(false)
    expect(gatewayEnv.capabilityScopedLoopback({ [ENV_KEYS.capabilityScopedLoopback]: '1' })).toBe(true)
    expect(gatewayEnv.requireNonMcpDestructiveApproval({ [ENV_KEYS.requireNonMcpDestructiveApproval]: 'true' })).toBe(true)
    expect(gatewayEnv.stateDir({ [ENV_KEYS.stateDir]: '/state' })).toBe('/state')
    expect(gatewayEnv.logLevel({ [ENV_KEYS.logLevel]: ' DEBUG ' })).toBe('debug')
    expect(gatewayEnv.logFormat({ [ENV_KEYS.logFormat]: 'JSON' })).toBe('json')
    expect(gatewayEnv.mcpTools({ [ENV_KEYS.mcpTools]: 'read, write' })).toEqual(['read', 'write'])
  })
})
