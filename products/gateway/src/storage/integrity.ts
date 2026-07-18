import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  storageStateDir,
  normalizeDoctorNow,
  redactStatePath,
  redactPath,
  uniqueStrings,
  recoveryDrillId,
} from './internal.js'
import { createStorageBackup, verifyStorageBackup } from './backup.js'
import { restoreStorageBackupToStateDir } from './restore.js'
import { runStorageDoctor } from './doctor.js'
import { runStorageRecoveryDrill } from './drills.js'
import type {
  StorageDoctorOptions,
  StorageDoctorReport,
  StorageSourceRecord,
  StorageBackupVerification,
  StorageLifecycleClass,
  BackendConsistencyProof,
  BackendConsistencyProofStatus,
  BackendConsistencyCheck,
  BackendConsistencyBlockedState,
  DurableStateConsistencyProof,
  DurableStateOwnershipRecord,
  DurableStateIntegrityReport,
  DurableStateIntegrityInventorySource,
  DurableStateIntegrityInventoryClass,
  DurableStateIntegrityFixture,
  DurableStateIntegrityRepairBoundary,
  DurableStateRepairBoundaryKind,
  LocalDurableStateAdapterReport,
  LocalDurableStateAdapterCapability,
  LocalDurableStateRepairReceipt,
  LocalDurableStateRepairOperation,
  LocalDurableStateBackupRoundTripEvidence,
} from './types.js'

export function buildBackendConsistencyProof(options: StorageDoctorOptions = {}): BackendConsistencyProof {
  const report = runStorageDoctor(options)
  return report.consistency
}
export function buildDurableStateConsistencyProof(options: StorageDoctorOptions = {}): DurableStateConsistencyProof {
  const report = runStorageDoctor(options)
  const criticalCount = report.issues.filter(issue => issue.severity === 'critical').length
  const warningCount = report.issues.filter(issue => issue.severity === 'warning').length
  const backupStatus = report.consistency.backup.status
  const lifecycleStatus = report.lifecycle.status
  const status: BackendConsistencyProofStatus =
    criticalCount || backupStatus === 'failed' || lifecycleStatus === 'fail'
      ? 'fail'
      : warningCount || backupStatus === 'missing' || lifecycleStatus === 'warn'
        ? 'warn'
        : 'pass'
  const ownerRows = report.sources.map(source => durableStateOwnershipRecord(source))
  const actionableIssues = report.issues.filter(issue => issue.severity !== 'info')
  const orphanIssueCodes = actionableIssues
    .filter(issue => issue.code.includes('_missing') || issue.code.includes('orphan'))
    .map(issue => issue.code)
  const staleBindingIssueCodes = actionableIssues
    .filter(issue => issue.code.includes('binding_') || issue.code.includes('_session_missing') || issue.code.includes('_session_stale'))
    .map(issue => issue.code)
  return {
    mode: 'durable_state_consistency',
    status,
    generatedAt: report.generatedAt,
    stateDir: report.stateDir,
    releaseClaim: 'local_beta_durable_state_consistency_only_no_hosted_or_managed_storage_claim',
    ownership: {
      totalSources: ownerRows.length,
      authoritativeSources: ownerRows.filter(source => source.kind === 'authoritative_sqlite' || source.kind === 'transactional_sqlite').length,
      backedUpSources: ownerRows.filter(source => source.backedUp).length,
      owners: uniqueStrings(ownerRows.map(source => source.owner)).sort(),
      sources: ownerRows,
    },
    scanner: {
      status: report.status,
      criticalCount,
      warningCount,
      issueCodes: report.issues.map(issue => issue.code),
      orphanIssueCodes: uniqueStrings(orphanIssueCodes).sort(),
      staleBindingIssueCodes: uniqueStrings(staleBindingIssueCodes).sort(),
      outputRedacted: true,
    },
    backupRestore: {
      backup: report.consistency.backup,
      rollback: report.consistency.rollback,
      lifecycle: {
        mode: report.lifecycle.mode,
        status: report.lifecycle.status,
        releaseClaim: report.lifecycle.releaseClaim,
      },
    },
    checks: [
      {
        id: 'state_ownership_map',
        domain: 'storage',
        status: ownerRows.every(source => source.owner && source.description && source.recovery) ? 'pass' : 'fail',
        summary: `State ownership map covers ${ownerRows.length} tracked local state source(s).`,
        evidence: {
          totalSources: ownerRows.length,
          owners: uniqueStrings(ownerRows.map(source => source.owner)).sort(),
        },
      },
      {
        id: 'consistency_scanner',
        domain: 'work_store',
        status: criticalCount ? 'fail' : warningCount ? 'warn' : 'pass',
        summary: criticalCount
          ? `${criticalCount} critical durable-state issue(s) found.`
          : warningCount
            ? `${warningCount} durable-state warning(s) found.`
            : 'Durable-state scanner found no actionable issues.',
        evidence: {
          criticalCount,
          warningCount,
          orphanIssueCodes: uniqueStrings(orphanIssueCodes).sort(),
          staleBindingIssueCodes: uniqueStrings(staleBindingIssueCodes).sort(),
        },
      },
      {
        id: 'backup_restore_guard',
        domain: 'backup_restore',
        status: backupStatus === 'failed' ? 'fail' : backupStatus === 'verified' ? 'pass' : 'warn',
        summary: backupStatus === 'verified'
          ? `Verified backup is available and ${report.consistency.backup.freshness}.`
          : backupStatus === 'missing'
            ? 'No verified backup is available for rollback proof.'
            : 'Selected backup failed verification.',
        evidence: {
          backupStatus,
          rollbackStatus: report.consistency.rollback.status,
          checksumPresent: report.consistency.backup.checksumPresent,
        },
      },
      {
        id: 'lifecycle_repair_plan',
        domain: 'lifecycle',
        status: lifecycleStatus === 'fail' ? 'fail' : lifecycleStatus === 'warn' ? 'warn' : 'pass',
        summary: lifecycleStatus === 'pass'
          ? 'Durable lifecycle audit has no repair actions.'
          : `Durable lifecycle audit is ${lifecycleStatus} with ${report.lifecycle.repairPlan.length} repair action(s).`,
        evidence: {
          lifecycleStatus,
          repairActions: report.lifecycle.repairPlan.length,
        },
      },
      {
        id: 'redacted_support_output',
        domain: 'evidence',
        status: 'pass',
        summary: 'Durable-state proof exposes redacted paths, hashed identifiers, issue codes, and support-safe recovery actions only.',
        evidence: { outputRedacted: true },
      },
    ],
    blockedStates: report.consistency.blockedStates,
    safeNextActions: durableStateSafeNextActions(report),
    unsupportedClaims: durableStateUnsupportedClaims(),
  }
}
export function buildDurableStateIntegrityReport(options: StorageDoctorOptions = {}): DurableStateIntegrityReport {
  const report = runStorageDoctor(options)
  const proof = buildDurableStateConsistencyProof(options)
  const actionableIssues = report.issues.filter(issue => issue.severity !== 'info')
  const detectedIssueCodes = uniqueStrings(actionableIssues.map(issue => issue.code)).sort()
  const criticalCount = actionableIssues.filter(issue => issue.severity === 'critical').length
  const warningCount = actionableIssues.filter(issue => issue.severity === 'warning').length
  const sourceInventory = proof.ownership.sources.map(source => durableStateIntegritySource(source))
  const classInventory = report.lifecycle.classes.map(row => durableStateIntegrityClass(row))
  const backupErrors = report.consistency.backup.errors || []
  const status: BackendConsistencyProofStatus =
    proof.status === 'fail' || backupErrors.length ? 'fail' : proof.status === 'warn' ? 'warn' : 'pass'

  return {
    mode: 'durable_state_integrity',
    status,
    generatedAt: report.generatedAt,
    stateDir: report.stateDir,
    releaseClaim: 'local_first_durable_state_integrity_only_no_managed_or_self_healing_claim',
    inventory: {
      sources: sourceInventory,
      classes: classInventory,
      totalSources: sourceInventory.length,
      totalClasses: classInventory.length,
      owners: uniqueStrings([...sourceInventory.map(row => row.owner), ...classInventory.map(row => row.owner)]).sort(),
      requiredSourceCount: sourceInventory.filter(row => row.required).length,
      backedUpSourceCount: sourceInventory.filter(row => row.backedUp).length,
    },
    consistencyScan: {
      status: report.status,
      criticalCount,
      warningCount,
      detectedIssueCodes,
      representativeFixtures: durableStateIntegrityFixtures({ report, detectedIssueCodes }),
      outputRedacted: true,
    },
    backupRestore: {
      backup: report.consistency.backup,
      rollback: report.consistency.rollback,
      verificationErrors: backupErrors,
      refusesUnsafeRestore: report.consistency.backup.status !== 'verified' || backupErrors.length > 0 || report.consistency.rollback.status !== 'drill_available',
    },
    repairBoundaries: durableStateIntegrityRepairBoundaries(),
    readOnlyDiagnostics: {
      commands: [
        'opencode-gateway backend doctor --json',
        'opencode-gateway backend durable-state-proof --json',
        'opencode-gateway backend durable-state-integrity --json',
        'opencode-gateway backend preflight --json',
        'opencode-gateway readiness --json',
      ],
      mutatesLiveState: false,
      implicitRepairAllowed: false,
      evidence: {
        doctorStatus: report.status,
        lifecycleCompactionMutates: report.lifecycle.compaction.mutates,
      },
    },
    evidencePolicy: durableStateIntegrityEvidencePolicy(),
    residualRisks: [
      'Repair remains operator-directed; Gateway does not self-heal corrupt authoritative state.',
      'Sidecar rebuilds must happen through documented owner flows because provider targets and transcripts stay redacted.',
      'Hosted/team durable-state claims remain blocked until backend, tenancy, identity, audit, and recovery gates close.',
      'Scheduler/fleet scale pressure evidence is still required before larger local-concurrency claims are allowed.',
    ],
    unsupportedClaims: [
      'managed backup/restore service',
      'self-healing repair of corrupt authoritative state',
      'hosted/team durable state readiness',
      'multi-tenant storage isolation',
      'unattended migration or cutover',
      'compliance-certified retention or legal hold',
    ],
  }
}
export function buildLocalDurableStateAdapterReport(options: StorageDoctorOptions = {}): LocalDurableStateAdapterReport {
  const stateDir = path.resolve(options.stateDir || storageStateDir())
  const generatedAt = normalizeDoctorNow(options.now)
  const report = runStorageDoctor({ ...options, stateDir, now: generatedAt })
  const criticalCount = report.issues.filter(issue => issue.severity === 'critical').length
  const warningCount = report.issues.filter(issue => issue.severity === 'warning').length
  const issueCodes = uniqueStrings(report.issues.map(issue => issue.code)).sort()
  const checks = localDurableStateAdapterChecks({ report, criticalCount, warningCount })
  const status: BackendConsistencyProofStatus = checks.some(check => check.status === 'fail')
    ? 'fail'
    : checks.some(check => check.status === 'warn')
      ? 'warn'
      : 'pass'

  return {
    mode: 'm49_local_durable_state_adapter',
    status,
    generatedAt: report.generatedAt,
    stateDir: redactStatePath(stateDir, stateDir),
    releaseClaim: 'local_durable_state_adapter_only_no_hosted_or_managed_storage_claim',
    adapter: {
      backendMode: 'local_sqlite',
      effectivePersistence: 'local_sqlite',
      capabilities: localDurableStateAdapterCapabilities(),
      unsupportedModes: [
        'postgres runtime backend',
        'hosted managed database service',
        'hosted/team shared durable state',
        'multi-tenant storage isolation',
        'managed backup/restore service',
      ],
    },
    inspect: {
      mutatesLiveState: false,
      doctorStatus: report.status,
      criticalCount,
      warningCount,
      issueCodes,
      outputRedacted: true,
    },
    backupRestore: {
      latestBackup: report.consistency.backup,
      rollback: report.consistency.rollback,
      roundTripCommand: 'opencode-gateway backend durable-state-round-trip --json',
    },
    repair: {
      implicitRepairAllowed: false,
      idempotencyKeyRequired: true,
      safetyBackupRequiredForRestore: true,
      evidenceDir: redactStatePath(localDurableStateRepairEvidenceDir(stateDir), stateDir),
      supportedOperations: ['create_verified_backup', 'restore_verified_backup', 'record_unsupported_repair_blocker'],
    },
    readiness: {
      storageDoctorStatus: report.status,
      adapterStatus: status,
      blocksDispatch: status === 'fail' || report.status === 'down',
    },
    checks,
    safeNextActions: durableStateSafeNextActions(report),
    unsupportedClaims: localDurableStateAdapterUnsupportedClaims(),
  }
}
export async function runLocalDurableStateRepair(options: {
  operation: LocalDurableStateRepairOperation
  idempotencyKey: string
  stateDir?: string
  backupPath?: string
  maintenanceMode?: boolean
  skipSafetyBackup?: boolean
  allowActiveRuns?: boolean
  label?: string
  reason?: string
  issueCodes?: string[]
  now?: Date | string
}): Promise<LocalDurableStateRepairReceipt> {
  const stateDir = path.resolve(options.stateDir || storageStateDir())
  const generatedAt = normalizeDoctorNow(options.now)
  const idempotencyKey = normalizeRepairIdempotencyKey(options.idempotencyKey)
  const evidenceDir = localDurableStateRepairEvidenceDir(stateDir)
  const receiptPath = path.join(evidenceDir, `${idempotencyKey}.json`)
  const existing = readRepairReceipt(receiptPath)
  if (existing) return existing

  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
  const common = {
    mode: 'm49_local_durable_state_repair_receipt' as const,
    idempotencyKey,
    operation: options.operation,
    generatedAt,
    stateDir: redactStatePath(stateDir, stateDir),
    evidencePath: redactStatePath(receiptPath, stateDir),
    explicitOperatorCall: true as const,
    issueCodes: uniqueStrings(options.issueCodes || []).sort(),
    unsupportedClaims: localDurableStateAdapterUnsupportedClaims(),
  }

  let receipt: LocalDurableStateRepairReceipt
  if (options.operation === 'record_unsupported_repair_blocker') {
    const blocker = {
      code: 'repair_not_implemented_for_issue',
      severity: 'warning' as const,
      summary: options.reason || 'Requested durable-state issue requires owner-specific repair or verified restore.',
      remediation: 'Keep inspect output read-only, record this blocker, then use the named owner flow or restore from a verified backup during maintenance.',
    }
    receipt = {
      ...common,
      status: 'blocked',
      mutatesLiveState: false,
      actions: ['recorded repair blocker receipt without mutating live state'],
      blockers: [blocker],
      checks: [
        localDurableStateCheck('explicit_operator_call', 'repair', 'pass', 'Repair path was invoked through an explicit operator call.'),
        localDurableStateCheck('unsupported_repair_blocked', 'repair', 'warn', 'Unsupported repair request was blocked instead of self-healing state.', { issueCodes: common.issueCodes }),
      ],
    }
  } else if (options.operation === 'create_verified_backup') {
    try {
      const backup = createStorageBackup({
        label: options.label || 'm49-adapter-repair',
        allowActiveRuns: options.allowActiveRuns === true,
        stateDir,
        now: new Date(generatedAt),
      })
      const verification = verifyStorageBackup(backup.path)
      receipt = {
        ...common,
        status: verification.ok ? 'pass' : 'fail',
        mutatesLiveState: false,
        backup: { id: backup.id, path: redactPath(backup.path, stateDir, '<backup>'), verified: verification.ok, errors: verification.errors },
        actions: ['created local Gateway backup artifact', 'verified backup manifest, checksums, and SQLite integrity'],
        blockers: verification.ok ? [] : [{
          code: 'backup_verification_failed',
          severity: 'critical',
          summary: 'Created backup did not verify cleanly.',
          remediation: 'Do not use this backup for restore; fix verification errors and create a fresh backup.',
        }],
        checks: [
          localDurableStateCheck('explicit_operator_call', 'repair', 'pass', 'Repair path was invoked through an explicit operator call.'),
          localDurableStateCheck('backup_verified', 'backup_restore', verification.ok ? 'pass' : 'fail', verification.ok ? 'Backup verified cleanly.' : 'Backup verification failed.', { errors: verification.errors }),
        ],
      }
    } catch (err: any) {
      receipt = failedRepairReceipt(common, 'create_verified_backup_failed', err?.message || String(err), false)
    }
  } else if (options.operation === 'restore_verified_backup') {
    const backupPath = options.backupPath
    const blockers: BackendConsistencyBlockedState[] = []
    if (!backupPath) blockers.push({
      code: 'backup_path_required',
      severity: 'critical',
      summary: 'Restore repair requires an explicit backup path.',
      remediation: 'Select a verified backup and rerun repair with backupPath.',
    })
    if (options.maintenanceMode !== true) blockers.push({
      code: 'maintenance_mode_required',
      severity: 'critical',
      summary: 'Restore repair requires explicit maintenance mode.',
      remediation: 'Stop writers, notify the operator, and rerun repair with maintenanceMode=true.',
    })
    const verification = backupPath ? verifyStorageBackup(backupPath) : undefined
    if (verification && !verification.ok) blockers.push({
      code: 'backup_verification_failed',
      severity: 'critical',
      summary: 'Selected backup does not verify cleanly.',
      remediation: 'Create and verify a fresh backup before restore.',
    })
    if (blockers.length) {
      receipt = {
        ...common,
        status: 'blocked',
        mutatesLiveState: true,
        ...(verification ? { backup: { id: verification.metadata?.id, path: redactPath(verification.path, stateDir, '<backup>'), verified: verification.ok, errors: verification.errors } } : {}),
        actions: ['blocked restore before live-state mutation'],
        blockers,
        checks: [
          localDurableStateCheck('explicit_operator_call', 'repair', 'pass', 'Repair path was invoked through an explicit operator call.'),
          localDurableStateCheck('restore_preconditions', 'backup_restore', 'fail', 'Restore repair preconditions did not pass.', { blockerCodes: blockers.map(row => row.code) }),
        ],
      }
    } else {
      try {
        const restored = await restoreStorageBackupToStateDir(backupPath!, stateDir, { maintenanceMode: true, skipSafetyBackup: options.skipSafetyBackup === true })
        receipt = {
          ...common,
          status: 'pass',
          mutatesLiveState: true,
          backup: { id: verification!.metadata?.id, path: redactPath(verification!.path, stateDir, '<backup>'), verified: true, errors: [] },
          restore: {
            restoredFiles: restored.restored.length,
            ...(restored.safetyBackup ? { safetyBackup: redactPath(restored.safetyBackup, stateDir, '<backup>') } : {}),
          },
          actions: ['verified backup before restore', 'restored backup into Gateway state directory', 'removed absent SQLite sidecars and unsupported sidecars'],
          blockers: [],
          checks: [
            localDurableStateCheck('explicit_operator_call', 'repair', 'pass', 'Repair path was invoked through an explicit operator call.'),
            localDurableStateCheck('restore_preconditions', 'backup_restore', 'pass', 'Restore repair preconditions passed.'),
            localDurableStateCheck('restore_receipt', 'backup_restore', 'pass', 'Restore wrote a durable repair receipt.', { restoredFiles: restored.restored.length }),
          ],
        }
      } catch (err: any) {
        receipt = failedRepairReceipt(common, 'restore_verified_backup_failed', err?.message || String(err), true)
      }
    }
  } else {
    receipt = {
      ...common,
      status: 'blocked',
      mutatesLiveState: false,
      actions: ['blocked unknown repair operation before live-state mutation'],
      blockers: [{
        code: 'unknown_repair_operation',
        severity: 'critical',
        summary: `Unknown durable-state repair operation: ${String(options.operation)}`,
        remediation: 'Use record_unsupported_repair_blocker, create_verified_backup, or restore_verified_backup with explicit maintenance preconditions.',
      }],
      checks: [
        localDurableStateCheck('explicit_operator_call', 'repair', 'pass', 'Repair path was invoked through an explicit operator call.'),
        localDurableStateCheck('known_repair_operation', 'repair', 'fail', 'Unknown repair operation was blocked before mutation.', { operation: String(options.operation) }),
      ],
    }
  }

  writeRepairReceipt(receiptPath, receipt)
  return receipt
}
export async function validateLocalDurableStateBackupRoundTrip(options: {
  stateDir?: string
  backupPath?: string
  label?: string
  outputDir?: string
  now?: Date | string
} = {}): Promise<LocalDurableStateBackupRoundTripEvidence> {
  const stateDir = path.resolve(options.stateDir || storageStateDir())
  const generatedAt = normalizeDoctorNow(options.now)
  const backup = options.backupPath
    ? undefined
    : createStorageBackup({ label: options.label || 'm49-adapter-round-trip', stateDir, now: new Date(generatedAt) })
  const backupPath = options.backupPath || backup!.path
  const verification = verifyStorageBackup(backupPath)
  const checks: BackendConsistencyCheck[] = [
    localDurableStateCheck('backup_verified', 'backup_restore', verification.ok ? 'pass' : 'fail', verification.ok ? 'Backup verified before round-trip restore.' : 'Backup verification failed before round-trip restore.', { errors: verification.errors }),
  ]
  let recoveryDrill: LocalDurableStateBackupRoundTripEvidence['recoveryDrill']
  if (verification.ok) {
    const drillLabel = options.label || 'm49-adapter-round-trip'
    const drillOutputDir = options.outputDir || path.join(stateDir, 'recovery-drills', recoveryDrillId(new Date(generatedAt), drillLabel))
    const drill = await runStorageRecoveryDrill({
      backupPath: verification.path,
      label: drillLabel,
      outputDir: drillOutputDir,
      now: new Date(generatedAt),
      stateDir,
    })
    const failedChecks = drill.checks.filter(row => row.status !== 'pass').length
    recoveryDrill = {
      id: drill.id,
      status: drill.status,
      evidencePath: redactStatePath(drill.evidencePath, stateDir),
      failedChecks,
    }
    checks.push(localDurableStateCheck('isolated_recovery_drill', 'backup_restore', drill.status === 'pass' ? 'pass' : 'fail', drill.status === 'pass' ? 'Isolated recovery drill passed.' : 'Isolated recovery drill failed.', { failedChecks }))
  }
  const status: BackendConsistencyProofStatus = checks.some(check => check.status === 'fail') ? 'fail' : checks.some(check => check.status === 'warn') ? 'warn' : 'pass'
  const redactedVerification: StorageBackupVerification = { ...verification, path: redactPath(verification.path, stateDir, '<backup>') }
  return {
    mode: 'm49_local_durable_state_backup_round_trip',
    status,
    generatedAt,
    stateDir: redactStatePath(stateDir, stateDir),
    backup: {
      id: verification.metadata?.id || backup?.id || path.basename(verification.path),
      path: redactPath(verification.path, stateDir, '<backup>'),
      verification: redactedVerification,
    },
    ...(recoveryDrill ? { recoveryDrill } : {}),
    checks,
    unsupportedClaims: localDurableStateAdapterUnsupportedClaims(),
  }
}
function durableStateOwnershipRecord(source: StorageSourceRecord): DurableStateOwnershipRecord {
  return {
    id: source.id,
    label: source.label,
    kind: source.kind,
    owner: source.owner,
    required: source.required,
    backedUp: source.backedUp,
    path: source.path,
    description: source.description,
    recovery: source.remediation,
  }
}
function durableStateIntegritySource(source: DurableStateOwnershipRecord): DurableStateIntegrityInventorySource {
  return {
    id: source.id,
    owner: source.owner,
    kind: source.kind,
    sourceOfTruth: source.kind === 'authoritative_sqlite'
      ? 'gateway.db authoritative SQLite tables'
      : source.kind === 'transactional_sqlite'
        ? 'transactional SQLite sidecar'
        : source.kind === 'derived_cache'
          ? 'derived sidecar cache'
          : source.kind === 'append_only_evidence'
            ? 'append-only evidence sidecar'
            : 'operator-created storage artifact',
    retentionClass: durableStateSourceRetentionClass(source),
    required: source.required,
    backedUp: source.backedUp,
    repairBoundary: durableStateSourceRepairBoundary(source),
    recovery: source.recovery,
  }
}
function durableStateIntegrityClass(row: StorageLifecycleClass): DurableStateIntegrityInventoryClass {
  return {
    id: row.id,
    retentionClass: row.retentionClass,
    owner: durableStateClassOwner(row.retentionClass),
    rows: row.rows,
    status: row.status,
    compactionBehavior: row.compactionBehavior,
    repairBehavior: row.repairBehavior,
  }
}
function durableStateIntegrityFixtures(input: { report: StorageDoctorReport; detectedIssueCodes: string[] }): DurableStateIntegrityFixture[] {
  const detected = new Set(input.detectedIssueCodes)
  const detectedCodes = (codes: string[]) => codes.filter(code => detected.has(code))
  const backupStatus = input.report.consistency.backup.status
  const backupErrors = input.report.consistency.backup.errors || []
  const orphanedRunCodes = detectedCodes(['run_task_missing', 'task_current_run_missing', 'dispatch_receipt_task_missing'])
  const staleBindingCodes = detectedCodes(['channel_binding_session_missing', 'project_binding_session_missing'])
  const receiptDriftCodes = detectedCodes(['progress_receipt_event_missing', 'progress_route_receipt_event_missing'])
  return [
    {
      id: 'orphaned-runs-and-projections',
      domain: 'consistency_scan',
      status: orphanedRunCodes.length ? 'fail' : 'pass',
      expectedIssueCodes: ['run_task_missing', 'task_current_run_missing', 'dispatch_receipt_task_missing'],
      detectedIssueCodes: orphanedRunCodes,
      mutatesLiveState: false,
      evidence: {
        coveredBy: 'src/__tests__/storage.test.ts detects backend consistency drift across runs, leases, receipts, events, and projections',
      },
    },
    {
      id: 'stale-channel-and-project-bindings',
      domain: 'consistency_scan',
      status: staleBindingCodes.length ? 'warn' : 'pass',
      expectedIssueCodes: ['channel_binding_session_missing', 'project_binding_session_missing'],
      detectedIssueCodes: staleBindingCodes,
      mutatesLiveState: false,
      evidence: {
        coveredBy: 'src/__tests__/storage.test.ts detects stale channel and project session bindings when the session sidecar is present',
      },
    },
    {
      id: 'receipt-reference-and-event-drift',
      domain: 'repair_boundary',
      status: receiptDriftCodes.length ? 'warn' : 'pass',
      expectedIssueCodes: ['progress_receipt_event_missing', 'progress_route_receipt_event_missing'],
      detectedIssueCodes: receiptDriftCodes,
      mutatesLiveState: false,
      evidence: {
        repairBoundary: 'operator',
        coveredBy: 'src/__tests__/storage.test.ts classifies durable receipt event-reference drift as operator-repairable',
      },
    },
    {
      id: 'backup-restore-refusal',
      domain: 'backup_restore',
      status: backupStatus === 'failed' ? 'fail' : backupStatus === 'missing' ? 'warn' : 'pass',
      expectedIssueCodes: ['backup_verification_failed', 'backup_missing_source'],
      detectedIssueCodes: detectedCodes(['backup_verification_failed', 'backup_missing_source']),
      mutatesLiveState: false,
      evidence: {
        backupStatus,
        errorCount: backupErrors.length,
        rollbackStatus: input.report.consistency.rollback.status,
        coveredBy: 'backup verification and restore/recovery drill refusal tests',
      },
    },
    {
      id: 'read-only-diagnostics-do-not-repair',
      domain: 'read_only_diagnostic',
      status: input.report.lifecycle.compaction.mutates === false ? 'pass' : 'fail',
      expectedIssueCodes: [],
      detectedIssueCodes: [],
      mutatesLiveState: false,
      evidence: {
        doctorStatus: input.report.status,
        lifecycleCompactionMutates: input.report.lifecycle.compaction.mutates,
        coveredBy: 'lifecycle compaction dry-run and backend migration dry-run regression tests',
      },
    },
  ]
}
function durableStateIntegrityRepairBoundaries(): DurableStateIntegrityRepairBoundary[] {
  return [
    {
      id: 'inspect.storage_doctor',
      kind: 'inspect_only',
      owner: 'storage',
      command: 'opencode-gateway backend doctor --json',
      mutatesLiveState: false,
      auditEvidence: 'storage doctor report with redacted issue codes and safe next actions',
      allowedWhen: 'Any local operator needs a read-only consistency view.',
      forbiddenIn: ['implicit repair', 'background self-healing', 'unattended production operation'],
    },
    {
      id: 'inspect.durable_state_proof',
      kind: 'inspect_only',
      owner: 'storage',
      command: 'opencode-gateway backend durable-state-proof --json',
      mutatesLiveState: false,
      auditEvidence: 'durable-state consistency proof plus integrity summary',
      allowedWhen: 'Release evidence, support handoff, or pre-repair diagnosis needs a redacted proof.',
      forbiddenIn: ['automatic restore', 'sidecar rebuild', 'schema migration mutation'],
    },
    {
      id: 'repair.operator_reference_refresh',
      kind: 'operator_repair',
      owner: 'work-store/channel owners',
      command: 'owner-specific rebind, receipt backfill, or projection refresh flow',
      mutatesLiveState: true,
      auditEvidence: 'audit.security or workflow event describing the explicit operator action',
      allowedWhen: 'A warning-class projection, receipt, or binding drift is understood and bounded.',
      forbiddenIn: ['readiness', 'status', 'doctor', 'proof-only commands'],
    },
    {
      id: 'recover.isolated_drill',
      kind: 'isolated_recovery_drill',
      owner: 'storage',
      command: 'opencode-gateway backup drill --from <backup-path> --json',
      mutatesLiveState: false,
      auditEvidence: 'recovery-drill evidence directory and JSON receipt',
      allowedWhen: 'A verified backup needs restore/recovery proof without mutating live state.',
      forbiddenIn: ['live restore', 'production cutover claim', 'provider-target inference'],
    },
    {
      id: 'restore.verified_backup',
      kind: 'restore_required',
      owner: 'storage',
      command: 'opencode-gateway backup restore <backup-path> --maintenance',
      mutatesLiveState: true,
      auditEvidence: 'verified backup metadata, safety backup, maintenance-mode approval, and restore receipt',
      allowedWhen: 'Authoritative state is missing/corrupt and a verified compatible backup exists.',
      forbiddenIn: ['active daemon without maintenance mode', 'failed backup verification', 'read-only diagnostics'],
    },
  ]
}
function durableStateIntegrityEvidencePolicy(): DurableStateIntegrityReport['evidencePolicy'] {
  return {
    redacted: true,
    allowed: [
      'source IDs and owner names',
      'retention classes and repairability classes',
      'issue codes, counts, and hashed samples',
      'backup verification status and checksum presence',
      'schema versions, manifest compatibility, and blocked-state codes',
      'safe next actions and unsupported claim names',
    ],
    forbidden: [
      'raw state directory paths',
      'raw chat IDs, phone numbers, provider payloads, or session IDs',
      'private transcript text',
      'secret values or connection strings',
      'unredacted backup paths in shareable evidence',
      'automatic repair claims for corrupt authoritative state',
    ],
  }
}
function durableStateSourceRetentionClass(source: DurableStateOwnershipRecord): DurableStateIntegrityInventorySource['retentionClass'] {
  if (source.id === 'gateway_db') return 'authoritative_state'
  if (source.id === 'channel_sync_outbox') return 'durable_receipt'
  if (source.id === 'events_sidecar') return 'bounded_event'
  if (source.id === 'backups' || source.id === 'recovery_drills') return 'backup_artifact'
  if (source.kind === 'derived_cache' || source.kind === 'append_only_evidence') return 'derived_sidecar'
  return 'source_artifact'
}
function durableStateSourceRepairBoundary(source: DurableStateOwnershipRecord): DurableStateRepairBoundaryKind {
  if (source.kind === 'authoritative_sqlite') return 'restore_required'
  if (source.id === 'backups' || source.id === 'recovery_drills') return 'isolated_recovery_drill'
  if (source.kind === 'transactional_sqlite') return 'restore_required'
  if (source.kind === 'derived_cache' || source.kind === 'append_only_evidence') return 'operator_repair'
  return 'inspect_only'
}
function durableStateClassOwner(retentionClass: StorageLifecycleClass['retentionClass']): string {
  if (retentionClass === 'authoritative_state') return 'work-store'
  if (retentionClass === 'durable_receipt') return 'work-store receipts'
  if (retentionClass === 'bounded_event') return 'work-store event retention'
  if (retentionClass === 'audit_ledger') return 'audit-ledger'
  if (retentionClass === 'derived_sidecar') return 'channel/evidence sidecar owners'
  return 'storage'
}
function durableStateSafeNextActions(report: StorageDoctorReport): string[] {
  const actions = uniqueStrings([
    ...report.issues
      .filter(issue => issue.severity !== 'info')
      .map(issue => issue.remediation),
    ...report.lifecycle.repairPlan.map(row => row.action),
    report.consistency.backup.status === 'verified'
      ? 'Use `opencode-gateway backup drill --from <backup-path>` or `opencode-gateway backend rollback-dry-run --from <backup-path>` for isolated recovery evidence.'
      : 'Create and verify a fresh local backup before restore, rollback, or release evidence collection.',
    'Keep durable-state proof bounded to the current local SQLite public-beta backend unless a later decision record expands the claim.',
  ])
  return actions.slice(0, 12)
}
function durableStateUnsupportedClaims(): string[] {
  return [
    'hosted durable state readiness',
    'managed backup/restore service',
    'multi-tenant storage isolation',
    'self-healing repair of corrupt authoritative state',
    'arbitrary-scale database performance',
    'unattended production migration/cutover',
    'compliance-certified retention or legal hold',
  ]
}
function localDurableStateAdapterCapabilities(): LocalDurableStateAdapterCapability[] {
  return [
    {
      id: 'inspect_state',
      status: 'supported',
      readOnly: true,
      mutatesLiveState: false,
      requiresExplicitOperatorCall: false,
      command: 'opencode-gateway backend durable-state-adapter --json',
      evidence: 'redacted adapter capability, issue-code, and backup posture report',
      safeByDefault: true,
    },
    {
      id: 'verify_backup',
      status: 'supported',
      readOnly: true,
      mutatesLiveState: false,
      requiresExplicitOperatorCall: false,
      command: 'opencode-gateway backup verify <backup-path>',
      evidence: 'backup metadata, checksum manifest, and SQLite integrity result',
      safeByDefault: true,
    },
    {
      id: 'create_verified_backup',
      status: 'supported',
      readOnly: false,
      mutatesLiveState: false,
      requiresExplicitOperatorCall: true,
      command: 'opencode-gateway backup create --label <label>',
      evidence: 'backup artifact plus repair receipt when invoked through the adapter repair path',
      safeByDefault: true,
    },
    {
      id: 'restore_verified_backup',
      status: 'supported',
      readOnly: false,
      mutatesLiveState: true,
      requiresExplicitOperatorCall: true,
      command: 'opencode-gateway backup restore <backup-path> --maintenance',
      evidence: 'verified backup metadata, safety backup, restored files count, and repair receipt',
      safeByDefault: false,
    },
    {
      id: 'isolated_recovery_drill',
      status: 'supported',
      readOnly: false,
      mutatesLiveState: false,
      requiresExplicitOperatorCall: true,
      command: 'opencode-gateway backend durable-state-round-trip --json',
      evidence: 'isolated restore path, recovery drill checks, and backup round-trip evidence',
      safeByDefault: true,
    },
    {
      id: 'operator_repair_receipt',
      status: 'supported',
      readOnly: false,
      mutatesLiveState: false,
      requiresExplicitOperatorCall: true,
      command: 'opencode-gateway backend durable-state-repair --operation <operation> --idempotency-key <key> --json',
      evidence: 'idempotent repair receipt that records pass, fail, or blocked without hidden self-healing',
      safeByDefault: true,
    },
    {
      id: 'hosted_multi_tenant_backend',
      status: 'unsupported',
      readOnly: true,
      mutatesLiveState: false,
      requiresExplicitOperatorCall: true,
      command: 'not available',
      evidence: 'blocked claim only',
      safeByDefault: false,
      blocker: 'Hosted/team and multi-tenant durable state are not implemented or release-supported.',
    },
  ]
}
function localDurableStateAdapterChecks(input: {
  report: StorageDoctorReport
  criticalCount: number
  warningCount: number
}): BackendConsistencyCheck[] {
  const inspectStatus: BackendConsistencyProofStatus = input.criticalCount ? 'fail' : input.warningCount ? 'warn' : 'pass'
  return [
    localDurableStateCheck('adapter_capability_matrix', 'storage', 'pass', 'Adapter capability matrix is explicit and fails closed for unsupported backend modes.', {
      capabilities: localDurableStateAdapterCapabilities().map(row => ({ id: row.id, status: row.status, mutatesLiveState: row.mutatesLiveState })),
    }),
    localDurableStateCheck('inspect_is_read_only', 'storage', inspectStatus, 'Inspect/report paths expose storage truth without mutating live state.', {
      doctorStatus: input.report.status,
      criticalCount: input.criticalCount,
      warningCount: input.warningCount,
    }),
    localDurableStateCheck('repair_requires_explicit_call', 'repair', 'pass', 'Repair operations are only available through explicit idempotent repair calls; readiness/status do not self-heal.'),
    localDurableStateCheck('backup_restore_round_trip_available', 'backup_restore', input.report.consistency.backup.status === 'failed' ? 'fail' : input.report.consistency.backup.status === 'verified' ? 'pass' : 'warn', 'Backup verification and isolated recovery drill surfaces are available for round-trip proof.', {
      backupStatus: input.report.consistency.backup.status,
      rollbackStatus: input.report.consistency.rollback.status,
    }),
  ]
}
function localDurableStateCheck(id: string, domain: string, status: BackendConsistencyProofStatus, summary: string, evidence?: Record<string, unknown>): BackendConsistencyCheck {
  return { id, domain, status, summary, ...(evidence ? { evidence } : {}) }
}
function localDurableStateRepairEvidenceDir(stateDir: string): string {
  return path.join(path.resolve(stateDir), 'repair-evidence')
}
function normalizeRepairIdempotencyKey(value: string): string {
  if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(value || '')) throw new Error('repair idempotencyKey must be 1-120 chars of letters, numbers, dash, underscore, dot, or colon')
  return value
}
function readRepairReceipt(filePath: string): LocalDurableStateRepairReceipt | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    return parsed?.mode === 'm49_local_durable_state_repair_receipt' ? parsed : undefined
  } catch {
    return undefined
  }
}
function writeRepairReceipt(filePath: string, receipt: LocalDurableStateRepairReceipt): void {
  fs.writeFileSync(filePath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
}
function failedRepairReceipt(
  common: Omit<LocalDurableStateRepairReceipt, 'status' | 'mutatesLiveState' | 'actions' | 'blockers' | 'checks'>,
  code: string,
  summary: string,
  mutatesLiveState: boolean,
): LocalDurableStateRepairReceipt {
  return {
    ...common,
    status: 'fail',
    mutatesLiveState,
    actions: ['recorded failed repair attempt without claiming recovery'],
    blockers: [{
      code,
      severity: 'critical',
      summary,
      remediation: 'Fix the blocker, rerun inspect, then rerun the explicit repair path with a new idempotency key if needed.',
    }],
    checks: [
      localDurableStateCheck('explicit_operator_call', 'repair', 'pass', 'Repair path was invoked through an explicit operator call.'),
      localDurableStateCheck(code, 'repair', 'fail', summary),
    ],
  }
}
function localDurableStateAdapterUnsupportedClaims(): string[] {
  return [
    'hosted durable-state readiness',
    'managed backup/restore service',
    'multi-tenant storage isolation',
    'self-healing repair of corrupt authoritative state',
    'zero-risk migration or restore',
    'shared production database backend',
    'unattended production cutover',
  ]
}
