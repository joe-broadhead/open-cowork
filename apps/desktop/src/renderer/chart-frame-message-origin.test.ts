import { describe, expect, it } from 'vitest'
import { isOpaqueMessageOrigin, resolveParentTargetOrigin } from './chart-frame-message-origin'

describe('resolveParentTargetOrigin', () => {
  it('uses the concrete referrer origin in dev server frames', () => {
    expect(resolveParentTargetOrigin('http://localhost:5173/chart-frame.html')).toBe('http://localhost:5173')
  })

  it('falls back to wildcard when the packaged frame referrer is stripped', () => {
    expect(resolveParentTargetOrigin('')).toBe('*')
  })

  it('falls back to wildcard for file referrers with opaque origins', () => {
    expect(resolveParentTargetOrigin('file:///Applications/Open%20Cowork.app/Contents/Resources/app.asar/dist/chart-frame.html')).toBe('*')
  })

  it('falls back to wildcard for invalid referrers', () => {
    expect(resolveParentTargetOrigin('not a url')).toBe('*')
  })
})

describe('isOpaqueMessageOrigin', () => {
  it('recognizes opaque sandbox and file origins', () => {
    expect(isOpaqueMessageOrigin('null')).toBe(true)
    expect(isOpaqueMessageOrigin('file://')).toBe(true)
    expect(isOpaqueMessageOrigin('http://localhost:5173')).toBe(false)
  })
})
