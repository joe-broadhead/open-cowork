import { describe, expect, it } from 'vitest'
import { getConfig } from '../config.js'
import { resolveReviewGateIsolation } from '../review-gate-isolation.js'

describe('review gate isolation policy', () => {
  it('mechanically clamps review profile permissions without mutating the stored profile', () => {
    const config = getConfig()
    const original = {
      ...config.profiles['reviewer']!,
      permission: { ...config.profiles['reviewer']!.permission, edit: 'allow' as const, webfetch: 'allow' as const, bash: 'allow' as const },
    }

    const decision = resolveReviewGateIsolation({ stage: 'review', profileName: 'reviewer', profile: original, config })

    expect(decision.active).toBe(true)
    expect(decision.effectivePermission).toMatchObject({
      edit: 'deny',
      webfetch: 'deny',
      websearch: 'deny',
      task: 'deny',
      todowrite: 'deny',
    })
    expect(decision.effectivePermission['bash']).toMatchObject({ '': 'deny', 'git status': 'allow', 'npm run verify': 'allow' })
    expect(decision.changedPermissions).toEqual(expect.arrayContaining(['bash', 'edit', 'webfetch']))
    expect(decision.promptContext).toContain('Mechanical review-gate isolation policy is active')
    expect(original.permission).toMatchObject({ edit: 'allow', webfetch: 'allow', bash: 'allow' })
  })

  it('is disabled outside configured gate stages', () => {
    const config = getConfig()
    const decision = resolveReviewGateIsolation({ stage: 'implement', profileName: 'implementer', profile: config.profiles['implementer']!, config })

    expect(decision.active).toBe(false)
    expect(decision.profile).toBe(config.profiles['implementer'])
    expect(decision.effectivePermission).toEqual(config.profiles['implementer']!.permission)
    expect(decision.promptContext).toBe('')
  })

  it('denies bash entirely when evidence commands are disabled', () => {
    const config = getConfig()
    const decision = resolveReviewGateIsolation({
      stage: 'review',
      profileName: 'reviewer',
      profile: { ...config.profiles['reviewer']!, permission: { ...config.profiles['reviewer']!.permission, bash: 'allow' as const } },
      config: {
        ...config,
        scheduler: {
          ...config.scheduler,
          reviewGateIsolation: {
            ...config.scheduler.reviewGateIsolation,
            allowBashEvidenceCommands: false,
          },
        },
      },
    })

    expect(decision.active).toBe(true)
    expect(decision.effectivePermission['bash']).toBe('deny')
    expect(decision.deniedTools).toContain('bash')
    expect(decision.allowedBashCommands).toEqual([])
  })
})
