import { describe, expect, it } from 'vitest'
import type { TaskRun } from '../stores/session'
import { statusLabel } from './status-label'

describe('statusLabel', () => {
  it('maps every task run status to its canonical English label', () => {
    expect(statusLabel('running')).toBe('running')
    expect(statusLabel('complete')).toBe('done')
    expect(statusLabel('error')).toBe('errored')
    expect(statusLabel('queued')).toBe('queued')
  })

  it('falls back to the raw value for an unknown status rather than rendering empty', () => {
    // A future enum value reaching an older renderer must not blank the UI.
    const future = 'paused' as TaskRun['status']
    expect(statusLabel(future)).toBe('paused')
  })
})
