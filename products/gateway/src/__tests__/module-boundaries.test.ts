import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = path.join(ROOT, 'scripts/check-module-boundaries.mjs')
const BUDGET = path.join(ROOT, 'docs/development/module-boundary-budget.json')
const BUDGET_DOC = path.join(ROOT, 'docs/development/module-boundary-budget.md')

describe('module boundary budget', () => {
  it('passes the committed source graph without private absolute paths', () => {
    const output = execFileSync(process.execPath, [SCRIPT, '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    const report = JSON.parse(output)

    expect(report).toMatchObject({
      schemaVersion: 1,
      status: 'pass',
      sourceRoot: 'src',
      moduleCount: expect.any(Number),
      edgeCount: expect.any(Number),
      cycleBudget: {
        status: 'acyclic',
        stronglyConnectedComponentCount: expect.any(Number),
        maxComponentSize: expect.any(Number),
        knownCycleCount: expect.any(Number),
      },
      forbiddenImportViolations: [],
      unresolvedRelativeImports: [],
      failures: [],
    })
    expect(report.moduleCount).toBeGreaterThan(100)
    expect(report.edgeCount).toBeGreaterThan(report.moduleCount)
    expect(report.ownerSummary.some((row: any) => row.category === 'release_validation')).toBe(true)
    expect(report.growthPolicy.ownerCategories).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'docs_surface', risk: 'docs' }),
      expect.objectContaining({ id: 'validation_infrastructure', risk: 'validation' }),
    ]))
    expect(report.growthPolicy).toMatchObject({
      status: 'pass',
      budgetIncreaseSummary: {
        evidenceOnly: {
          moduleDelta: 3,
          edgeDelta: 12,
        },
        runtimeRisk: {
          moduleDelta: 0,
          edgeDelta: 0,
        },
      },
    })
    expect(report.growthPolicy.directionalImportPilots).toContainEqual(expect.objectContaining({
      ruleId: 'validation_gate_selector_stays_release_ops_only',
      ownerCategory: 'release_validation',
    }))
    expect(output).not.toContain(ROOT)
  })

  it('documents worker-facing growth-policy examples', () => {
    const text = fs.readFileSync(BUDGET_DOC, 'utf8')

    expect(text).toContain('## Owner And Growth Policy')
    expect(text).toContain('growthPolicy.ownerCategories')
    expect(text).toContain('growthPolicy.budgetIncreases')
    expect(text).toContain('Acceptable boundary changes:')
    expect(text).toContain('Unacceptable boundary changes:')
    expect(text).toContain('adding a budget entry without a non-empty rationale or owner classification')
  })

  it('fails closed when a budget increase lacks rationale or owner classification', () => {
    const budget = JSON.parse(fs.readFileSync(BUDGET, 'utf8'))
    budget.growthPolicy.budgetIncreases[0] = {
      ...budget.growthPolicy.budgetIncreases[0],
      rationale: '',
      ownerCategory: 'missing_owner_category',
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-boundary-policy-'))
    const budgetPath = path.join(dir, 'budget.json')
    fs.writeFileSync(budgetPath, JSON.stringify(budget, null, 2))
    try {
      const result = spawnSync(process.execPath, [SCRIPT, '--json', '--budget', budgetPath], {
        cwd: ROOT,
        encoding: 'utf8',
      })
      expect(result.status).not.toBe(0)
      const report = JSON.parse(result.stdout)
      expect(report.status).toBe('fail')
      expect(report.failures).toEqual(expect.arrayContaining([
        'growthPolicy.budgetIncreases[0].ownerCategory must reference growthPolicy.ownerCategories',
        'growthPolicy.budgetIncreases[0].rationale is required',
      ]))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps growth-policy status scoped to growth-policy failures', () => {
    const budget = JSON.parse(fs.readFileSync(BUDGET, 'utf8'))
    budget.domains[0] = {
      ...budget.domains[0],
      primaryTests: ['src/__tests__/missing-domain-fixture.test.ts'],
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-boundary-policy-status-'))
    const budgetPath = path.join(dir, 'budget.json')
    fs.writeFileSync(budgetPath, JSON.stringify(budget, null, 2))
    try {
      const result = spawnSync(process.execPath, [SCRIPT, '--json', '--budget', budgetPath], {
        cwd: ROOT,
        encoding: 'utf8',
      })
      expect(result.status).not.toBe(0)
      const report = JSON.parse(result.stdout)
      expect(report.status).toBe('fail')
      expect(report.growthPolicy.status).toBe('pass')
      expect(report.failures).toContain(
        'domains[0].primaryTests path does not exist: src/__tests__/missing-domain-fixture.test.ts',
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails closed when a selected boundary is violated', () => {
    const budget = JSON.parse(fs.readFileSync(BUDGET, 'utf8'))
    budget.forbiddenImports = [
      {
        id: 'regression_fixture_blocks_current_edge',
        owner: 'test',
        reason: 'Representative regression fixture for unauthorized cross-boundary imports.',
        reviewCondition: 'Use an owner module or explicit exception before allowing this edge.',
        from: ['src/channel-commands.ts'],
        blocked: ['src/scheduler.ts'],
        exceptions: [],
      },
    ]

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-boundary-'))
    const budgetPath = path.join(dir, 'budget.json')
    fs.writeFileSync(budgetPath, JSON.stringify(budget, null, 2))
    try {
      const result = spawnSync(process.execPath, [SCRIPT, '--json', '--budget', budgetPath], {
        cwd: ROOT,
        encoding: 'utf8',
      })
      expect(result.status).not.toBe(0)
      const report = JSON.parse(result.stdout)
      expect(report.status).toBe('fail')
      expect(report.forbiddenImportViolations.length).toBeGreaterThan(0)
      expect(report.forbiddenImportViolations).toContainEqual(expect.objectContaining({
        ruleId: 'regression_fixture_blocks_current_edge',
        from: 'src/channel-commands.ts',
        to: 'src/scheduler.ts',
      }))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails closed when evidence policy allows an unsafe runtime import direction', () => {
    const budget = JSON.parse(fs.readFileSync(BUDGET, 'utf8'))
    budget.forbiddenImports = [
      {
        id: 'regression_fixture_blocks_review_gate_redaction_edge',
        owner: 'release_ops',
        reason: 'Representative regression fixture for unsafe release evidence import direction.',
        reviewCondition: 'Route runtime proof through redacted receipts or an owner-approved helper before allowing this edge.',
        from: ['src/incident-bundle.ts'],
        blocked: ['src/work-store.ts'],
        exceptions: [],
      },
    ]
    budget.growthPolicy.directionalImportPilots[0] = {
      ...budget.growthPolicy.directionalImportPilots[0],
      id: 'regression_fixture_blocks_review_gate_redaction_edge',
      ruleId: 'regression_fixture_blocks_review_gate_redaction_edge',
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-boundary-direction-'))
    const budgetPath = path.join(dir, 'budget.json')
    fs.writeFileSync(budgetPath, JSON.stringify(budget, null, 2))
    try {
      const result = spawnSync(process.execPath, [SCRIPT, '--json', '--budget', budgetPath], {
        cwd: ROOT,
        encoding: 'utf8',
      })
      expect(result.status).not.toBe(0)
      const report = JSON.parse(result.stdout)
      expect(report.forbiddenImportViolations).toContainEqual(expect.objectContaining({
        ruleId: 'regression_fixture_blocks_review_gate_redaction_edge',
        from: 'src/incident-bundle.ts',
        to: 'src/work-store.ts',
      }))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
