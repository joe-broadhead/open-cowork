import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { clearConfigCacheForTest, updateConfig } from '../config.js'
import { clearWorkStateForTest, createRoadmap, createWorkTask } from '../work-store.js'
import { getRunAnalyticsBundle, getRunAnalyticsGroups, type RunAnalyticsDimension } from '../work-store/analytics-queries.js'
import {
  buildAnalyticsScorecard,
  buildAnalyticsSummary,
  DEFAULT_ANALYTICS_WINDOW_DAYS,
  parseAnalyticsRequestFromParams,
} from '../analytics.js'
import { GATEWAY_TOOL_CATALOG } from '../gateway-tools.js'
import { classifyGatewayTool } from '../mcp-tool-tiers.js'
import { createJsonRoutes } from '../daemon-routes/index.js'
import { dispatchRoute } from '../daemon-router.js'
import { Readable } from 'node:stream'

// Ground-truth spec for one seeded run. The analytics SQL aggregates must match
// an independent JS computation over these specs, restricted to the same window.
interface RunSpec {
  taskId: string
  profile: string
  resolvedProfile?: string
  resolvedAgent?: string
  status: 'running' | 'passed' | 'failed' | 'blocked' | 'errored'
  attempt: number
  cost: number | null
  input: number
  output: number
  runtimeMs: number | null
  startedAtMs: number
}

const DAY = 24 * 60 * 60 * 1000

describe('run-history analytics', () => {
  let testDir: string
  let store: string
  const now = Date.parse('2026-07-01T12:00:00.000Z')
  const day = (n: number) => now - n * DAY

  // Roadmap/task ids are assigned during seed().
  let rmA = ''
  let rmB = ''
  let tA1 = ''
  let tA2 = ''
  let tB1 = ''
  let specs: RunSpec[] = []

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-analytics-'))
    store = path.join(testDir, 'gateway.db')
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    clearConfigCacheForTest()
    clearWorkStateForTest(store)
    seed()
  })

  // Extra scenario stores created by seedProfileRuns(); cleaned up after each test.
  const extraDirs: string[] = []

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    clearConfigCacheForTest()
    try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {}
    while (extraDirs.length) { try { fs.rmSync(extraDirs.pop()!, { recursive: true, force: true }) } catch {} }
  })

  // Seed a fresh store with hand-built per-profile runs so underperformer/scope
  // scenarios can be reasoned independently of the shared seed. Profile grouping
  // does not join tasks, so arbitrary task ids are fine.
  interface ProfileRun {
    profile: string
    resolvedAgent?: string
    status: 'passed' | 'failed' | 'blocked' | 'errored' | 'running'
    cost: number | null
    taskId?: string
    attempt?: number
  }
  function seedProfileRuns(runs: ProfileRun[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-analytics-x-'))
    extraDirs.push(dir)
    const s = path.join(dir, 'gateway.db')
    clearWorkStateForTest(s)
    // A work-store write initializes the schema (the runs table) for this store.
    createRoadmap({ title: 'seed' }, s)
    const db = new DatabaseSync(s)
    try {
      const insert = db.prepare(
        `INSERT INTO runs (id, task_id, stage, session_id, profile, resolved_profile, resolved_agent, status, attempt, started_at, completed_at, cost_usd, input_tokens, output_tokens, runtime_ms)
         VALUES (?, ?, 'implement', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)`,
      )
      runs.forEach((r, i) => {
        const startedAt = new Date(now - DAY).toISOString()
        const completedAt = r.status === 'running' ? null : new Date(now - DAY + 1000).toISOString()
        insert.run(`run_${i}`, r.taskId ?? `task_${i}`, `ses_${i}`, r.profile, r.profile, r.resolvedAgent ?? null, r.status, r.attempt ?? 1, startedAt, completedAt, r.cost)
      })
    } finally {
      db.close()
    }
    return s
  }

  function seed(): void {
    rmA = createRoadmap({ title: 'Roadmap A' }, store).id
    rmB = createRoadmap({ title: 'Roadmap B' }, store).id
    tA1 = createWorkTask({ title: 'A1', roadmapId: rmA, pipeline: ['implement'] }, store).id
    tA2 = createWorkTask({ title: 'A2', roadmapId: rmA, pipeline: ['implement'] }, store).id
    tB1 = createWorkTask({ title: 'B1', roadmapId: rmB, pipeline: ['implement'] }, store).id

    specs = [
      { taskId: tA1, profile: 'x', resolvedProfile: 'impl', resolvedAgent: 'claude', status: 'passed', attempt: 1, cost: 0.10, input: 100, output: 10, runtimeMs: 1000, startedAtMs: day(1) },
      { taskId: tA1, profile: 'x', resolvedProfile: 'impl', resolvedAgent: 'claude', status: 'failed', attempt: 2, cost: 0.20, input: 200, output: 20, runtimeMs: 2000, startedAtMs: day(2) },
      { taskId: tA2, profile: 'x', resolvedProfile: 'impl', resolvedAgent: 'gpt', status: 'passed', attempt: 1, cost: 0.05, input: 50, output: 5, runtimeMs: 500, startedAtMs: day(1) },
      { taskId: tB1, profile: 'x', resolvedProfile: 'review', resolvedAgent: 'claude', status: 'blocked', attempt: 3, cost: 0.30, input: 300, output: 30, runtimeMs: 3000, startedAtMs: day(3) },
      { taskId: tB1, profile: 'x', resolvedProfile: 'review', resolvedAgent: 'gpt', status: 'errored', attempt: 1, cost: 0.15, input: 150, output: 15, runtimeMs: 1500, startedAtMs: day(2) },
      // running run: null cost + null runtime + null completed_at (tests COALESCE handling).
      { taskId: tA1, profile: 'x', resolvedProfile: 'review', resolvedAgent: 'claude', status: 'running', attempt: 1, cost: null, input: 0, output: 0, runtimeMs: null, startedAtMs: day(0) },
      // profile-only fallback (no resolved_profile) and unassigned agent.
      { taskId: tB1, profile: 'legacy', status: 'passed', attempt: 1, cost: 0.08, input: 80, output: 8, runtimeMs: 800, startedAtMs: day(1) },
      // OUT OF WINDOW: 60 days ago, would inflate impl/roadmapA spend if not filtered.
      { taskId: tA2, profile: 'x', resolvedProfile: 'impl', resolvedAgent: 'claude', status: 'passed', attempt: 1, cost: 1.00, input: 1000, output: 100, runtimeMs: 5000, startedAtMs: day(60) },
    ]

    const db = new DatabaseSync(store)
    try {
      const insert = db.prepare(
        `INSERT INTO runs (id, task_id, stage, session_id, profile, resolved_profile, resolved_agent, status, attempt, started_at, completed_at, cost_usd, input_tokens, output_tokens, runtime_ms)
         VALUES (?, ?, 'implement', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      specs.forEach((spec, i) => {
        const startedAt = new Date(spec.startedAtMs).toISOString()
        const completedAt = spec.status === 'running' ? null : new Date(spec.startedAtMs + (spec.runtimeMs || 0)).toISOString()
        insert.run(
          `run_${i}`, spec.taskId, `ses_${i}`, spec.profile,
          spec.resolvedProfile ?? null, spec.resolvedAgent ?? null,
          spec.status, spec.attempt, startedAt, completedAt,
          spec.cost, spec.input, spec.output, spec.runtimeMs,
        )
      })
    } finally {
      db.close()
    }
  }

  // ---- Independent ground truth (plain JS over the spec array) ----
  const roadmapOf = (taskId: string): string => (taskId === tB1 ? rmB : rmA)
  const effProfile = (s: RunSpec): string => s.resolvedProfile || s.profile
  const effAgent = (s: RunSpec): string => s.resolvedAgent || '(unassigned)'
  const tokensOf = (s: RunSpec): number => s.input + s.output
  const inWindow = (sinceMs: number, untilMs: number) => (s: RunSpec) => s.startedAtMs >= sinceMs && s.startedAtMs < untilMs

  function keyOf(dimension: RunAnalyticsDimension, s: RunSpec): string {
    if (dimension === 'agent') return effAgent(s)
    if (dimension === 'roadmap') return roadmapOf(s.taskId)
    return effProfile(s)
  }

  function expectedGroups(dimension: RunAnalyticsDimension, rows: RunSpec[]) {
    const map = new Map<string, { cost: number; tokens: number; runtime: number; runs: number; passed: number; terminal: number; completedTasks: Set<string>; attemptSum: number }>()
    for (const s of rows) {
      const key = keyOf(dimension, s)
      const agg = map.get(key) || { cost: 0, tokens: 0, runtime: 0, runs: 0, passed: 0, terminal: 0, completedTasks: new Set<string>(), attemptSum: 0 }
      agg.cost += s.cost || 0
      agg.tokens += tokensOf(s)
      agg.runtime += s.runtimeMs || 0
      agg.runs += 1
      agg.attemptSum += s.attempt
      if (s.status !== 'running') agg.terminal += 1
      if (s.status === 'passed') { agg.passed += 1; agg.completedTasks.add(s.taskId) }
      map.set(key, agg)
    }
    return map
  }

  const windowRows = () => specs.filter(inWindow(day(DEFAULT_ANALYTICS_WINDOW_DAYS), now))

  it('groups spend/usage by profile (resolved preferred, profile fallback) inside the window', () => {
    const rows = windowRows()
    const expected = expectedGroups('profile', rows)
    const groups = getRunAnalyticsGroups('profile', { since: day(DEFAULT_ANALYTICS_WINDOW_DAYS), until: now }, store)

    expect(new Set(groups.map(g => g.key))).toEqual(new Set(expected.keys()))
    for (const g of groups) {
      const e = expected.get(g.key)!
      expect(g.costUsd).toBeCloseTo(e.cost, 10)
      expect(g.tokens).toBe(e.tokens)
      expect(g.runtimeMs).toBe(e.runtime)
      expect(g.runCount).toBe(e.runs)
      expect(g.completedTasks).toBe(e.completedTasks.size)
    }
    // profile fallback key exists (run with no resolved_profile).
    expect(groups.find(g => g.key === 'legacy')).toBeDefined()
    // impl spend excludes the 60-day-old out-of-window run (would be +1.00).
    expect(groups.find(g => g.key === 'impl')!.costUsd).toBeCloseTo(0.10 + 0.20 + 0.05, 10)
  })

  it('groups by agent (unassigned fallback) and roadmap (task join)', () => {
    const rows = windowRows()
    for (const dimension of ['agent', 'roadmap'] as const) {
      const expected = expectedGroups(dimension, rows)
      const groups = getRunAnalyticsGroups(dimension, { since: day(DEFAULT_ANALYTICS_WINDOW_DAYS), until: now }, store)
      expect(new Set(groups.map(g => g.key))).toEqual(new Set(expected.keys()))
      for (const g of groups) {
        expect(g.costUsd).toBeCloseTo(expected.get(g.key)!.cost, 10)
        expect(g.tokens).toBe(expected.get(g.key)!.tokens)
      }
    }
    const agentGroups = getRunAnalyticsGroups('agent', { since: day(DEFAULT_ANALYTICS_WINDOW_DAYS), until: now }, store)
    expect(agentGroups.find(g => g.key === '(unassigned)')).toBeDefined()
  })

  it('excludes runs outside the window and includes them when the window widens', () => {
    const narrow = getRunAnalyticsGroups('profile', { since: day(DEFAULT_ANALYTICS_WINDOW_DAYS), until: now }, store)
    const wide = getRunAnalyticsGroups('profile', { since: day(90), until: now }, store)
    const implNarrow = narrow.find(g => g.key === 'impl')!
    const implWide = wide.find(g => g.key === 'impl')!
    // The out-of-window run adds one run, +1.00 cost, +1100 tokens.
    expect(implWide.runCount - implNarrow.runCount).toBe(1)
    expect(implWide.costUsd - implNarrow.costUsd).toBeCloseTo(1.00, 10)
    expect(implWide.tokens - implNarrow.tokens).toBe(1100)
  })

  it('computes the outcome distribution and retry hotspots in SQL', () => {
    const rows = windowRows()
    const bundle = getRunAnalyticsBundle('profile', { since: day(DEFAULT_ANALYTICS_WINDOW_DAYS), until: now }, { hotspotLimit: 10 }, store)
    const count = (status: string) => rows.filter(s => s.status === status).length
    expect(bundle.outcomes).toEqual({
      total: rows.length,
      running: count('running'),
      passed: count('passed'),
      failed: count('failed'),
      blocked: count('blocked'),
      errored: count('errored'),
    })
    // Hotspots: tasks with max attempt > 1, ordered by max attempt desc.
    expect(bundle.retryHotspots.map(h => h.taskId)).toEqual([tB1, tA1])
    expect(bundle.retryHotspots[0]!.maxAttempt).toBe(3)
    expect(bundle.retryHotspots[0]!.roadmapId).toBe(rmB)
    expect(bundle.retryHotspots[1]!.maxAttempt).toBe(2)
  })

  it('summary matches ground-truth completion rate and usage', () => {
    const summary = buildAnalyticsSummary({}, store, now)
    const rows = windowRows()
    const passed = rows.filter(s => s.status === 'passed').length
    const terminal = rows.filter(s => s.status !== 'running').length
    expect(summary.outcomeDistribution.completionRate).toBeCloseTo(passed / terminal, 10)
    expect(summary.window.days).toBe(DEFAULT_ANALYTICS_WINDOW_DAYS)
    const totalCost = summary.usageByDimension.reduce((sum, r) => sum + r.costUsd, 0)
    expect(totalCost).toBeCloseTo(rows.reduce((sum, s) => sum + (s.cost || 0), 0), 10)
  })

  it('scorecard computes completion rate, avg attempts, and cost-per-completed', () => {
    const scorecard = buildAnalyticsScorecard({ by: 'profile' }, store, now)
    const rows = windowRows()
    const expected = expectedGroups('profile', rows)

    for (const card of scorecard.scorecards) {
      const e = expected.get(card.key)!
      expect(card.completionRate).toBeCloseTo(e.terminal > 0 ? e.passed / e.terminal : 0, 10)
      expect(card.avgAttempts).toBeCloseTo(e.attemptSum / e.runs, 10)
      if (e.completedTasks.size > 0) expect(card.costPerCompletedTask).toBeCloseTo(e.cost / e.completedTasks.size, 10)
      else expect(card.costPerCompletedTask).toBeUndefined()
    }
  })

  // Underperformer semantics: a group is flagged only when it is STRICTLY worse
  // than its peers on BOTH axes — above median spend AND below median completion.
  // Ground truth below is reasoned by hand, not copied from the implementation.
  it('flags only the genuinely-worse group (strictly above-median cost AND below-median completion)', () => {
    // Four rated profiles:
    //   cheap:  cost 0.01, completion 1.0   (passed)
    //   rich:   cost 1.00, completion 1.0   (passed x2 @ 0.50)  <- HIGH cost, 100% completion
    //   mid:    cost 0.80, completion 0.5   (passed + failed)
    //   worst:  cost 0.90, completion 0.0   (failed x2 @ 0.45)  <- genuinely worse
    // median cost = median(0.01,0.80,0.90,1.00) = (0.80+0.90)/2 = 0.85
    // median completion = median(0,0.5,1,1) = (0.5+1)/2 = 0.75
    // strictly worse (cost>0.85 AND completion<0.75): only `worst`.
    // `rich` (cost 1.00 > 0.85 but completion 1.0 not < 0.75) is NOT flagged.
    const s = seedProfileRuns([
      { profile: 'cheap', status: 'passed', cost: 0.01 },
      { profile: 'rich', status: 'passed', cost: 0.50 },
      { profile: 'rich', status: 'passed', cost: 0.50 },
      { profile: 'mid', status: 'passed', cost: 0.40 },
      { profile: 'mid', status: 'failed', cost: 0.40 },
      { profile: 'worst', status: 'failed', cost: 0.45 },
      { profile: 'worst', status: 'failed', cost: 0.45 },
    ])
    const scorecard = buildAnalyticsScorecard({ by: 'profile' }, s, now)
    expect(scorecard.medians.costUsd).toBeCloseTo(0.85, 10)
    expect(scorecard.medians.completionRate).toBeCloseTo(0.75, 10)
    const flagged = scorecard.underperformers.map(u => u.key)
    expect(flagged).toEqual(['worst'])
    // The high-cost, 100%-completion group must never be flagged.
    expect(flagged).not.toContain('rich')
    expect(scorecard.underperformers[0]!.reason).toMatch(/> median/)
  })

  it('does NOT flag a high-cost 100%-completion group when completion is at/above the median', () => {
    // All three groups complete 100% of terminal runs; only cost differs.
    // median completion = 1.0, so no group is STRICTLY below it -> none flagged,
    // even the highest-spend group. (The old non-strict predicate flagged these.)
    const s = seedProfileRuns([
      { profile: 'a', status: 'passed', cost: 0.01 },
      { profile: 'b', status: 'passed', cost: 0.50 },
      { profile: 'c', status: 'passed', cost: 1.00 },
    ])
    const scorecard = buildAnalyticsScorecard({ by: 'profile' }, s, now)
    expect(scorecard.medians.completionRate).toBeCloseTo(1, 10)
    expect(scorecard.underperformers).toHaveLength(0)
  })

  it('flags no underperformers when only a single group has terminal runs', () => {
    // One rated group: median == itself on both axes, so it is not strictly worse
    // than any peer and must not be flagged (guards the self-median false positive).
    const s = seedProfileRuns([
      { profile: 'solo', status: 'failed', cost: 0.90 },
      { profile: 'solo', status: 'blocked', cost: 0.10 },
    ])
    const scorecard = buildAnalyticsScorecard({ by: 'profile' }, s, now)
    const rated = scorecard.scorecards.filter(c => c.terminal > 0)
    expect(rated).toHaveLength(1)
    expect(scorecard.underperformers).toHaveLength(0)
  })

  it('reports budget trend actuals when governance budgets are configured', () => {
    updateConfig({ governance: { enabled: true, roadmaps: { [rmA]: { monthlyCostUsd: 5 } } } as any })
    clearConfigCacheForTest()
    const summary = buildAnalyticsSummary({ roadmapId: rmA }, store, now)
    expect(summary.budgetTrend.enabled).toBe(true)
    const roadmapEntry = summary.budgetTrend.entries.find(e => e.roadmapId === rmA)
    expect(roadmapEntry).toBeDefined()
    expect(roadmapEntry!.monthlyCostUsd).toBe(5)
    // Window spend for roadmap A = in-window roadmap-A runs.
    const expectedSpend = windowRows().filter(s => roadmapOf(s.taskId) === rmA).reduce((sum, s) => sum + (s.cost || 0), 0)
    expect(roadmapEntry!.windowCostUsd).toBeCloseTo(expectedSpend, 10)
  })

  it('scopes the agent filter through the coalesced (unassigned) key it emits', () => {
    // The 'legacy' run has a NULL resolved_agent, so it groups under '(unassigned)'.
    const groups = getRunAnalyticsGroups('agent', { since: day(DEFAULT_ANALYTICS_WINDOW_DAYS), until: now }, store)
    const unassigned = groups.find(g => g.key === '(unassigned)')!
    expect(unassigned).toBeDefined()

    // Drilling into '(unassigned)' must return that group's rows (regression: the
    // raw `resolved_agent = ?` filter matched zero rows for the emitted key).
    const scoped = getRunAnalyticsGroups('agent', { since: day(DEFAULT_ANALYTICS_WINDOW_DAYS), until: now, agent: '(unassigned)' }, store)
    expect(scoped).toHaveLength(1)
    expect(scoped[0]!.key).toBe('(unassigned)')
    expect(scoped[0]!.runCount).toBe(unassigned.runCount)
    expect(scoped[0]!.costUsd).toBeCloseTo(unassigned.costUsd, 10)

    // A concrete agent still scopes correctly.
    const claude = groups.find(g => g.key === 'claude')!
    const scopedClaude = getRunAnalyticsGroups('agent', { since: day(DEFAULT_ANALYTICS_WINDOW_DAYS), until: now, agent: 'claude' }, store)
    expect(scopedClaude).toHaveLength(1)
    expect(scopedClaude[0]!.costUsd).toBeCloseTo(claude.costUsd, 10)
  })

  it('handles out-of-range window/since without throwing a RangeError', () => {
    const isIso = (v: string) => !Number.isNaN(Date.parse(v))
    // ?since far beyond the max representable Date instant.
    const overflow = parseAnalyticsRequestFromParams(new URLSearchParams('since=1e16'))
    const s1 = buildAnalyticsSummary(overflow, store, now)
    expect(isIso(s1.window.sinceIso)).toBe(true)
    expect(isIso(s1.window.untilIso)).toBe(true)
    // A huge window pushing `since` below the min representable instant.
    const s2 = buildAnalyticsSummary({ windowDays: 1e15 }, store, now)
    expect(isIso(s2.window.sinceIso)).toBe(true)
    // since below the min instant, and the scorecard path, must also be safe.
    expect(() => buildAnalyticsSummary({ since: -1e16 }, store, now)).not.toThrow()
    expect(() => buildAnalyticsScorecard({ since: 1e16 }, store, now)).not.toThrow()
  })

  it('reconciles budget-trend window spend with the summed usageByDimension for the same window+scope', () => {
    updateConfig({ governance: { enabled: true, global: { monthlyCostUsd: 100 } } as any })
    clearConfigCacheForTest()
    // Unscoped: the global entry's window spend equals the full window total.
    const summary = buildAnalyticsSummary({}, store, now)
    const globalEntry = summary.budgetTrend.entries.find(e => e.scope === 'global')!
    expect(globalEntry).toBeDefined()
    const totalCost = summary.usageByDimension.reduce((sum, r) => sum + r.costUsd, 0)
    expect(globalEntry.windowCostUsd).toBeCloseTo(totalCost, 10)

    // Scoped by profile: window spend reconciles against the scoped dimension total.
    const scoped = buildAnalyticsSummary({ profile: 'impl' }, store, now)
    const scopedGlobal = scoped.budgetTrend.entries.find(e => e.scope === 'global')!
    const scopedTotal = scoped.usageByDimension.reduce((sum, r) => sum + r.costUsd, 0)
    expect(scopedGlobal.windowCostUsd).toBeCloseTo(scopedTotal, 10)
  })

  it('notes that budget comparison lives in governance when disabled', () => {
    updateConfig({ governance: { enabled: false } as any })
    clearConfigCacheForTest()
    const summary = buildAnalyticsSummary({}, store, now)
    expect(summary.budgetTrend.enabled).toBe(false)
    expect(summary.budgetTrend.note).toMatch(/governance/i)
  })

  it('parses analytics request query params', () => {
    const request = parseAnalyticsRequestFromParams(new URLSearchParams('window=14&by=agent&roadmapId=rm_1&limit=3'))
    expect(request).toMatchObject({ windowDays: 14, by: 'agent', roadmapId: 'rm_1', hotspotLimit: 3 })
  })

  it('serves GET /analytics as summary and scorecard shapes', async () => {
    const routes = createJsonRoutes()
    const ctx = (path: string) => {
      const req = Readable.from([]) as any
      req.method = 'GET'
      req.headers = {}
      return { req, url: new URL(path, 'http://127.0.0.1:4097'), client: {}, channels: new Map<string, any>() }
    }
    const summary = await dispatchRoute(routes, ctx('/analytics?by=profile'))
    expect(summary?.status).toBe(200)
    expect((summary?.body as any).analytics).toMatchObject({ dimension: 'profile' })
    expect(Array.isArray((summary?.body as any).analytics.usageByDimension)).toBe(true)
    expect((summary?.body as any).analytics.outcomeDistribution).toHaveProperty('completionRate')

    const scorecard = await dispatchRoute(routes, ctx('/analytics?view=scorecard&by=agent'))
    expect(scorecard?.status).toBe(200)
    expect((scorecard?.body as any).analytics).toMatchObject({ dimension: 'agent' })
    expect(Array.isArray((scorecard?.body as any).analytics.scorecards)).toBe(true)
    expect((scorecard?.body as any).analytics).toHaveProperty('underperformers')
  })

  it('registers both analytics MCP tools as read-tier in the catalog', () => {
    for (const name of ['analytics_summary', 'analytics_scorecard']) {
      const entry = GATEWAY_TOOL_CATALOG.find(t => t.name === name)
      expect(entry, name).toBeDefined()
      expect(entry!.group).toBe('analytics')
      expect(classifyGatewayTool(name)).toBe('read')
    }
  })

  // ---- #202 error-class classification -----------------------------------

  // Seed a fresh store with errored runs carrying a specific result_json summary
  // so the classification SQL can be exercised per class. Non-errored runs may
  // also be seeded (status !== 'errored') to test the genuineFailureRate divisor.
  interface ErroredRun { profile: string; status: 'errored' | 'passed' | 'failed'; summary?: string }
  function seedErroredRuns(runs: ErroredRun[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-analytics-err-'))
    extraDirs.push(dir)
    const s = path.join(dir, 'gateway.db')
    clearWorkStateForTest(s)
    createRoadmap({ title: 'seed' }, s)
    const db = new DatabaseSync(s)
    try {
      const insert = db.prepare(
        `INSERT INTO runs (id, task_id, stage, session_id, profile, resolved_profile, status, attempt, started_at, completed_at, cost_usd, input_tokens, output_tokens, runtime_ms, result_json)
         VALUES (?, ?, 'implement', ?, ?, ?, ?, 1, ?, ?, 0, 0, 0, 0, ?)`,
      )
      const startedAt = new Date(now - DAY).toISOString()
      const completedAt = new Date(now - DAY + 1000).toISOString()
      runs.forEach((r, i) => {
        const result = r.summary === undefined
          ? null
          : JSON.stringify({ status: 'blocked', summary: r.summary, feedback: r.summary, artifacts: [], raw: r.summary })
        insert.run(`run_${i}`, `task_${i}`, `ses_${i}`, r.profile, r.profile, r.status, startedAt, completedAt, result)
      })
    } finally {
      db.close()
    }
    return s
  }

  it('classifies each errored run by cause into the right class', () => {
    const s = seedErroredRuns([
      { profile: 'p', status: 'errored', summary: 'Recovered missing OpenCode session' },
      { profile: 'p', status: 'errored', summary: 'done requested by Gateway' },
      { profile: 'p', status: 'errored', summary: 'Recovered expired scheduler lease' },
      { profile: 'p', status: 'errored', summary: 'HTTP 402: [DeepSeek] Insufficient Balance' },
      { profile: 'p', status: 'errored', summary: 'fetch failed' },
      { profile: 'p', status: 'errored', summary: 'HTTP 401 unauthorized' },
      { profile: 'p', status: 'errored', summary: 'the implement step produced no passing diff' },
    ])
    const [row] = getRunAnalyticsGroups('profile', { since: day(DEFAULT_ANALYTICS_WINDOW_DAYS), until: now }, s)
    const ec = row!.errorClasses
    expect(ec).toMatchObject({
      recovered_session: 1,
      force_done: 1,
      lease_expired: 1,
      provider_balance: 1,
      transport: 1,
      provider_error: 1,
      genuine_failure: 1,
      total: 7,
    })
  })

  it('splits errored runs into operational / external / genuine and computes genuineFailureRate excluding operational classes', () => {
    // Mirrors the dogfood implementer shape: overwhelmingly session-recovery
    // churn + a provider-balance blip, with only a couple of genuine failures.
    const s = seedErroredRuns([
      ...Array.from({ length: 69 }, () => ({ profile: 'implementer', status: 'errored' as const, summary: 'Recovered missing OpenCode session' })),
      ...Array.from({ length: 4 }, () => ({ profile: 'implementer', status: 'errored' as const, summary: 'done requested by Gateway' })),
      { profile: 'implementer', status: 'errored', summary: 'Recovered expired scheduler lease' },
      { profile: 'implementer', status: 'errored', summary: 'HTTP 402: Insufficient Balance' },
      { profile: 'implementer', status: 'errored', summary: 'fetch failed' },
      ...Array.from({ length: 3 }, () => ({ profile: 'implementer', status: 'errored' as const, summary: 'the diff did not satisfy the spec' })),
      ...Array.from({ length: 25 }, () => ({ profile: 'implementer', status: 'passed' as const })),
    ])
    const scorecard = buildAnalyticsScorecard({ by: 'profile' }, s, now)
    const row = scorecard.scorecards.find(c => c.key === 'implementer')!
    expect(row.errored).toBe(79) // 69 + 4 + 1 + 1 + 1 + 3
    expect(row.operationalErrored).toBe(74) // 69 recovered + 4 force-done + 1 lease
    expect(row.externalErrored).toBe(2) // provider_balance + transport
    expect(row.genuineErrored).toBe(3)
    // terminal = 25 passed + 79 errored = 104; genuineFailureRate = 3/104, NOT 79/104.
    expect(row.terminal).toBe(104)
    expect(row.genuineFailureRate).toBeCloseTo(3 / 104, 10)
    // The overall window rollup sums to the same split.
    expect(scorecard.overall.operationalErrored).toBe(74)
    expect(scorecard.overall.genuineErrored).toBe(3)
    expect(scorecard.overall.errorClasses.total).toBe(79)
  })

  it('gives a per-profile error-class breakdown', () => {
    const s = seedErroredRuns([
      { profile: 'a', status: 'errored', summary: 'Recovered missing OpenCode session' },
      { profile: 'a', status: 'errored', summary: 'Recovered missing OpenCode session' },
      { profile: 'b', status: 'errored', summary: 'genuine blow up' },
    ])
    const groups = getRunAnalyticsGroups('profile', { since: day(DEFAULT_ANALYTICS_WINDOW_DAYS), until: now }, s)
    const a = groups.find(g => g.key === 'a')!
    const b = groups.find(g => g.key === 'b')!
    expect(a.errorClasses.recovered_session).toBe(2)
    expect(a.errorClasses.genuine_failure).toBe(0)
    expect(b.errorClasses.genuine_failure).toBe(1)
    expect(b.errorClasses.recovered_session).toBe(0)
  })

  // FIX 1 regression: a genuine implement failure whose text incidentally
  // contains a bare status-code-looking number must NOT be misclassified as
  // external. Only HTTP-context patterns (HTTP 402/429/504) select a provider/
  // transport class; a bare digit run stays genuine so the #205 alert can fire.
  it('classifies incidental bare status numbers in genuine-failure text as genuine, not external', () => {
    const s = seedErroredRuns([
      { profile: 'p', status: 'errored', summary: 'expected 429 items but the diff produced 512' },
      { profile: 'p', status: 'errored', summary: 'the diff touched 504 lines and still failed the spec' },
      { profile: 'p', status: 'errored', summary: 'refactor overshot the $0.402 budget note and broke tests' },
      // Control: the durable provider/transport text always carries the HTTP
      // prefix, so a real one still classifies out of the genuine cohort.
      { profile: 'p', status: 'errored', summary: 'HTTP 429: too many requests' },
      { profile: 'p', status: 'errored', summary: 'HTTP 504 gateway timeout upstream' },
    ])
    const [row] = getRunAnalyticsGroups('profile', { since: day(DEFAULT_ANALYTICS_WINDOW_DAYS), until: now }, s)
    const ec = row!.errorClasses
    expect(ec.genuine_failure).toBe(3) // the three incidental-number failures
    expect(ec.provider_error).toBe(1) // HTTP 429
    expect(ec.transport).toBe(1) // HTTP 504
    expect(ec.total).toBe(5)
  })

  // FIX 3: an errored run with NULL/empty result_json (crash/abort before the
  // result was written) classifies as `unknown`, is kept out of the genuine
  // cohort, and so never inflates genuineFailureRate.
  it('classifies a resultless errored run as unknown, excluded from the genuine cohort', () => {
    const s = seedErroredRuns([
      ...Array.from({ length: 10 }, () => ({ profile: 'crashy', status: 'errored' as const })), // no summary -> NULL result_json
      ...Array.from({ length: 5 }, () => ({ profile: 'crashy', status: 'passed' as const })),
    ])
    const scorecard = buildAnalyticsScorecard({ by: 'profile' }, s, now)
    const row = scorecard.scorecards.find(c => c.key === 'crashy')!
    expect(row.errorClasses.unknown).toBe(10)
    expect(row.errorClasses.genuine_failure).toBe(0)
    expect(row.unknownErrored).toBe(10)
    expect(row.genuineErrored).toBe(0)
    // 10 unknown errored + 5 passed = 15 terminal; genuineFailureRate stays 0.
    expect(row.terminal).toBe(15)
    expect(row.genuineFailureRate).toBe(0)
    expect(scorecard.overall.unknownErrored).toBe(10)
    expect(scorecard.overall.errorClasses.total).toBe(10)
  })
})
