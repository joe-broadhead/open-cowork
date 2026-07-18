import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  renderAnalyticsView,
  renderRoadmapDetailView,
  renderTaskDetailView,
  renderRunDetailView,
  renderDashboard,
} from '../dashboard.js'
import { clearConfigCacheForTest } from '../config.js'
import { clearWorkStateForTest, createRoadmap, createWorkTask, loadWorkStateReadOnly } from '../work-store.js'
import { getRoadmapDetailData, getRunDetailData, getTaskDetailData } from '../mission-data.js'
import type { AnalyticsSummary, AnalyticsScorecard } from '../analytics.js'

// A payload that breaks out of both text and attribute contexts. Every new view
// interpolates user/agent-authored data (titles, run results, keys) through the
// safe `html`/`attr` template, so the raw <script>/quote must never survive.
const XSS = `A<script>alert("x&y'z")</script>B`

function expectEscaped(out: string): void {
  expect(out).not.toContain('<script>alert')
  expect(out).toContain('&lt;script&gt;')
}

function analyticsSummary(): AnalyticsSummary {
  return {
    generatedAt: '2026-07-01T00:00:00.000Z',
    window: { since: 0, until: 1, sinceIso: '2026-06-01T00:00:00.000Z', untilIso: '2026-07-01T00:00:00.000Z', days: 30 },
    scope: {},
    dimension: 'profile',
    usageByDimension: [{ key: XSS, runCount: 3, costUsd: 0.5, tokens: 1200, runtimeMs: 4000 }],
    outcomeDistribution: { total: 5, running: 1, passed: 2, failed: 1, blocked: 1, errored: 0, completionRate: 0.5 },
    retryHotspots: [{ taskId: XSS, maxAttempt: 4, runCount: 6, costUsd: 0.9 }],
    budgetTrend: { enabled: true, note: `Budget note ${XSS}`, entries: [{ name: XSS, scope: 'global', windowCostUsd: 0.5, monthlyCostUsd: 10 }] },
  }
}

function analyticsScorecard(): AnalyticsScorecard {
  return {
    generatedAt: '2026-07-01T00:00:00.000Z',
    window: { since: 0, until: 1, sinceIso: '2026-06-01T00:00:00.000Z', untilIso: '2026-07-01T00:00:00.000Z', days: 30 },
    scope: {},
    dimension: 'profile',
    medians: { costUsd: 0.4, completionRate: 0.5 },
    scorecards: [{ key: XSS, totalRuns: 3, passed: 2, failed: 1, blocked: 0, errored: 0, running: 0, terminal: 3, completionRate: 0.66, avgAttempts: 1.5, completedTasks: 2, costUsd: 0.5, tokens: 1200, runtimeMs: 4000, costPerCompletedTask: 0.25, ...zeroErrorSplit() }],
    underperformers: [{ key: XSS, totalRuns: 3, passed: 0, failed: 3, blocked: 0, errored: 0, running: 0, terminal: 3, completionRate: 0, avgAttempts: 3, completedTasks: 0, costUsd: 0.9, tokens: 1000, runtimeMs: 3000, reason: `bad ${XSS}`, ...zeroErrorSplit() }],
    overall: { ...zeroErrorSplit(), terminal: 3 },
  }
}

function zeroErrorSplit() {
  return {
    errorClasses: { recovered_session: 0, force_done: 0, lease_expired: 0, provider_balance: 0, transport: 0, provider_error: 0, genuine_failure: 0, unknown: 0, total: 0 },
    operationalErrored: 0,
    externalErrored: 0,
    genuineErrored: 0,
    unknownErrored: 0,
    genuineFailureRate: 0,
  }
}

describe('dashboard analytics view', () => {
  it('renders spend, scorecard, outcomes, hotspots, underperformers, budget trend and escapes XSS', () => {
    const out = renderAnalyticsView({ summary: analyticsSummary(), scorecard: analyticsScorecard(), request: { windowDays: 30, by: 'profile' } })
    expect(out).toContain('Run Analytics')
    expect(out).toContain('Spend &amp; Usage by profile')
    expect(out).toContain('Completion Scorecard by profile')
    expect(out).toContain('Outcome Distribution')
    expect(out).toContain('Retry Hotspots')
    expect(out).toContain('Underperformers')
    expect(out).toContain('Budget Trend')
    // Retry hotspot drills into the task detail view.
    expect(out).toContain('view=task&id=')
    // Dimension scope controls present (URLSearchParams-built href escapes & to &amp;).
    expect(out).toContain('by=agent')
    expectEscaped(out)
  })

  it('preserves the full active scope (profile/agent/stage/roadmapId) in the window and dimension controls', () => {
    const out = renderAnalyticsView({
      summary: analyticsSummary(),
      scorecard: analyticsScorecard(),
      request: { windowDays: 30, by: 'profile', profile: 'impl-profile', agent: 'claude', stage: 'implement', roadmapId: 'rm-scope' },
    })
    // The 7d/90d window chips and the by-agent/by-roadmap dimension chips must all
    // carry the scoped params forward instead of dropping back to global scope.
    expect(out).toContain('profile=impl-profile')
    expect(out).toContain('agent=claude')
    expect(out).toContain('stage=implement')
    expect(out).toContain('roadmapId=rm-scope')
    // Present on a window chip (a control that previously kept only roadmapId).
    expect(out).toContain('window=90')
    expect(out).toContain('window=7')
  })

  it('renders an empty analytics window without crashing', () => {
    const summary: AnalyticsSummary = { ...analyticsSummary(), usageByDimension: [], retryHotspots: [], budgetTrend: { enabled: false, note: 'Governance disabled', entries: [] }, outcomeDistribution: { total: 0, running: 0, passed: 0, failed: 0, blocked: 0, errored: 0, completionRate: 0 } }
    const scorecard: AnalyticsScorecard = { ...analyticsScorecard(), scorecards: [], underperformers: [] }
    const out = renderAnalyticsView({ summary, scorecard, request: {} })
    expect(out).toContain('No runs in the selected window')
    expect(out).toContain('No terminal runs to score')
  })
})

describe('dashboard roadmap detail view', () => {
  it('renders tasks, dependencies, runs and drill-down links, escaping XSS', () => {
    const out = renderRoadmapDetailView({
      id: 'rm-1',
      roadmap: { id: 'rm-1', title: `Road ${XSS}`, status: XSS, priority: 'HIGH', agentTeam: XSS, updatedAt: '2026-06-13T00:00:00.000Z' },
      tasks: [
        { id: 'task-1', title: `Task ${XSS}`, status: 'running', priority: 'HIGH', currentStage: XSS },
        { id: 'task-2', title: 'Done task', status: 'done', priority: 'LOW' },
      ],
      dependencies: [{ taskId: 'task-1', dependsOnTaskId: 'task-2', type: 'blocks', createdAt: '2026-06-13T00:00:00.000Z' }],
      runs: [{ id: 'run-1', taskId: 'task-1', stage: XSS, sessionId: 'ses', profile: XSS, status: 'passed', attempt: 1, startedAt: '2026-06-13T00:00:00.000Z', costUsd: 0.5, inputTokens: 100, outputTokens: 20 }],
      summary: analyticsSummary(),
      statusFilter: undefined,
    })
    expect(out).toContain('view=task&id=task-1')
    expect(out).toContain('view=run&id=run-1')
    expectEscaped(out)
  })

  it('filters tasks by the server-side status query param', () => {
    const out = renderRoadmapDetailView({
      id: 'rm-1',
      roadmap: { id: 'rm-1', title: 'Road', status: 'active' },
      tasks: [
        { id: 'task-1', title: 'Running task', status: 'running' },
        { id: 'task-2', title: 'Done task', status: 'done' },
      ],
      dependencies: [],
      runs: [],
      statusFilter: 'done',
    })
    expect(out).toContain('view=task&id=task-2')
    expect(out).not.toContain('view=task&id=task-1')
  })

  it('shows a not-found empty state when the roadmap is missing', () => {
    const out = renderRoadmapDetailView({ id: 'rm-missing', roadmap: undefined, tasks: [], dependencies: [], runs: [] })
    expect(out).toContain('Roadmap not found')
  })
})

describe('dashboard task detail view', () => {
  it('renders status, deps, gates, runs and escapes XSS', () => {
    const out = renderTaskDetailView({
      id: 'task-1',
      task: { id: 'task-1', title: `Task ${XSS}`, description: `Desc ${XSS}`, status: 'blocked', priority: 'HIGH', currentStage: XSS, readiness: { status: 'blocked', reason: `Waiting ${XSS}` } },
      roadmap: { id: 'rm-1', title: `Road ${XSS}` },
      dependencies: [{ id: 'task-0', title: `Upstream ${XSS}`, status: 'done', type: 'blocks' }],
      dependents: [{ id: 'task-2', title: `Downstream ${XSS}`, status: 'pending' }],
      gates: [{ type: 'completion', status: 'pending', reason: `Gate ${XSS}` }],
      runs: [{ id: 'run-1', taskId: 'task-1', stage: 'implement', sessionId: 'ses', profile: 'impl', status: 'failed', attempt: 2, startedAt: '2026-06-13T00:00:00.000Z' }],
    })
    expect(out).toContain('view=task&id=task-0')
    expect(out).toContain('view=task&id=task-2')
    expect(out).toContain('view=roadmap&id=rm-1')
    expect(out).toContain('view=run&id=run-1')
    expect(out).toContain('Human Gates')
    expectEscaped(out)
  })

  it('shows a not-found empty state when the task is missing', () => {
    const out = renderTaskDetailView({ id: 'task-x', task: undefined, dependencies: [], dependents: [], gates: [], runs: [] })
    expect(out).toContain('Task not found')
  })
})

describe('dashboard run detail view', () => {
  it('renders status, cost, tokens, runtime and result, escaping XSS in the result', () => {
    const out = renderRunDetailView({
      id: 'run-1',
      run: { id: 'run-1', taskId: 'task-1', stage: 'implement', sessionId: 'ses', profile: 'impl', status: 'failed', attempt: 2, startedAt: '2026-06-13T00:00:00.000Z', completedAt: '2026-06-13T00:01:00.000Z', costUsd: 0.42, inputTokens: 1000, outputTokens: 200, reasoningTokens: 50, runtimeMs: 60000, result: { status: 'fail', summary: `Summary ${XSS}`, feedback: `Feedback ${XSS}`, artifacts: [], raw: `Raw ${XSS}`, failureClass: 'verification_failed' } },
    })
    expect(out).toContain('view=task&id=task-1')
    expect(out).toContain('$0.42')
    expect(out).toContain('verification_failed')
    expectEscaped(out)
  })

  it('shows a not-found empty state when the run is missing', () => {
    const out = renderRunDetailView({ id: 'run-x', run: undefined })
    expect(out).toContain('Run not found')
  })
})

describe('renderDashboard view router (seeded store, read-only)', () => {
  let testDir: string
  let store: string
  let roadmapId = ''
  let taskId = ''

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-dashboard-detail-'))
    store = path.join(testDir, 'gateway.db')
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    clearConfigCacheForTest()
    clearWorkStateForTest(store)
    roadmapId = createRoadmap({ title: 'Router Roadmap <b>' }, store).id
    taskId = createWorkTask({ title: 'Router Task <b>', roadmapId, pipeline: ['implement'] }, store).id
    const db = new DatabaseSync(store)
    try {
      db.prepare(
        `INSERT INTO runs (id, task_id, stage, session_id, profile, resolved_profile, resolved_agent, status, attempt, started_at, completed_at, cost_usd, input_tokens, output_tokens, runtime_ms)
         VALUES ('run_router', ?, 'implement', 'ses_router', 'impl', 'impl', 'claude', 'passed', 1, '2026-06-13T00:00:00.000Z', '2026-06-13T00:01:00.000Z', 0.25, 500, 100, 60000)`,
      ).run(taskId)
    } finally {
      db.close()
    }
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    clearConfigCacheForTest()
    try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {}
  })

  it('routes ?view=analytics to a server-rendered analytics page', async () => {
    const out = await renderDashboard(new URLSearchParams('view=analytics'))
    expect(out).toContain('<!DOCTYPE html>')
    expect(out).toContain('Run Analytics')
    expect(out).toContain('/live/events')
  })

  it('routes ?view=roadmap&id= to the seeded roadmap detail with drill-down links', async () => {
    const out = await renderDashboard(new URLSearchParams(`view=roadmap&id=${roadmapId}`))
    expect(out).toContain(`view=task&id=${taskId}`)
    expect(out).toContain('view=run&id=run_router')
    expect(out).not.toContain('<b>Router')
  })

  it('routes ?view=task&id= to the seeded task detail with its run history', async () => {
    const out = await renderDashboard(new URLSearchParams(`view=task&id=${taskId}`))
    expect(out).toContain('view=run&id=run_router')
    expect(out).toContain(`view=roadmap&id=${roadmapId}`)
  })

  it('routes ?view=run&id= to the seeded run detail', async () => {
    const out = await renderDashboard(new URLSearchParams('view=run&id=run_router'))
    expect(out).toContain('Run ')
    expect(out).toContain('$0.25')
    expect(out).toContain(`view=task&id=${taskId}`)
  })

  it('does not crash on unknown / missing detail ids', async () => {
    const roadmap = await renderDashboard(new URLSearchParams('view=roadmap&id=missing'))
    expect(roadmap).toContain('Roadmap not found')
    const run = await renderDashboard(new URLSearchParams('view=run'))
    expect(run).toContain('Run not found')
  })
})

describe('run drill-down is read-only (never creates the store)', () => {
  let testDir: string
  let store: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-dashboard-nodb-'))
    store = path.join(testDir, 'gateway.db')
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    clearConfigCacheForTest()
    // Intentionally do NOT create the store: this exercises a read-only drill-down
    // against a fresh state dir that has never been initialized.
    clearWorkStateForTest(store)
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    clearConfigCacheForTest()
    try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {}
  })

  it('renders a graceful not-found for ?view=run&id= without creating gateway.db', async () => {
    expect(fs.existsSync(store)).toBe(false)
    const out = await renderDashboard(new URLSearchParams('view=run&id=run_anything'))
    expect(out).toContain('Run not found')
    // A read view must never materialize the database or its schema as a side effect.
    expect(fs.existsSync(store)).toBe(false)
  })

  it('getRunDetailData reads read-only and never creates the store when it is absent', () => {
    expect(fs.existsSync(store)).toBe(false)
    // Read-only path: a missing store surfaces as a not-found error the render
    // layer catches; crucially it must not create the database or its schema.
    expect(() => getRunDetailData('run_anything')).toThrow(/not found/i)
    expect(fs.existsSync(store)).toBe(false)
  })
})

describe('roadmap/task detail render correctly with runs outside the live window', () => {
  let testDir: string
  let store: string
  let roadmapId = ''
  let taskId = ''

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-dashboard-outofwindow-'))
    store = path.join(testDir, 'gateway.db')
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    clearConfigCacheForTest()
    clearWorkStateForTest(store)
    roadmapId = createRoadmap({ title: 'Windowed Roadmap' }, store).id
    taskId = createWorkTask({ title: 'Windowed Task', roadmapId, pipeline: ['implement'] }, store).id
    // A second roadmap/task carries enough recent terminal runs to push the target
    // task's single old run out of the bounded live materialization window.
    const fillerRoadmapId = createRoadmap({ title: 'Filler Roadmap' }, store).id
    const fillerTaskId = createWorkTask({ title: 'Filler Task', roadmapId: fillerRoadmapId, pipeline: ['implement'] }, store).id
    const db = new DatabaseSync(store)
    try {
      const insert = db.prepare(
        `INSERT INTO runs (id, task_id, stage, session_id, profile, resolved_profile, resolved_agent, status, attempt, started_at, completed_at, cost_usd, input_tokens, output_tokens, runtime_ms)
         VALUES (?, ?, 'implement', ?, 'impl', 'impl', 'claude', 'passed', 1, ?, ?, 0.1, 10, 5, 1000)`,
      )
      db.exec('BEGIN')
      // The target task's only run is far in the past (2020) -> outside the recent
      // live window once the filler runs below exist.
      insert.run('run_old', taskId, 'ses_old', '2020-01-01T00:00:00.000Z', '2020-01-01T00:01:00.000Z')
      // 501 recent terminal runs (> LIVE_RECENT_TERMINAL_RUNS = 500) so run_old is
      // never among the top-500 recent terminal runs the live window materializes.
      for (let i = 0; i < 501; i++) {
        const ts = new Date(Date.UTC(2026, 5, 1, 0, 0, i)).toISOString()
        insert.run(`run_fill_${i}`, fillerTaskId, `ses_fill_${i}`, ts, ts)
      }
      db.exec('COMMIT')
    } finally {
      db.close()
    }
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    clearConfigCacheForTest()
    try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {}
  })

  it('confirms the old run is outside the live materialization window', () => {
    const live = loadWorkStateReadOnly(store, { runsScope: 'live' })
    // Proves the detail views cannot be relying on state.runs for the old run.
    expect(live.runs.some(run => run.id === 'run_old')).toBe(false)
  })

  it('roadmap detail surfaces the old run and its tasks without materializing all runs', () => {
    const detail = getRoadmapDetailData(roadmapId)
    expect(detail.roadmap?.id).toBe(roadmapId)
    expect(detail.tasks.map(task => task.id)).toContain(taskId)
    // Run comes from the targeted getRunsForRoadmap query, not the live window.
    expect(detail.runs.some(run => run.id === 'run_old')).toBe(true)
  })

  it('task detail surfaces the old run, readiness, and deps without materializing all runs', () => {
    const detail = getTaskDetailData(taskId)
    expect(detail.task?.id).toBe(taskId)
    expect(detail.task?.readiness).toBeDefined()
    // Run comes from the targeted getRunsForTask query, not the live window.
    expect(detail.runs.some(run => run.id === 'run_old')).toBe(true)
  })
})
