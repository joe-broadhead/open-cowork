import { describe, expect, it } from 'vitest'
import { buildAlphaHealthSummary } from '../alpha-health.js'

describe('alpha health summary', () => {
  const now = new Date('2026-06-15T12:00:00.000Z')

  it('rolls up durable private-alpha evidence into a healthy verdict', () => {
    const summary = buildAlphaHealthSummary({
      now,
      serviceHealth: {
        status: 'ok',
        generatedAt: '2026-06-15T10:05:00.000Z',
        summary: 'All 8 service components are healthy.',
        components: [{ id: 'daemon', label: 'Daemon', status: 'ok', summary: 'Daemon is running.', remediation: 'No action required.' }],
        counts: { ok: 1, degraded: 0, down: 0 },
        attention: [],
      } as any,
      readiness: { state: 'ready', summary: 'ready', checks: [] },
      heartbeat: { status: 'ok', schedulerEnabled: true, enabled: true, running: false, intervalMs: 30000, tickCount: 4, skippedTicks: 0, lastSummary: 'heartbeat ok', lastCompletedAt: '2026-06-15T10:05:00.000Z' } as any,
      scheduler: { enabled: true },
      channels: {
        providers: [
          { provider: 'telegram', configured: true, enabled: true, bindings: 1, health: 'ok', note: 'Credentials and explicit allowlist are configured.' },
          { provider: 'whatsapp', configured: false, enabled: false, bindings: 0, health: 'degraded', note: 'whatsapp credentials are not configured; adapter disabled.' },
        ],
        sync: { active: true, syncEnabled: true, intervalMs: 3000, includeUserMessages: true, lastSyncAt: '2026-06-15T10:04:00.000Z', deliveriesTracked: 2, pendingInbound: 0 },
        links: [{ provider: 'telegram', chatId: 'chat-1', sessionId: 'ses_1', mode: 'chat', createdAt: '', updatedAt: '' }],
      } as any,
      humanGates: [],
      questions: [],
      permissions: [],
      requestSourceAvailable: true,
      completionProposals: [],
      promotionScorecards: [{
        id: 'scorecard_default',
        subjectKind: 'team',
        subjectName: 'default',
        sourceKind: 'eval',
        sourceId: 'team-orchestration-e2e',
        recommendation: 'promote',
        status: 'evaluated',
        thresholds: [{ id: 'score.min', passed: true }],
        updatedAt: '2026-06-15T09:00:00.000Z',
      }],
      backups: [{ id: 'gateway-backup-20260615T090000Z', path: '/state/backups/gateway-backup-20260615T090000Z', createdAt: '2026-06-15T09:00:00.000Z', ok: true, counts: { tasks: 1, runs: 1 } } as any],
      recoveryDrills: [{ id: 'recovery-drill-20260615T091000Z', status: 'pass', startedAt: '2026-06-15T09:10:00.000Z', completedAt: '2026-06-15T09:11:00.000Z', path: '/state/recovery-drills/recovery-drill-20260615T091000Z', evidencePath: '/state/recovery-drills/recovery-drill-20260615T091000Z/evidence.json', reportPath: '/state/recovery-drills/recovery-drill-20260615T091000Z/report.md', checks: { total: 5, passed: 5, failed: 0 } }],
      runs: [{ id: 'run_1', taskId: 'task_1', status: 'passed' }],
      tasks: [],
      supervisors: [],
      alerts: [],
    })

    expect(summary).toMatchObject({ status: 'healthy', alphaHealthy: true, blockers: [] })
    expect(summary.indicators.map(indicator => [indicator.id, indicator.status])).toEqual(expect.arrayContaining([
      ['service_health', 'ok'],
      ['channel_delivery', 'ok'],
      ['backup_restore', 'ok'],
    ]))
  })

  it('lets readiness veto alpha health even when service components are ok', () => {
    const summary = buildAlphaHealthSummary({
      now,
      serviceHealth: { status: 'ok', generatedAt: now.toISOString(), summary: 'ok', components: [{ id: 'daemon', label: 'Daemon', status: 'ok', summary: 'ok' }], counts: { ok: 1, degraded: 0, down: 0 }, attention: [] } as any,
      readiness: { state: 'not_ready', summary: 'OpenCode unreachable', checks: [] },
      heartbeat: { status: 'ok', schedulerEnabled: true, enabled: true, running: false, intervalMs: 30000, tickCount: 4, skippedTicks: 0, lastSummary: 'heartbeat ok', lastCompletedAt: '2026-06-15T10:05:00.000Z' } as any,
      scheduler: { enabled: true },
      channels: { providers: [{ provider: 'telegram', configured: true, enabled: true, bindings: 1, health: 'ok', note: 'ok' }], sync: { active: true, syncEnabled: true, intervalMs: 3000, includeUserMessages: true, deliveriesTracked: 1, pendingInbound: 0 }, links: [] } as any,
      humanGates: [],
      questions: [],
      permissions: [],
      requestSourceAvailable: true,
      completionProposals: [],
      promotionScorecards: [{ id: 'scorecard_ok', subjectKind: 'team', subjectName: 'default', sourceId: 'eval', recommendation: 'promote', status: 'evaluated', thresholds: [{ id: 'score.min', passed: true }], updatedAt: now.toISOString() }],
      backups: [{ id: 'backup', path: '/backup', createdAt: now.toISOString(), ok: true, counts: {} } as any],
      recoveryDrills: [{ id: 'drill', status: 'pass', startedAt: now.toISOString(), completedAt: now.toISOString(), path: '/drill', evidencePath: '/drill/evidence.json', reportPath: '/drill/report.md', checks: { total: 1, passed: 1, failed: 0 } }],
      runs: [],
      tasks: [],
      supervisors: [],
      alerts: [],
    })

    expect(summary.status).toBe('blocked')
    expect(summary.alphaHealthy).toBe(false)
    expect(summary.indicators.find(indicator => indicator.id === 'service_health')).toMatchObject({ status: 'blocked' })
  })

  it('uses all durable scorecards for blockers while keeping recent scorecards compact', () => {
    const recentPassing = Array.from({ length: 5 }, (_, index) => ({
      id: `scorecard_ok_${index}`,
      subjectKind: 'team',
      subjectName: `team-${index}`,
      sourceId: `eval-${index}`,
      recommendation: 'promote',
      status: 'evaluated',
      thresholds: [{ id: 'score.min', passed: true }],
      updatedAt: `2026-06-15T10:0${index}:00.000Z`,
    }))
    const olderBlocking = {
      id: 'scorecard_old_block',
      subjectKind: 'profile',
      subjectName: 'reviewer',
      sourceId: 'older-eval',
      recommendation: 'block',
      status: 'evaluated',
      thresholds: [{ id: 'score.min', passed: true }],
      updatedAt: '2026-06-01T00:00:00.000Z',
    }

    const summary = buildAlphaHealthSummary({
      now,
      promotionScorecards: [...recentPassing, olderBlocking],
      requestSourceAvailable: true,
      runs: [],
      tasks: [],
      alerts: [],
    })

    expect(summary.status).toBe('blocked')
    expect(summary.recent.scorecards).toHaveLength(5)
    expect(summary.recent.scorecards.map(scorecard => scorecard.id)).not.toContain('scorecard_old_block')
    expect(summary.blockers.map(blocker => blocker.label)).toContain('Scorecard blocks profile:reviewer')
    expect(summary.indicators.find(indicator => indicator.id === 'eval_scorecards')).toMatchObject({ status: 'blocked', count: 6 })
  })

  it('does not prove alpha health with unavailable requests or stale scorecards', () => {
    const summary = buildAlphaHealthSummary({
      now,
      serviceHealth: { status: 'ok', generatedAt: now.toISOString(), summary: 'ok', components: [{ id: 'daemon', label: 'Daemon', status: 'ok', summary: 'ok' }], counts: { ok: 1, degraded: 0, down: 0 }, attention: [] } as any,
      readiness: { state: 'ready', summary: 'ready', checks: [] },
      heartbeat: { status: 'ok', schedulerEnabled: true, enabled: true, running: false, intervalMs: 30000, tickCount: 4, skippedTicks: 0, lastSummary: 'heartbeat ok', lastCompletedAt: '2026-06-15T10:05:00.000Z' } as any,
      scheduler: { enabled: true },
      channels: { providers: [{ provider: 'telegram', configured: true, enabled: true, bindings: 1, health: 'ok', note: 'ok' }], sync: { active: true, syncEnabled: true, intervalMs: 3000, includeUserMessages: true, deliveriesTracked: 1, pendingInbound: 0 }, links: [] } as any,
      humanGates: [],
      questions: [],
      permissions: [],
      requestSourceAvailable: false,
      completionProposals: [],
      promotionScorecards: [{ id: 'scorecard_stale', subjectKind: 'team', subjectName: 'default', sourceId: 'eval', recommendation: 'promote', status: 'evaluated', thresholds: [{ id: 'score.min', passed: true }], updatedAt: '2026-06-01T00:00:00.000Z' }],
      backups: [{ id: 'backup', path: '/backup', createdAt: now.toISOString(), ok: true, counts: {} } as any],
      recoveryDrills: [{ id: 'drill', status: 'pass', startedAt: now.toISOString(), completedAt: now.toISOString(), path: '/drill', evidencePath: '/drill/evidence.json', reportPath: '/drill/report.md', checks: { total: 1, passed: 1, failed: 0 } }],
      runs: [],
      tasks: [],
      supervisors: [],
      alerts: [],
    })

    expect(summary.status).toBe('not_proven')
    expect(summary.alphaHealthy).toBeNull()
    expect(summary.indicators.find(indicator => indicator.id === 'open_gates')).toMatchObject({ status: 'unknown' })
    expect(summary.indicators.find(indicator => indicator.id === 'eval_scorecards')).toMatchObject({ status: 'warning' })
  })

  it('keeps first-run setup useful when durable evidence is missing', () => {
    const summary = buildAlphaHealthSummary({
      now,
      serviceHealth: { status: 'degraded', generatedAt: now.toISOString(), summary: '1 component needs attention.', components: [], counts: { ok: 0, degraded: 1, down: 0 }, attention: [] } as any,
      heartbeat: { status: 'never', schedulerEnabled: true, enabled: true, running: false, intervalMs: 30000, tickCount: 0, skippedTicks: 0 } as any,
      scheduler: { enabled: true },
      channels: { providers: [], sync: { active: false, syncEnabled: false, intervalMs: 3000, includeUserMessages: false, deliveriesTracked: 0, pendingInbound: 0 }, links: [] } as any,
      humanGates: [],
      questions: [],
      permissions: [],
      requestSourceAvailable: true,
      completionProposals: [],
      promotionScorecards: [],
      backups: [],
      recoveryDrills: [],
      runs: [],
      tasks: [],
      supervisors: [],
      alerts: [],
    })

    expect(summary.status).toBe('not_proven')
    expect(summary.alphaHealthy).toBeNull()
    expect(summary.indicators.find(indicator => indicator.id === 'backup_restore')?.items.map(item => item.detail)).toEqual([
      'No Gateway backup metadata found.',
      'No recovery drill evidence found.',
    ])
  })

  it('marks failed durable evidence as blocking alpha health', () => {
    const summary = buildAlphaHealthSummary({
      now,
      serviceHealth: { status: 'ok', generatedAt: now.toISOString(), summary: 'ok', components: [], counts: { ok: 1, degraded: 0, down: 0 }, attention: [] } as any,
      heartbeat: { status: 'ok', schedulerEnabled: true, enabled: true, running: false, intervalMs: 30000, tickCount: 1, skippedTicks: 0 } as any,
      scheduler: { enabled: true },
      channels: { providers: [{ provider: 'telegram', configured: true, enabled: true, bindings: 1, health: 'ok', note: 'ok' }], sync: { active: false, syncEnabled: true, intervalMs: 3000, includeUserMessages: true, deliveriesTracked: 0, pendingInbound: 0 }, links: [] } as any,
      requestSourceAvailable: true,
      promotionScorecards: [{ id: 'scorecard_block', subjectKind: 'profile', subjectName: 'reviewer', sourceId: 'eval', recommendation: 'hold', status: 'evaluated', thresholds: [{ id: 'score.min', passed: false }], updatedAt: now.toISOString() }],
      backups: [{ id: 'backup', path: '/backup', createdAt: now.toISOString(), ok: true, counts: {} } as any],
      recoveryDrills: [{ id: 'drill', status: 'fail', startedAt: now.toISOString(), completedAt: now.toISOString(), path: '/drill', evidencePath: '/drill/evidence.json', reportPath: '/drill/report.md', checks: { total: 2, passed: 1, failed: 1 }, error: 'restore-counts failed' }],
      runs: [{ id: 'run_a', taskId: 'task_dup', status: 'running' }, { id: 'run_b', taskId: 'task_dup', status: 'running' }],
      tasks: [{ id: 'task_blocked', title: 'Blocked alpha issue', status: 'blocked', updatedAt: now.toISOString() }],
      alerts: [{ id: 'alert_critical', severity: 'critical', status: 'active', summary: 'Critical alert', nextAction: 'Fix it' }],
    })

    expect(summary.status).toBe('blocked')
    expect(summary.alphaHealthy).toBe(false)
    expect(summary.blockers.map(blocker => blocker.label)).toEqual(expect.arrayContaining([
      'Latest recovery drill failed',
      'Scorecard blocks profile:reviewer',
      'Duplicate active runs for task_dup',
      'Blocked alpha issue',
      'Critical alert',
    ]))
  })
})
