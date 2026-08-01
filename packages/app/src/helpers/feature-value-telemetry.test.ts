import { describe, expect, it, vi } from 'vitest'

import { createFeatureValueTracker } from './feature-value-telemetry'

describe('feature-value telemetry', () => {
  it('emits each installation milestone once without ids', async () => {
    let persisted: unknown = {}
    const emit = vi.fn()
    const tracker = createFeatureValueTracker({
      load: () => persisted,
      save: (state) => { persisted = state },
      emit: async (event) => { emit(event); return true },
    })

    await expect(tracker.discover('projects')).resolves.toBe(true)
    await expect(tracker.discover('projects')).resolves.toBe(false)
    await expect(tracker.activate('projects')).resolves.toBe('activated')
    await expect(tracker.activate('projects')).resolves.toBe('repeated')
    await expect(tracker.activate('projects')).resolves.toBeNull()
    expect(emit.mock.calls.map(([event]) => event)).toEqual([
      { feature: 'projects', stage: 'discovered' },
      { feature: 'projects', stage: 'activated' },
      { feature: 'projects', stage: 'repeated' },
    ])
    expect(JSON.stringify(persisted)).not.toMatch(/user|install|session|path|content|id/i)
  })

  it('does not advance while disabled and restarts the funnel when consent is enabled', async () => {
    let enabled = false
    const emit = vi.fn(async () => enabled)
    const tracker = createFeatureValueTracker({
      load: () => { throw new Error('blocked storage') },
      save: () => { throw new Error('quota') },
      emit,
    })

    await expect(tracker.activate('voice')).resolves.toBeNull()
    enabled = true
    await expect(tracker.activate('voice')).resolves.toBe('activated')
    expect(emit).toHaveBeenNthCalledWith(1, { feature: 'voice', stage: 'discovered' })
    expect(emit).toHaveBeenNthCalledWith(2, { feature: 'voice', stage: 'discovered' })
    expect(emit).toHaveBeenNthCalledWith(3, { feature: 'voice', stage: 'activated' })
  })

  it('clamps legacy repeat counts and never re-emits a completed funnel', async () => {
    const emit = vi.fn()
    const tracker = createFeatureValueTracker({
      load: () => ({ appearance: { discovered: true, activations: Number.MAX_SAFE_INTEGER } }),
      save: vi.fn(),
      emit: async (event) => { emit(event); return true },
    })

    await expect(tracker.activate('appearance')).resolves.toBeNull()
    expect(emit).not.toHaveBeenCalled()
  })
})
