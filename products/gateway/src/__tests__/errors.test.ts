import { describe, expect, it } from 'vitest'
import { ConfigError, GatewayError } from '../errors.js'

describe('canonical error hierarchy', () => {
  it('GatewayError carries a stable code, category, and cause', () => {
    const cause = new Error('boom')
    const err = new GatewayError('failed', { code: 'x_failed', category: 'transient', cause })
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('GatewayError')
    expect(err.code).toBe('x_failed')
    expect(err.category).toBe('transient')
    expect(err.cause).toBe(cause)
  })

  it('subclasses preset their code/category and keep the subclass name', () => {
    const cfg = new ConfigError('Gateway config is invalid: bad')
    expect(cfg).toBeInstanceOf(GatewayError)
    expect(cfg.name).toBe('ConfigError')
    expect(cfg.code).toBe('config_invalid')
    expect(cfg.category).toBe('permanent')
  })
})
