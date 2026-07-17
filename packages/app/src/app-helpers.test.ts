import { describe, expect, it } from 'vitest'
import { isViewTransitionSkippedError } from './app-helpers'

describe('isViewTransitionSkippedError', () => {
  it('matches the View Transition API abort shape', () => {
    expect(isViewTransitionSkippedError(null)).toBe(false)
    expect(isViewTransitionSkippedError(new Error('nope'))).toBe(false)
    expect(isViewTransitionSkippedError(Object.assign(new Error('Transition was skipped'), { name: 'AbortError' }))).toBe(true)
    expect(isViewTransitionSkippedError({ name: 'AbortError', message: 'Transition was skipped' })).toBe(true)
    expect(isViewTransitionSkippedError({ name: 'AbortError', message: 'other' })).toBe(false)
  })
})
