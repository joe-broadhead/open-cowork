import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

describe('backend CLI', () => {
  let testDir: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-backend-cli-'))
  })

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  it('reports value-free backend activation status as JSON', () => {
    const result = runCli(['backend', 'status', '--json'])
    const payload = JSON.parse(result.stdout)

    expect(result.status).toBe(0)
    expect(payload.backend.activation).toMatchObject({
      status: 'local_sqlite_default',
      effectivePersistence: 'local_sqlite',
      cutoverReadiness: 'not_selectable',
    })
    expect(payload.consistency).toMatchObject({
      mode: 'm28_backend_consistency_proof',
      runtimeBackend: 'local_sqlite',
      effectivePersistence: 'local_sqlite',
      releaseClaim: 'tested_backend_modes_only_no_hosted_or_multi_tenant_storage_claim',
      backup: expect.objectContaining({ status: 'missing' }),
    })
    expect(payload.backend.activation.supportedCommands).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'consistency_proof', command: 'opencode-gateway backend consistency-proof --json' }),
      expect.objectContaining({ id: 'durable_state_adapter', command: 'opencode-gateway backend durable-state-adapter --json' }),
    ]))
    expect(result.stdout).not.toContain(['postgresql', '://'].join(''))
    expect(result.stdout).not.toContain('Bearer ')
  })


  it('routes consistency-proof through the redacted M28 backend proof contract', () => {
    expect(runCli(['task', 'add', 'Backend proof seed', '--local']).status).toBe(0)

    const result = runCli(['backend', 'consistency-proof', '--json'])
    const payload = JSON.parse(result.stdout)

    expect(result.status).toBe(0)
    expect(payload).toMatchObject({
      mode: 'm28_backend_consistency_proof',
      runtimeBackend: 'local_sqlite',
      effectivePersistence: 'local_sqlite',
      consistencyScan: expect.objectContaining({ scannedDomains: expect.arrayContaining(['work_graph', 'runs_leases', 'receipts']) }),
      backup: expect.objectContaining({ status: 'missing', checksumPresent: false }),
      rollback: expect.objectContaining({ status: 'blocked_missing_verified_backup' }),
      readModel: expect.objectContaining({ deterministicAfterRestart: true }),
    })
    expect(result.stdout).not.toContain(testDir)
    expect(result.stdout).not.toContain('Bearer ')
  })

  it('routes durable-state-integrity through the M44 repair-boundary report contract', () => {
    expect(runCli(['task', 'add', 'Durable integrity seed', '--local']).status).toBe(0)

    const result = runCli(['backend', 'durable-state-integrity', '--json'])
    const payload = JSON.parse(result.stdout)

    expect(result.status).toBe(0)
    expect(payload).toMatchObject({
      mode: 'durable_state_integrity',
      releaseClaim: 'local_first_durable_state_integrity_only_no_managed_or_self_healing_claim',
      inventory: expect.objectContaining({
        totalSources: expect.any(Number),
        totalClasses: expect.any(Number),
      }),
      consistencyScan: expect.objectContaining({ outputRedacted: true }),
      backupRestore: expect.objectContaining({ refusesUnsafeRestore: true }),
      readOnlyDiagnostics: expect.objectContaining({
        mutatesLiveState: false,
        implicitRepairAllowed: false,
      }),
    })
    expect(payload.inventory.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'gateway_db', repairBoundary: 'restore_required' }),
    ]))
    expect(payload.repairBoundaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'inspect.storage_doctor', mutatesLiveState: false }),
      expect.objectContaining({ id: 'restore.verified_backup', mutatesLiveState: true }),
    ]))
    expect(result.stdout).not.toContain(testDir)
    expect(result.stdout).not.toContain('Bearer ')
  })

  it('routes durable-state-adapter through the M49 local durable adapter contract', () => {
    expect(runCli(['task', 'add', 'Durable adapter seed', '--local']).status).toBe(0)

    const result = runCli(['backend', 'durable-state-adapter', '--json'])
    const payload = JSON.parse(result.stdout)

    expect(result.status).toBe(0)
    expect(payload).toMatchObject({
      mode: 'm49_local_durable_state_adapter',
      releaseClaim: 'local_durable_state_adapter_only_no_hosted_or_managed_storage_claim',
      adapter: expect.objectContaining({
        backendMode: 'local_sqlite',
        effectivePersistence: 'local_sqlite',
        capabilities: expect.arrayContaining([
          expect.objectContaining({ id: 'inspect_state', status: 'supported', readOnly: true }),
          expect.objectContaining({ id: 'restore_verified_backup', status: 'supported', mutatesLiveState: true }),
          expect.objectContaining({ id: 'hosted_multi_tenant_backend', status: 'unsupported' }),
        ]),
      }),
      inspect: expect.objectContaining({ mutatesLiveState: false, outputRedacted: true }),
      repair: expect.objectContaining({
        implicitRepairAllowed: false,
        idempotencyKeyRequired: true,
      }),
    })
    expect(result.stdout).not.toContain(testDir)
    expect(result.stdout).not.toContain('Bearer ')
  })

  it('routes durable-state-round-trip through the M49 backup restore proof contract', () => {
    expect(runCli(['task', 'add', 'Durable round trip seed', '--local']).status).toBe(0)

    const result = runCli(['backend', 'durable-state-round-trip', '--json', '--label', 'cli-round-trip'])
    const payload = JSON.parse(result.stdout)

    expect(result.status).toBe(0)
    expect(payload).toMatchObject({
      mode: 'm49_local_durable_state_backup_round_trip',
      status: 'pass',
      backup: expect.objectContaining({
        verification: expect.objectContaining({ ok: true, errors: [] }),
      }),
      recoveryDrill: expect.objectContaining({ status: 'pass', failedChecks: 0 }),
    })
    expect(payload.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'backup_verified', status: 'pass' }),
      expect.objectContaining({ id: 'isolated_recovery_drill', status: 'pass' }),
    ]))
    expect(result.stdout).not.toContain(testDir)
    expect(result.stdout).not.toContain('Bearer ')
  })

  it('routes observability-plane through the local support evidence-plane proof contract', () => {
    const result = runCli(['backend', 'observability-plane', '--fixture', '--json'])
    const payload = JSON.parse(result.stdout)

    expect(result.status).toBe(0)
    expect(payload).toMatchObject({
      mode: 'm49_observability_slo_incident_support_plane',
      status: 'pass',
      releaseClaimEffect: 'local_observability_support_evidence_only',
      acceptance: expect.objectContaining({
        representativeTraceCorrelates: true,
        cliReadinessAndHttpShareSnapshot: true,
        incidentBundleRedactedAndParseable: true,
        failedRunsClassified: true,
        noRawProviderTargetsOrPrivatePaths: true,
      }),
    })
    expect(payload.surfaceAgreement.cliStatus.line).toContain('Trace:')
    expect(payload.failedRunClassifications).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: 'run_m49_failed', failureClass: 'verification_failed' }),
    ]))
    expect(result.stdout).not.toContain(testDir)
    expect(result.stdout).not.toContain('telegram:1234567890')
    expect(result.stdout).not.toContain('Bearer ')
  })



  it('fails unknown backend subcommands with usage', () => {
    const unknown = runCli(['backend', 'not-a-real-subcommand'])

    expect(unknown.status).toBe(1)
    expect(unknown.stdout).toContain('Usage: opencode-gateway backend')
    expect(unknown.stdout).toContain('consistency-proof')
    expect(unknown.stdout).toContain('durable-state-integrity')
    expect(unknown.stdout).toContain('durable-state-adapter')
    expect(unknown.stdout).toContain('observability-plane')
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
