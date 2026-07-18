import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildPerformanceBudgetReport,
  formatPerformanceBudgetReport,
  type PerformanceBudgetRow,
} from '../performance-budgets.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

describe('M40 performance and responsiveness budgets', () => {
  let testDir: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-performance-budgets-'))
  })

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  it('builds a passing bounded local-beta budget report for required surfaces', () => {
    const report = buildPerformanceBudgetReport({ generatedAt: '2026-06-25T14:45:00.000Z' })
    const ids = report.budgets.map(row => row.id)
    const serialized = JSON.stringify(report)

    expect(report.status).toBe('pass')
    expect(report.releaseClaim).toBe('configured_local_performance_budget_evidence_only_no_arbitrary_scale_claim')
    expect(ids).toEqual([
      'mission_control_tasks_window',
      'queue_views_runs_window',
      'channel_status_window',
      'readiness_queue_status_budget',
      'proof_export_evidence_window',
      'incident_bundle_windows',
    ])
    expect(report.failingBudgets).toEqual([])
    expect(report.budgets.every(row => row.safeNextAction.length > 10)).toBe(true)
    expect(report.budgets.find(row => row.id === 'mission_control_tasks_window')).toMatchObject({
      status: 'pass',
      observed: expect.objectContaining({ shown: 500, limit: 500, hasMore: true, state: 'partial' }),
    })
    expect(report.budgets.find(row => row.id === 'channel_status_window')).toMatchObject({
      status: 'pass',
      observed: expect.objectContaining({ shown: 250, limit: 250, hasMore: true, search: 'telegram' }),
    })
    expect(report.budgets.find(row => row.id === 'proof_export_evidence_window')).toMatchObject({
      status: 'pass',
      observed: expect.objectContaining({ totalRows: 420, selectedRows: 100 }),
    })
    expect(report.unsupportedClaims).toEqual(expect.arrayContaining([
      'arbitrary-scale readiness',
      'hosted/team performance readiness',
      'unattended production operation',
    ]))
    expect(serialized).not.toMatch(/\/Users\/|Bearer |telegram-secret|trusted-chat|private transcript|raw provider payload/i)
  })

  it('formats failing budgets with named diagnostics and safe next actions', () => {
    const row: PerformanceBudgetRow = {
      id: 'mission_control_tasks_window',
      surface: 'Mission Control Issues window',
      status: 'fail',
      summary: 'Mission Control tried to render an unbounded task list.',
      observed: { shown: 750, limit: 999 },
      budget: { maxLimit: 500 },
      safeNextAction: 'Restore the Mission Control task window clamp.',
      diagnostics: ['mission_control_tasks_window exceeded budget; Observed {"shown":750,"limit":999}'],
    }
    const base = buildPerformanceBudgetReport({ generatedAt: '2026-06-25T14:45:00.000Z' })
    const text = formatPerformanceBudgetReport({
      ...base,
      status: 'fail',
      budgets: [row],
      failingBudgets: [{ id: row.id, safeNextAction: row.safeNextAction }],
    })

    expect(text).toContain('Performance budgets: fail')
    expect(text).toContain('mission_control_tasks_window')
    expect(text).toContain('Safe next action: Restore the Mission Control task window clamp.')
    expect(text).toContain('Observed {"shown":750,"limit":999}')
  })

  it('exposes budget report through the CLI without reading private state', () => {
    const json = runCli(['performance', 'budgets', '--json', '--fail-blocked'])
    const payload = JSON.parse(json.stdout)

    expect(json.status).toBe(0)
    expect(payload.status).toBe('pass')
    expect(payload.budgets.map((row: any) => row.id)).toContain('incident_bundle_windows')
    expect(json.stdout).not.toContain(testDir)
    expect(json.stderr).not.toContain(testDir)

    const text = runCli(['performance', 'budgets'])

    expect(text.status).toBe(0)
    expect(text.stdout).toContain('Performance budgets: pass')
    expect(text.stdout).toContain('configured_local_performance_budget_evidence_only_no_arbitrary_scale_claim')
    expect(text.stdout).not.toContain(testDir)
    expect(text.stderr).not.toContain(testDir)
  })

  function runCli(args: string[]) {
    return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: projectRoot,
      env: {
        ...process.env,
        OPENCODE_GATEWAY_CONFIG_DIR: testDir,
        OPENCODE_GATEWAY_STATE_DIR: testDir,
      },
      encoding: 'utf8',
    })
  }
})
