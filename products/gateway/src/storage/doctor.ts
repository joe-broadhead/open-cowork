import * as fs from 'node:fs'
import * as path from 'node:path'
import { auditLedgerEntryHash, type AuditLedgerRecord } from '../audit-ledger.js'
import type { GatewayConfig } from '../config.js'
import { DatabaseSync } from 'node:sqlite'
import {
  loadWorkStateReadOnly,
  listChannelBindingsReadOnly,
  listWorkEventsReadOnly,
  listWorkStoreRepositoryDomains,
  queryRows,
  parseJSON,
  DURABLE_WORK_EVENT_TYPES,
  MAX_WORK_EVENT_ROWS,
  WORK_EVENT_RETENTION_MS,
} from '../work-store.js'
import {
  storageStateDir,
  workStatePathForStateDir,
  listStorageSources,
  storageSourceSpecs,
  redactStatePath,
  redactPath,
  normalizeDoctorNow,
  normalizeBackupPath,
  latestBackupPath,
  readModelChecksum,
  countsMatchBackup,
  checkDatabaseIntegrity,
  openSqliteReadOnly,
  sqliteTableExists,
  channelSyncOutboxPath,
  readJsonArtifact,
  channelSyncDeliveryKeys,
  inspectChannelSyncOutbox,
  summarizeRecoveryDrillEvidence,
  backendMigrationEvidencePolicy,
  lifecycleCount,
  lifecycleCountSql,
  fingerprintId,
  fingerprintIds,
  parseJsonArray,
  readSessionSidecarIds,
  uniqueStrings,
  asStringArray,
  withReadOnlyStorageDb,
} from './internal.js'
import { describeStorageBackend, verifyStorageBackup, listStorageBackups } from './backup.js'
import type {
  StorageDoctorReport,
  StorageDoctorOptions,
  StorageDoctorIssue,
  StorageDoctorSeverity,
  StorageDoctorStatus,
  StorageBackupMetadata,
  StorageBackendPosture,
  StorageLifecycleReport,
  StorageLifecycleCheck,
  StorageLifecycleClass,
  StorageLifecycleStatus,
  StorageLifecycleCompactionDryRun,
  StorageRecoveryDrillSummary,
  BackendConsistencyProof,
  BackendConsistencyProofStatus,
  BackendConsistencyRuntimePosture,
  BackendConsistencyBlockedState,
} from './types.js'

export function runStorageLifecycleAudit(options: StorageDoctorOptions = {}): StorageLifecycleReport {
  const stateDir = path.resolve(options.stateDir || storageStateDir())
  const generatedAt = normalizeDoctorNow(options.now)
  const dbPath = workStatePathForStateDir(stateDir)
  const checks: StorageLifecycleCheck[] = []
  const repairPlan: StorageLifecycleReport['repairPlan'] = []
  const addCheck = (check: StorageLifecycleCheck) => {
    checks.push(check)
    if (check.status !== 'pass') {
      repairPlan.push({
        code: check.name,
        severity: check.status,
        action: lifecycleRepairAction(check),
        ...(check.details ? { evidence: check.details } : {}),
      })
    }
  }
  const emptyReport = (): StorageLifecycleReport => ({
    id: storageLifecycleAuditId(new Date(generatedAt)),
    mode: 'm34_durable_state_lifecycle_audit',
    status: lifecycleStatus(checks),
    generatedAt,
    stateDir: redactStatePath(stateDir, stateDir),
    releaseClaim: 'local_beta_lifecycle_audit_only_no_hosted_or_compliance_retention_claim',
    classes: [],
    compaction: emptyLifecycleCompaction(generatedAt),
    checks,
    repairPlan,
    unsupportedClaims: storageLifecycleUnsupportedClaims(),
  })

  if (!fs.existsSync(dbPath)) {
    addCheck({
      name: 'gateway_db_present',
      status: 'fail',
      summary: 'Authoritative Gateway database is missing; lifecycle audit cannot inspect durable state.',
      repairability: 'restore_required',
      details: { file: redactStatePath(dbPath, stateDir) },
    })
    return emptyReport()
  }

  const integrity = checkDatabaseIntegrity(dbPath)
  if (integrity !== 'ok') {
    addCheck({
      name: 'gateway_db_integrity',
      status: 'fail',
      summary: 'Authoritative Gateway database failed SQLite integrity check; lifecycle audit refuses deeper scans.',
      repairability: 'restore_required',
      details: { file: redactStatePath(dbPath, stateDir), integrity },
    })
    return emptyReport()
  }

  const db = openSqliteReadOnly(dbPath)
  try {
    const compaction = lifecycleCompactionDryRun(db, generatedAt)
    const classes = lifecycleClasses(db, stateDir)

    addCheck({
      name: 'compaction_dry_run',
      status: 'pass',
      summary: compaction.prunableEvents
        ? `Compaction dry-run identified ${compaction.prunableEvents} bounded workflow event row(s) eligible for pruning without mutating state.`
        : 'Compaction dry-run found no bounded workflow event rows eligible for pruning.',
      repairability: 'none',
      details: { mutates: compaction.mutates, prunableEvents: compaction.prunableEvents, affectedTypes: compaction.affectedTypes.map(row => row.type) },
    })
    addCheck(lifecycleMalformedEventPayloadCheck(db))
    for (const check of lifecycleReceiptReferenceChecks(db)) addCheck(check)
    for (const check of lifecycleAuditLedgerChecks(db)) addCheck(check)

    return {
      id: storageLifecycleAuditId(new Date(generatedAt)),
      mode: 'm34_durable_state_lifecycle_audit',
      status: lifecycleStatus(checks),
      generatedAt,
      stateDir: redactStatePath(stateDir, stateDir),
      releaseClaim: 'local_beta_lifecycle_audit_only_no_hosted_or_compliance_retention_claim',
      classes: classes.map(row => ({ ...row, status: lifecycleClassStatus(row.retentionClass, checks) })),
      compaction,
      checks,
      repairPlan,
      unsupportedClaims: storageLifecycleUnsupportedClaims(),
    }
  } catch (err: any) {
    addCheck({
      name: 'lifecycle_audit_scan',
      status: 'fail',
      summary: 'Durable state lifecycle audit could not complete.',
      repairability: 'restore_required',
      details: { error: err?.message || String(err), file: redactStatePath(dbPath, stateDir) },
    })
    return emptyReport()
  } finally {
    db.close()
  }
}
export function runStorageDoctor(options: StorageDoctorOptions = {}): StorageDoctorReport {
  const stateDir = path.resolve(options.stateDir || storageStateDir())
  const generatedAt = normalizeDoctorNow(options.now)
  const issues: StorageDoctorIssue[] = []
  const addIssue = (issue: StorageDoctorIssue) => issues.push(issue)
  const backend = describeStorageBackend({ stateDir, config: options.config, env: options.env })
  let sources = listStorageSources({ stateDir })
  let counts: StorageBackupMetadata['counts'] | undefined
  let channelBindingCount = 0

  if (!fs.existsSync(stateDir)) {
    addIssue({
      severity: 'critical',
      code: 'state_dir_missing',
      sourceId: 'state_dir',
      summary: 'Gateway state directory is missing.',
      remediation: 'Create the Gateway state directory or run setup before starting Gateway.',
      evidence: { stateDir: redactStatePath(stateDir, stateDir) },
    })
  } else {
    try {
      fs.accessSync(stateDir, fs.constants.R_OK | fs.constants.W_OK)
    } catch (err: any) {
      addIssue({
        severity: 'critical',
        code: 'state_dir_unavailable',
        sourceId: 'state_dir',
        summary: 'Gateway state directory is not readable and writable.',
        remediation: 'Fix state directory ownership, permissions, or disk availability before running Gateway.',
        evidence: { stateDir: redactStatePath(stateDir, stateDir), error: err?.message || String(err) },
      })
    }
  }

  const dbPath = workStatePathForStateDir(stateDir)
  if (!fs.existsSync(dbPath)) {
    addIssue({
      severity: 'critical',
      code: 'gateway_db_missing',
      sourceId: 'gateway_db',
      summary: 'Authoritative Gateway database is missing.',
      remediation: 'Run `opencode-gateway setup` to initialize Gateway state, or restore a verified backup, before dispatching work.',
      evidence: { file: redactStatePath(dbPath, stateDir) },
    })
  } else {
    const integrity = checkDatabaseIntegrity(dbPath)
    if (integrity !== 'ok') {
      addIssue({
        severity: 'critical',
        code: 'gateway_db_integrity_failed',
        sourceId: 'gateway_db',
        summary: 'Authoritative Gateway database failed SQLite integrity check.',
        remediation: 'Stop Gateway, restore the latest verified backup (or reinitialize with `opencode-gateway setup` if no backup exists), and preserve the corrupt database for forensic inspection.',
        evidence: { file: redactStatePath(dbPath, stateDir), integrity },
      })
    } else {
      try {
        const read = withReadOnlyStorageDb(dbPath, readOnlyDbPath => {
          const state = loadWorkStateReadOnly(readOnlyDbPath, { runsScope: 'all' })
          return {
            state,
            channelBindings: listChannelBindingsReadOnly({}, readOnlyDbPath).length,
            events: listWorkEventsReadOnly(500, readOnlyDbPath).length,
          }
        })
        channelBindingCount = read.channelBindings
        counts = {
          roadmaps: read.state.roadmaps.length,
          supervisors: read.state.supervisors.length,
          projectBindings: read.state.projectBindings.length,
          completionProposals: read.state.completionProposals.length,
          tasks: read.state.tasks.length,
          runs: read.state.runs.length,
          channelBindings: channelBindingCount,
          events: read.events,
        }
      } catch (err: any) {
        addIssue({
          severity: 'critical',
          code: 'gateway_db_unreadable',
          sourceId: 'gateway_db',
          summary: 'Gateway database could not be loaded through the work-store repository.',
          remediation: 'Stop Gateway, then recreate the database with `opencode-gateway setup` or restore a compatible verified backup. This project keeps no cross-version schema migration: an incompatible database is reinitialized, not upgraded.',
          evidence: { file: redactStatePath(dbPath, stateDir), error: err?.message || String(err) },
        })
      }
    }
  }

  const channelSyncPath = path.join(stateDir, 'channel-sync.json')
  const channelSyncParse = readJsonArtifact(channelSyncPath)
  const channelSyncKeys = channelSyncParse.ok ? channelSyncDeliveryKeys(channelSyncParse.value) : new Set<string>()
  if (fs.existsSync(channelSyncPath) && !channelSyncParse.ok) {
    addIssue({
      severity: 'warning',
      code: 'json_artifact_corrupt',
      sourceId: 'channel_sync_checkpoint',
      summary: 'Channel sync checkpoint JSON is unreadable.',
      remediation: 'Restore channel-sync.json from a verified backup or move it aside during a maintenance window to rebuild checkpoints intentionally.',
      evidence: { file: redactStatePath(channelSyncPath, stateDir), error: channelSyncParse.error },
    })
  }

  for (const source of storageSourceSpecs(stateDir)) {
    if (source.json && fs.existsSync(source.rawPath) && source.id !== 'channel_sync_checkpoint') {
      const parsed = readJsonArtifact(source.rawPath)
      if (!parsed.ok) {
        addIssue({
          severity: 'warning',
          code: 'json_artifact_corrupt',
          sourceId: source.id,
          summary: `${source.label} JSON is unreadable.`,
          remediation: source.remediation,
          evidence: { file: redactStatePath(source.rawPath, stateDir), error: parsed.error },
        })
      }
    }
  }

  const outbox = inspectChannelSyncOutbox(channelSyncOutboxPath(stateDir), channelSyncKeys)
  if (outbox.error) {
    addIssue({
      severity: 'warning',
      code: outbox.code || 'channel_outbox_unreadable',
      sourceId: 'channel_sync_outbox',
      summary: outbox.summary || 'Channel sync outbox could not be inspected.',
      remediation: 'Stop Gateway, verify channel-sync.json.sqlite, and restore it from a verified backup if the outbox cannot be opened.',
      evidence: { file: redactStatePath(channelSyncOutboxPath(stateDir), stateDir), error: outbox.error },
    })
  }
  if (!fs.existsSync(channelSyncPath) && outbox.pendingRows > 0) {
    addIssue({
      severity: 'warning',
      code: 'channel_sync_checkpoint_missing',
      sourceId: 'channel_sync_checkpoint',
      summary: 'Channel sync checkpoint cache is missing while pending outbox rows exist.',
      remediation: 'Restore channel-sync.json from backup or intentionally rebuild checkpoints during a quiet maintenance window.',
      evidence: { channelBindings: channelBindingCount, pendingOutboxRows: outbox.pendingRows },
    })
  } else if (!fs.existsSync(channelSyncPath)) {
    addIssue({
      severity: 'info',
      code: 'sidecar_missing',
      sourceId: 'channel_sync_checkpoint',
      summary: 'Channel sync checkpoint cache is absent.',
      remediation: 'No action is required until channel sync is enabled or channel bindings exist.',
      evidence: { file: redactStatePath(channelSyncPath, stateDir) },
    })
  }
  if (outbox.mismatches.length) {
    addIssue({
      severity: 'warning',
      code: 'channel_outbox_checkpoint_mismatch',
      sourceId: 'channel_sync_outbox',
      summary: 'Channel sync outbox rows do not have matching delivery checkpoints.',
      remediation: 'Pause channel sync, inspect pending outbox rows, and restore or rebuild channel-sync.json before retrying delivery.',
      evidence: { mismatches: outbox.mismatches.slice(0, 10), pendingRows: outbox.pendingRows },
    })
  }

  for (const source of sources) {
    if (!source.exists && !source.required && source.id !== 'channel_sync_checkpoint') {
      addIssue({
        severity: 'info',
        code: 'sidecar_missing',
        sourceId: source.id,
        summary: `${source.label} is not present.`,
        remediation: source.remediation,
        evidence: { file: source.path },
      })
    }
  }

  const backupPath = options.backupPath ? normalizeBackupPath(options.backupPath) : latestBackupPath(stateDir)
  if (backupPath) {
    const verification = verifyStorageBackup(backupPath)
    if (!verification.ok) {
      addIssue({
        severity: 'warning',
        code: 'backup_verification_failed',
        sourceId: 'backups',
        summary: 'Latest or selected backup does not verify cleanly.',
        remediation: 'Create a fresh backup after fixing verification errors, then rerun the storage doctor.',
        evidence: { backupPath: redactPath(verification.path, stateDir, '<backup>'), errors: verification.errors },
      })
    } else {
      const backedUpNames = new Set((verification.metadata?.files || []).map(file => file.name))
      for (const source of storageSourceSpecs(stateDir)) {
        if (!source.backedUp || !source.fileName || !fs.existsSync(source.rawPath)) continue
        if (backedUpNames.has(source.fileName)) continue
        addIssue({
          severity: 'warning',
          code: 'backup_missing_source',
          sourceId: 'backups',
          summary: `Backup is missing ${source.label}.`,
          remediation: 'Create a new backup with the current runtime so all state sources are captured.',
          evidence: { backupPath: redactPath(verification.path, stateDir, '<backup>'), missingFile: source.fileName },
        })
      }
    }
  } else {
    addIssue({
      severity: 'info',
      code: 'backup_missing',
      sourceId: 'backups',
      summary: 'No storage backup with metadata exists yet.',
      remediation: 'Run `opencode-gateway backup create` before upgrades, restores, or release evidence collection.',
      evidence: { directory: redactStatePath(path.join(stateDir, 'backups'), stateDir) },
    })
  }

  for (const issue of scanWorkStoreConsistencyIssues(dbPath, stateDir, Date.parse(generatedAt))) addIssue(issue)

  sources = listStorageSources({ stateDir })
  const status: StorageDoctorStatus = issues.some(issue => issue.severity === 'critical')
    ? 'down'
    : issues.some(issue => issue.severity === 'warning')
      ? 'degraded'
      : 'ok'
  const actionable = issues.filter(issue => issue.severity !== 'info')
  const consistency = buildBackendConsistencyProofFromContext({
    stateDir,
    dbPath,
    generatedAt,
    backend,
    issues,
    status,
    counts,
    backupPath,
    config: options.config,
    env: options.env,
  })
  const lifecycle = runStorageLifecycleAudit({ stateDir, now: generatedAt, config: options.config, env: options.env })
  return {
    status,
    generatedAt,
    stateDir: redactStatePath(stateDir, stateDir),
    ...(backupPath ? { backupPath: redactPath(backupPath, stateDir, '<backup>') } : {}),
    backend,
    consistency,
    lifecycle,
    summary: status === 'ok'
      ? `Storage sources are consistent across ${sources.length} tracked source${sources.length === 1 ? '' : 's'}.`
      : `${actionable.length} storage source${actionable.length === 1 ? '' : 's'} ${actionable.length === 1 ? 'needs' : 'need'} attention.`,
    sources,
    issues,
    ...(counts ? { counts } : {}),
  }
}
function scanWorkStoreConsistencyIssues(dbPath: string, stateDir: string, nowMs: number): StorageDoctorIssue[] {
  if (!fs.existsSync(dbPath)) return []
  const issues: StorageDoctorIssue[] = []
  const add = (
    severity: StorageDoctorSeverity,
    code: string,
    summary: string,
    remediation: string,
    evidence?: Record<string, unknown>,
  ) => issues.push({ severity, code, sourceId: 'gateway_db', summary, remediation, ...(evidence ? { evidence } : {}) })

  try {
    withReadOnlyStorageDb(dbPath, readOnlyDbPath => {
      const state = loadWorkStateReadOnly(readOnlyDbPath, { runsScope: 'all' })
      const taskIds = new Set(state.tasks.map(task => task.id))
      const roadmapIds = new Set(state.roadmaps.map(roadmap => roadmap.id))
      const runIds = new Set(state.runs.map(run => run.id))
      const db = openSqliteReadOnly(readOnlyDbPath)
      try {
        const eventIds = new Set(queryRows(db, 'SELECT id FROM events').map(row => Number(row['id'])).filter(Number.isInteger))
        const sessionSidecarIds = readSessionSidecarIds(stateDir)
        const addMissingSessionIssue = (
        code: string,
        summary: string,
        remediation: string,
        sessionId: unknown,
        evidence: Record<string, unknown> = {},
      ) => {
        const normalized = String(sessionId || '').trim()
        if (!sessionSidecarIds || !normalized || sessionSidecarIds.has(normalized)) return
        add('warning', code, summary, remediation, { ...evidence, session: fingerprintId(normalized) })
      }
      const activeRunsByTask = new Map<string, string[]>()
      for (const run of state.runs) {
        if (!taskIds.has(run.taskId)) {
          add('critical', 'run_task_missing', 'Run records reference missing tasks.', 'Stop dispatch, restore from a verified backup or repair the run/task relationship before resuming work.', { count: 1, sample: fingerprintIds([run.id]) })
        }
        if (run.status === 'running') {
          const rows = activeRunsByTask.get(run.taskId) || []
          rows.push(run.id)
          activeRunsByTask.set(run.taskId, rows)
          addMissingSessionIssue(
            'run_session_missing',
            'Running run records reference OpenCode sessions absent from the session sidecar.',
            'Reconnect or reconcile active OpenCode sessions before claiming live session recovery or migration proof.',
            run.sessionId,
            { run: fingerprintId(run.id) },
          )
          if (!run.leaseOwner || !run.leaseExpiresAt) {
            add('warning', 'run_lease_missing', 'Running run records are missing lease ownership or expiry.', 'Recover or fail the affected runs before backup, rollback, or cutover proof.', { sample: fingerprintIds([run.id]) })
          } else if (Number.isFinite(Date.parse(run.leaseExpiresAt)) && Date.parse(run.leaseExpiresAt) <= nowMs) {
            add('warning', 'run_lease_expired', 'Running run leases are expired and need recovery.', 'Run scheduler recovery before claiming backend read-model consistency.', { sample: fingerprintIds([run.id]) })
          }
        }
      }
      for (const [taskId, runs] of activeRunsByTask) {
        if (runs.length > 1) {
          add('critical', 'multiple_active_runs_for_task', 'More than one active run exists for the same task.', 'Fence duplicate runs and preserve the first accepted completion receipt before resuming dispatch.', { task: fingerprintId(taskId), count: runs.length, sample: fingerprintIds(runs.slice(0, 5)) })
        }
      }
      for (const task of state.tasks) {
        if (task.currentRunId && !runIds.has(task.currentRunId)) {
          add('critical', 'task_current_run_missing', 'Task read model points at a missing current run.', 'Repair the task projection or restore a backup before migration/cutover proof.', { task: fingerprintId(task.id), currentRun: fingerprintId(task.currentRunId) })
        }
        if (task.status === 'running' && !state.runs.some(run => run.taskId === task.id && run.status === 'running')) {
          add('warning', 'task_running_projection_stale', 'Task status is running without a matching active run.', 'Run recovery or reconcile the task projection before publishing backend consistency evidence.', { task: fingerprintId(task.id) })
        }
      }
      for (const dependency of state.dependencies || []) {
        if (!taskIds.has(dependency.taskId) || !taskIds.has(dependency.dependsOnTaskId)) {
          add('critical', 'dependency_task_missing', 'Work dependency rows reference missing tasks.', 'Repair dependency rows or restore from verified backup before migration/cutover proof.', { count: 1, sample: fingerprintIds([dependency.taskId, dependency.dependsOnTaskId]) })
        }
      }
      for (const binding of state.projectBindings) {
        if (!roadmapIds.has(binding.roadmapId)) {
          add('critical', 'project_binding_roadmap_missing', 'Project binding rows reference missing roadmaps.', 'Repair project bindings before channel routing or backend migration proof.', { binding: fingerprintId(binding.id), roadmap: fingerprintId(binding.roadmapId) })
        }
        addMissingSessionIssue(
          'project_binding_session_missing',
          'Project binding rows reference OpenCode sessions absent from the session sidecar.',
          'Rebind the project to a live OpenCode session or refresh the session sidecar before proving cross-surface recovery.',
          binding.sessionId,
          { binding: fingerprintId(binding.id), scope: binding.scope },
        )
      }
      for (const proposal of state.completionProposals) {
        if (!roadmapIds.has(proposal.roadmapId)) {
          add('warning', 'completion_proposal_roadmap_missing', 'Roadmap completion proposals reference missing roadmaps.', 'Reject or repair stale completion proposals before release evidence export.', { proposal: fingerprintId(proposal.id), roadmap: fingerprintId(proposal.roadmapId) })
        }
      }
      for (const supervisor of state.supervisors) {
        if (!roadmapIds.has(supervisor.roadmapId)) {
          add('warning', 'supervisor_roadmap_missing', 'Roadmap supervisors reference missing roadmaps.', 'Pause or repair stale supervisors before claiming deterministic wakeup recovery.', { supervisor: fingerprintId(supervisor.supervisorId), roadmap: fingerprintId(supervisor.roadmapId) })
        }
        addMissingSessionIssue(
          'supervisor_session_missing',
          'Roadmap supervisors reference OpenCode sessions absent from the session sidecar.',
          'Refresh supervisor session ownership or rebind the supervisor before claiming heartbeat recovery proof.',
          supervisor.sessionId,
          { supervisor: fingerprintId(supervisor.supervisorId), roadmap: fingerprintId(supervisor.roadmapId) },
        )
      }
      for (const binding of listChannelBindingsReadOnly({}, readOnlyDbPath)) {
        if (binding.taskId && !taskIds.has(binding.taskId)) {
          add('warning', 'channel_binding_task_missing', 'Channel binding rows reference missing tasks.', 'Repair stale channel bindings before claiming recovery parity or backend migration proof.', { provider: binding.provider, task: fingerprintId(binding.taskId) })
        }
        if (binding.roadmapId && !roadmapIds.has(binding.roadmapId)) {
          add('warning', 'channel_binding_roadmap_missing', 'Channel binding rows reference missing roadmaps.', 'Repair stale channel bindings before claiming recovery parity or backend migration proof.', { provider: binding.provider, roadmap: fingerprintId(binding.roadmapId) })
        }
        addMissingSessionIssue(
          'channel_binding_session_missing',
          'Channel binding rows reference OpenCode sessions absent from the session sidecar.',
          'Use the channel recovery flow to rebind the trusted channel to a live OpenCode session, then rerun storage doctor.',
          binding.sessionId,
          { provider: binding.provider, mode: binding.mode },
        )
      }

      const dispatchRows = db.prepare('SELECT id, task_id, status, run_id, lease_expires_at FROM task_dispatch_receipts').all() as any[]
      for (const row of dispatchRows) {
        if (!taskIds.has(String(row.task_id || ''))) {
          add('critical', 'dispatch_receipt_task_missing', 'Dispatch receipts reference missing tasks.', 'Repair dispatch receipts or restore from backup before resuming scheduler dispatch.', { receipt: fingerprintId(row.id), task: fingerprintId(row.task_id) })
        }
        if (row.status === 'started' && row.run_id && !runIds.has(String(row.run_id))) {
          add('warning', 'dispatch_receipt_run_missing', 'Started dispatch receipts reference missing runs.', 'Reconcile dispatch receipts before using them for idempotency or migration proof.', { receipt: fingerprintId(row.id), run: fingerprintId(row.run_id) })
        }
        if (row.status === 'starting' && Number.isFinite(Date.parse(row.lease_expires_at)) && Date.parse(row.lease_expires_at) <= nowMs) {
          add('warning', 'dispatch_receipt_lease_expired', 'Starting dispatch receipts have expired leases.', 'Run dispatch recovery before claiming backend dispatch consistency.', { receipt: fingerprintId(row.id) })
        }
      }

      const delegationRows = db.prepare('SELECT idempotency_key, task_ids_json, roadmap_id FROM delegation_receipts').all() as any[]
      const delegationKeys = new Set(delegationRows.map(row => String(row.idempotency_key || '')))
      for (const row of delegationRows) {
        const taskIdsJson = parseJsonArray(row.task_ids_json)
        const missingTasks = taskIdsJson.filter(taskId => !taskIds.has(String(taskId)))
        if (missingTasks.length) {
          add('critical', 'delegation_receipt_task_missing', 'Delegation receipts reference missing task rows.', 'Backfill or repair delegation receipts before retention, replay, or migration proof.', { receipt: fingerprintId(row.idempotency_key), missingCount: missingTasks.length, sample: fingerprintIds(missingTasks.slice(0, 5)) })
        }
        if (row.roadmap_id && !roadmapIds.has(String(row.roadmap_id))) {
          add('warning', 'delegation_receipt_roadmap_missing', 'Delegation receipts reference missing roadmaps.', 'Repair delegation metadata before claiming deterministic parent-session continuity.', { receipt: fingerprintId(row.idempotency_key), roadmap: fingerprintId(row.roadmap_id) })
        }
      }

      const progressRows = db.prepare('SELECT progress_key, idempotency_key, event_id FROM delegation_progress_receipts').all() as any[]
      const progressKeys = new Set(progressRows.map(row => String(row.progress_key || '')))
      for (const row of progressRows) {
        if (!delegationKeys.has(String(row.idempotency_key || ''))) {
          add('warning', 'progress_receipt_delegation_missing', 'Delegation progress receipts reference missing delegation receipts.', 'Backfill delegation receipts before relying on progress receipts as replay evidence.', { progress: fingerprintId(row.progress_key), delegation: fingerprintId(row.idempotency_key) })
        }
        if (row.event_id !== null && row.event_id !== undefined && !eventIds.has(Number(row.event_id))) {
          add('warning', 'progress_receipt_event_missing', 'Delegation progress receipts reference missing workflow events.', 'Keep progress receipts authoritative and repair missing event references before evidence export.', { progress: fingerprintId(row.progress_key), event: fingerprintId(row.event_id) })
        }
      }

      const routeRows = db.prepare('SELECT dedupe_key, progress_key, idempotency_key, state, delivery, target_key, provider, session_id, progress_event_id, last_event_id FROM delegation_progress_route_receipts').all() as any[]
      for (const row of routeRows) {
        if (row.idempotency_key && !delegationKeys.has(String(row.idempotency_key))) {
          add('warning', 'progress_route_receipt_delegation_missing', 'Delegation progress route receipts reference missing delegation receipts.', 'Backfill delegation receipts before relying on route receipts for delivery proof.', { route: fingerprintId(row.dedupe_key), delegation: fingerprintId(row.idempotency_key) })
        }
        if (row.progress_key && !progressKeys.has(String(row.progress_key))) {
          add('warning', 'progress_route_receipt_progress_missing', 'Delegation progress route receipts reference missing progress receipts.', 'Backfill progress receipts before relying on route receipts as replay evidence.', { route: fingerprintId(row.dedupe_key), progress: fingerprintId(row.progress_key) })
        }
        if (row.progress_event_id !== null && row.progress_event_id !== undefined && !eventIds.has(Number(row.progress_event_id))) {
          add('warning', 'progress_route_receipt_event_missing', 'Delegation progress route receipts reference pruned or missing workflow events.', 'Use the durable route receipt state for recovery, and refresh shareable proof if event refs are required.', { route: fingerprintId(row.dedupe_key), event: fingerprintId(row.progress_event_id) })
        }
        if ((row.state === 'delivered' || row.state === 'retried') && row.provider && !row.target_key) {
          add('warning', 'progress_route_receipt_target_missing', 'Channel delivery route receipts are missing redacted target hashes.', 'Repair or rerun channel delivery before exporting provider proof.', { route: fingerprintId(row.dedupe_key), provider: row.provider })
        }
        if ((row.state === 'delivered' || row.state === 'retried') && row.delivery === 'session' && !row.session_id) {
          add('warning', 'progress_route_receipt_session_missing', 'Parent-session delivery route receipts are missing session IDs.', 'Rebind or rerun parent-session delivery before claiming parent continuity.', { route: fingerprintId(row.dedupe_key) })
        }
      }

      const wakeRows = db.prepare('SELECT id, supervisor_id, roadmap_id, status, lease_expires_at FROM supervisor_wakeup_receipts').all() as any[]
      const supervisorIds = new Set(state.supervisors.map(supervisor => supervisor.supervisorId))
      for (const row of wakeRows) {
        if (!supervisorIds.has(String(row.supervisor_id || ''))) {
          add('warning', 'wakeup_receipt_supervisor_missing', 'Supervisor wakeup receipts reference missing supervisors.', 'Repair stale supervisor wakeup receipts before claiming heartbeat/recovery determinism.', { receipt: fingerprintId(row.id), supervisor: fingerprintId(row.supervisor_id) })
        }
        if (!roadmapIds.has(String(row.roadmap_id || ''))) {
          add('warning', 'wakeup_receipt_roadmap_missing', 'Supervisor wakeup receipts reference missing roadmaps.', 'Repair stale supervisor wakeup receipts before claiming roadmap recovery determinism.', { receipt: fingerprintId(row.id), roadmap: fingerprintId(row.roadmap_id) })
        }
        if (row.status === 'leased' && Number.isFinite(Date.parse(row.lease_expires_at)) && Date.parse(row.lease_expires_at) <= nowMs) {
          add('warning', 'wakeup_receipt_lease_expired', 'Supervisor wakeup receipt leases are expired.', 'Run supervisor recovery before claiming scheduled wakeup consistency.', { receipt: fingerprintId(row.id) })
        }
      }

      const eventRows = db.prepare('SELECT id, type, payload_json, created_at FROM events ORDER BY id DESC LIMIT 5000').all() as any[]
      for (const row of eventRows) {
        if (!String(row.type || '').trim()) {
          add('warning', 'event_type_missing', 'Workflow events with empty event types were found.', 'Preserve the database for inspection and repair malformed event rows before evidence export.', { event: fingerprintId(row.id) })
        }
        if (!Number.isFinite(Date.parse(row.created_at))) {
          add('warning', 'event_timestamp_invalid', 'Workflow events with invalid timestamps were found.', 'Repair malformed event timestamps before using event order as release evidence.', { event: fingerprintId(row.id) })
        }
        try {
          JSON.parse(String(row.payload_json || '{}'))
        } catch {
          add('warning', 'event_payload_unreadable', 'Workflow event payload JSON is unreadable.', 'Repair malformed event payloads before evidence export or migration proof.', { event: fingerprintId(row.id) })
        }
      }
      } finally {
        db.close()
      }
    })
  } catch (err: any) {
    add('critical', 'work_store_invariant_scan_failed', 'Work-store invariant scan could not complete.', 'Stop Gateway, inspect storage errors, and restore from a verified backup if the scanner cannot load durable state.', { error: err?.message || String(err), file: redactStatePath(dbPath, stateDir) })
  }
  return coalesceStorageIssues(issues)
}
function buildBackendConsistencyProofFromContext(input: {
  stateDir: string
  dbPath: string
  generatedAt: string
  backend: StorageBackendPosture
  issues: StorageDoctorIssue[]
  status: StorageDoctorStatus
  counts?: StorageBackupMetadata['counts']
  backupPath?: string
  config?: GatewayConfig
  env?: NodeJS.ProcessEnv
}): BackendConsistencyProof {
  const backup = backendConsistencyBackup(input.backupPath, input.counts)
  const latestRecoveryDrill = latestRecoveryDrillSummary(input.stateDir)
  const criticalCount = input.issues.filter(issue => issue.severity === 'critical').length
  const warningCount = input.issues.filter(issue => issue.severity === 'warning').length
  const readChecksum = input.counts ? readModelChecksum(input.counts) : undefined
  const readModelStatus: BackendConsistencyProofStatus = criticalCount ? 'fail' : warningCount ? 'warn' : 'pass'
  const proofStatus: BackendConsistencyProofStatus = criticalCount || backup.status === 'failed'
    ? 'fail'
    : warningCount
      ? 'warn'
      : 'pass'
  return {
    mode: 'm28_backend_consistency_proof',
    status: proofStatus,
    generatedAt: input.generatedAt,
    runtimePosture: backendRuntimePosture(input.backend, input.status),
    runtimeBackend: input.backend.mode,
    effectivePersistence: 'local_sqlite',
    releaseClaim: 'tested_backend_modes_only_no_hosted_or_multi_tenant_storage_claim',
    consistencyScan: {
      status: input.status,
      issueCodes: input.issues.map(issue => issue.code),
      criticalCount,
      warningCount,
      scannedDomains: listWorkStoreRepositoryDomains().map(domain => domain.id),
    },
    backup,
    rollback: {
      status: backup.status === 'verified'
        ? 'drill_available'
        : backup.status === 'failed'
          ? 'blocked_failed_backup'
          : 'blocked_missing_verified_backup',
      requiredCommand: 'opencode-gateway backend rollback-dry-run --from <backup-path> --json',
      ...(latestRecoveryDrill ? { latestRecoveryDrill } : {}),
    },
    readModel: {
      status: readModelStatus,
      ...(readChecksum ? { checksum: readChecksum } : {}),
      deterministicAfterRestart: Boolean(readChecksum && !criticalCount),
      ...(input.counts ? { counts: input.counts } : {}),
    },
    contracts: listWorkStoreRepositoryDomains().map(domain => ({
      domain: domain.id,
      owner: domain.owner,
      transactionOwner: domain.transactionOwner,
      mutationEntryPoint: domain.mutationContract.entryPoint,
      rollbackGate: domain.mutationContract.rollbackGate,
      tables: [...domain.tables],
      operationGroups: [...domain.operationGroups],
      requiredProofCount: domain.mutationContract.requiredProof.length,
      invariantCount: domain.invariants.length,
    })),
    checks: [
      {
        id: 'storage_doctor_consistency',
        domain: 'storage',
        status: criticalCount ? 'fail' : warningCount ? 'warn' : 'pass',
        summary: criticalCount ? `${criticalCount} critical storage consistency issue(s) found.` : warningCount ? `${warningCount} storage consistency warning(s) found.` : 'Storage doctor and domain invariant scan found no actionable consistency issues.',
        evidence: { status: input.status, issueCodes: input.issues.map(issue => issue.code) },
      },
      {
        id: 'backup_freshness',
        domain: 'backup_restore',
        status: backup.status === 'failed' ? 'fail' : backup.status === 'verified' ? 'pass' : 'warn',
        summary: backup.status === 'verified' ? `Verified backup freshness is ${backup.freshness}.` : backup.status === 'missing' ? 'No verified backup is available for rollback proof.' : 'Selected backup failed verification.',
        evidence: { status: backup.status, freshness: backup.freshness, errorCount: backup.errors.length },
      },
      {
        id: 'rollback_safety',
        domain: 'backup_restore',
        status: backup.status === 'verified' ? 'pass' : backup.status === 'failed' ? 'fail' : 'warn',
        summary: backup.status === 'verified' ? 'Rollback drill command can run from the verified backup.' : 'Rollback safety is blocked until a verified backup exists.',
      },
      {
        id: 'read_model_restart_determinism',
        domain: 'read_models',
        status: readModelStatus,
        summary: readChecksum ? 'Read-model checksum can be recomputed from durable counts after restart.' : 'Read-model checksum is unavailable because the durable state could not be inspected.',
        evidence: { checksumPresent: Boolean(readChecksum), deterministicAfterRestart: Boolean(readChecksum && !criticalCount) },
      },
    ],
    blockedStates: backendConsistencyBlockedStates(input.issues, backup),
    evidencePolicy: backendMigrationEvidencePolicy(),
    unsupportedClaims: [
      'self-hosted production storage',
      'hosted managed database',
      'hosted control-plane production storage',
      'multi-tenant storage readiness',
      'managed backup/restore service',
      'production cutover without a final backend-consistency approval',
    ],
  }
}
function lifecycleCompactionDryRun(db: DatabaseSync, generatedAt: string): StorageLifecycleCompactionDryRun {
  const cutoff = new Date(Date.parse(generatedAt) - WORK_EVENT_RETENTION_MS).toISOString()
  if (!sqliteTableExists(db, 'events')) return emptyLifecycleCompaction(generatedAt)
  const durable = storageLifecycleDurableEventSql()
  const totalEvents = lifecycleCount(db, 'events')
  const durableEvents = lifecycleCountSql(db, `SELECT COUNT(*) AS count FROM events WHERE type IN ${durable}`)
  const prunableEvents = lifecycleCountSql(db, `
    SELECT COUNT(*) AS count
    FROM events
    WHERE type NOT IN ${durable}
      AND (created_at < ? OR id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT ?))
  `, cutoff, MAX_WORK_EVENT_ROWS)
  const affectedRows = db.prepare(`
    WITH ranked AS (
      SELECT
        id,
        type,
        created_at,
        CASE WHEN created_at < ? THEN 1 ELSE 0 END AS older_than_retention,
        CASE WHEN id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT ?) THEN 1 ELSE 0 END AS outside_row_cap
      FROM events
      WHERE type NOT IN ${durable}
    )
    SELECT
      type,
      COUNT(*) AS rows,
      SUM(older_than_retention) AS older_than_retention,
      SUM(outside_row_cap) AS outside_row_cap,
      MIN(id) AS first_event_id,
      MAX(id) AS last_event_id,
      MIN(created_at) AS oldest_created_at,
      MAX(created_at) AS newest_created_at
    FROM ranked
    WHERE older_than_retention = 1 OR outside_row_cap = 1
    GROUP BY type
    ORDER BY rows DESC, type ASC
  `).all(cutoff, MAX_WORK_EVENT_ROWS) as any[]
  return {
    mode: 'dry_run',
    mutates: false,
    cutoff,
    maxEventRows: MAX_WORK_EVENT_ROWS,
    durableEventTypes: [...DURABLE_WORK_EVENT_TYPES],
    totalEvents,
    durableEvents,
    prunableEvents,
    affectedTypes: affectedRows.map(row => ({
      type: String(row.type || ''),
      rows: Number(row.rows || 0),
      olderThanRetention: Number(row.older_than_retention || 0),
      outsideRowCap: Number(row.outside_row_cap || 0),
      ...(row.first_event_id === null || row.first_event_id === undefined ? {} : { firstEventId: Number(row.first_event_id) }),
      ...(row.last_event_id === null || row.last_event_id === undefined ? {} : { lastEventId: Number(row.last_event_id) }),
      ...(row.oldest_created_at ? { oldestCreatedAt: String(row.oldest_created_at) } : {}),
      ...(row.newest_created_at ? { newestCreatedAt: String(row.newest_created_at) } : {}),
    })),
  }
}
function lifecycleClasses(db: DatabaseSync, stateDir: string): StorageLifecycleClass[] {
  const authoritativeTables = ['roadmaps', 'tasks', 'work_dependencies', 'runs', 'roadmap_supervisors', 'project_bindings', 'roadmap_completion_proposals', 'channel_bindings', 'human_gates']
  const receiptTables = ['delegation_receipts', 'delegation_progress_receipts', 'delegation_progress_route_receipts', 'task_dispatch_receipts', 'supervisor_wakeup_receipts']
  const sidecarRows = listStorageSources({ stateDir }).filter(source => source.exists && ['derived_cache', 'append_only_evidence', 'transactional_sqlite'].includes(source.kind)).length
  const backupRows = listStorageBackups({ stateDir }).length
  return [
    {
      id: 'authoritative_work_graph',
      retentionClass: 'authoritative_state',
      rows: authoritativeTables.reduce((sum, table) => sum + lifecycleCount(db, table), 0),
      status: 'pass',
      compactionBehavior: 'never pruned by event retention; backed by gateway.db backup/restore.',
      repairBehavior: 'restore required for missing/corrupt authoritative rows; operator repair only for safe projection drift.',
    },
    {
      id: 'durable_receipts',
      retentionClass: 'durable_receipt',
      rows: receiptTables.reduce((sum, table) => sum + lifecycleCount(db, table), 0),
      status: 'pass',
      compactionBehavior: 'not pruned by event retention; receipts remain authoritative after bounded event compaction.',
      repairBehavior: 'repair missing cross-references before replay/evidence export; receipts can outlive source events.',
    },
    {
      id: 'bounded_workflow_events',
      retentionClass: 'bounded_event',
      rows: lifecycleCount(db, 'events'),
      status: 'pass',
      compactionBehavior: `non-durable events older than ${WORK_EVENT_RETENTION_MS}ms or outside the latest ${MAX_WORK_EVENT_ROWS} rows are prunable.`,
      repairBehavior: 'events are evidence aids; durable receipts/read models must remain authoritative when event rows are pruned.',
    },
    {
      id: 'audit_ledger',
      retentionClass: 'audit_ledger',
      rows: lifecycleCount(db, 'audit_ledger'),
      status: 'pass',
      compactionBehavior: 'append-only local audit ledger rows are not pruned by workflow event retention.',
      repairBehavior: 'hash-chain or malformed audit rows require restore/forensic inspection rather than automatic rewrite.',
    },
    {
      id: 'derived_sidecars',
      retentionClass: 'derived_sidecar',
      rows: sidecarRows,
      status: 'pass',
      compactionBehavior: 'sidecars are backed up when present and may be rebuilt only through documented owner flows.',
      repairBehavior: 'restore or rebuild deliberately during quiet maintenance; never infer provider targets from raw artifacts.',
    },
    {
      id: 'backup_artifacts',
      retentionClass: 'backup_artifact',
      rows: backupRows,
      status: 'pass',
      compactionBehavior: 'operator-created backups are retained by backup retention policy, outside event compaction.',
      repairBehavior: 'create a fresh verified backup before upgrades, restore drills, or release evidence collection.',
    },
  ]
}
function lifecycleMalformedEventPayloadCheck(db: DatabaseSync): StorageLifecycleCheck {
  if (!sqliteTableExists(db, 'events')) {
    return {
      name: 'event_payloads_parse',
      status: 'fail',
      summary: 'Workflow events table is missing.',
      repairability: 'restore_required',
    }
  }
  const malformed: string[] = []
  const rows = db.prepare('SELECT id, payload_json FROM events ORDER BY id ASC').all() as any[]
  for (const row of rows) {
    try {
      JSON.parse(String(row.payload_json || '{}'))
    } catch {
      malformed.push(fingerprintId(row.id))
    }
  }
  return {
    name: 'event_payloads_parse',
    status: malformed.length ? 'warn' : 'pass',
    summary: malformed.length
      ? `${malformed.length} workflow event payload(s) contain malformed JSON.`
      : 'Workflow event payload JSON is parseable.',
    repairability: malformed.length ? 'operator' : 'none',
    ...(malformed.length ? { details: { count: malformed.length, sample: malformed.slice(0, 8) } } : {}),
  }
}
function lifecycleReceiptReferenceChecks(db: DatabaseSync): StorageLifecycleCheck[] {
  const checks: StorageLifecycleCheck[] = []
  const taskIds = new Set(lifecycleStringRows(db, 'tasks', 'id'))
  const roadmapIds = new Set(lifecycleStringRows(db, 'roadmaps', 'id'))
  const delegationKeys = new Set(lifecycleStringRows(db, 'delegation_receipts', 'idempotency_key'))
  const progressKeys = new Set(lifecycleStringRows(db, 'delegation_progress_receipts', 'progress_key'))
  const eventIds = new Set(lifecycleNumberRows(db, 'events', 'id'))

  const missingDelegationTasks: string[] = []
  if (sqliteTableExists(db, 'delegation_receipts')) {
    const rows = db.prepare('SELECT idempotency_key, task_ids_json FROM delegation_receipts').all() as any[]
    for (const row of rows) {
      const missing = parseJsonArray(row.task_ids_json).filter(taskId => !taskIds.has(taskId))
      if (missing.length) missingDelegationTasks.push(fingerprintId(row.idempotency_key))
    }
  }
  checks.push(lifecycleReferenceCheck({
    name: 'delegation_receipt_task_refs',
    missing: missingDelegationTasks,
    missingStatus: 'fail',
    okSummary: 'Delegation receipts reference existing task rows.',
    missingSummary: `${missingDelegationTasks.length} delegation receipt(s) reference missing tasks.`,
    repairability: 'restore_required',
  }))

  const missingDelegationRoadmaps = lifecycleMissingRows(db, `
    SELECT idempotency_key AS id
    FROM delegation_receipts
    WHERE roadmap_id IS NOT NULL AND roadmap_id NOT IN (SELECT id FROM roadmaps)
  `)
  checks.push(lifecycleReferenceCheck({
    name: 'delegation_receipt_roadmap_refs',
    missing: missingDelegationRoadmaps,
    missingStatus: 'warn',
    okSummary: 'Delegation receipts reference existing roadmaps when roadmap IDs are present.',
    missingSummary: `${missingDelegationRoadmaps.length} delegation receipt(s) reference missing roadmaps.`,
    repairability: 'operator',
  }))

  const progressDelegationMissing = lifecycleMissingByPredicate(db, 'delegation_progress_receipts', 'progress_key', row => !delegationKeys.has(String(row.idempotency_key || '')))
  checks.push(lifecycleReferenceCheck({
    name: 'progress_receipt_delegation_refs',
    missing: progressDelegationMissing,
    missingStatus: 'warn',
    okSummary: 'Delegation progress receipts reference existing delegation receipts.',
    missingSummary: `${progressDelegationMissing.length} progress receipt(s) reference missing delegation receipts.`,
    repairability: 'operator',
  }))

  const progressEventMissing = lifecycleMissingByPredicate(db, 'delegation_progress_receipts', 'progress_key', row => row.event_id !== null && row.event_id !== undefined && !eventIds.has(Number(row.event_id)))
  checks.push(lifecycleReferenceCheck({
    name: 'progress_receipt_event_refs',
    missing: progressEventMissing,
    missingStatus: 'warn',
    okSummary: 'Delegation progress receipts either have no event reference or point at retained workflow events.',
    missingSummary: `${progressEventMissing.length} progress receipt(s) reference pruned or missing workflow events; durable receipts remain authoritative.`,
    repairability: 'operator',
  }))

  const routeDelegationMissing = lifecycleMissingByPredicate(db, 'delegation_progress_route_receipts', 'dedupe_key', row => row.idempotency_key && !delegationKeys.has(String(row.idempotency_key)))
  checks.push(lifecycleReferenceCheck({
    name: 'progress_route_receipt_delegation_refs',
    missing: routeDelegationMissing,
    missingStatus: 'warn',
    okSummary: 'Delegation progress route receipts reference existing delegation receipts when delegation IDs are present.',
    missingSummary: `${routeDelegationMissing.length} route receipt(s) reference missing delegation receipts.`,
    repairability: 'operator',
  }))

  const routeProgressMissing = lifecycleMissingByPredicate(db, 'delegation_progress_route_receipts', 'dedupe_key', row => row.progress_key && !progressKeys.has(String(row.progress_key)))
  checks.push(lifecycleReferenceCheck({
    name: 'progress_route_receipt_progress_refs',
    missing: routeProgressMissing,
    missingStatus: 'warn',
    okSummary: 'Delegation progress route receipts reference existing progress receipts when progress IDs are present.',
    missingSummary: `${routeProgressMissing.length} route receipt(s) reference missing progress receipts.`,
    repairability: 'operator',
  }))

  const routeEventMissing = lifecycleMissingByPredicate(db, 'delegation_progress_route_receipts', 'dedupe_key', row => {
    const progressEventMissing = row.progress_event_id !== null && row.progress_event_id !== undefined && !eventIds.has(Number(row.progress_event_id))
    const lastEventMissing = row.last_event_id !== null && row.last_event_id !== undefined && !eventIds.has(Number(row.last_event_id))
    return progressEventMissing || lastEventMissing
  })
  checks.push(lifecycleReferenceCheck({
    name: 'progress_route_receipt_event_refs',
    missing: routeEventMissing,
    missingStatus: 'warn',
    okSummary: 'Delegation route receipts either have no event references or point at retained workflow events.',
    missingSummary: `${routeEventMissing.length} route receipt(s) reference pruned or missing workflow events; route receipts remain authoritative for delivery state.`,
    repairability: 'operator',
  }))

  const dispatchTaskMissing = lifecycleMissingRows(db, `
    SELECT id
    FROM task_dispatch_receipts
    WHERE task_id NOT IN (SELECT id FROM tasks)
  `)
  checks.push(lifecycleReferenceCheck({
    name: 'dispatch_receipt_task_refs',
    missing: dispatchTaskMissing,
    missingStatus: 'fail',
    okSummary: 'Task dispatch receipts reference existing task rows.',
    missingSummary: `${dispatchTaskMissing.length} dispatch receipt(s) reference missing tasks.`,
    repairability: 'restore_required',
  }))

  const wakeupRefsMissing = lifecycleMissingByPredicate(db, 'supervisor_wakeup_receipts', 'id', row => !roadmapIds.has(String(row.roadmap_id || '')))
  checks.push(lifecycleReferenceCheck({
    name: 'wakeup_receipt_roadmap_refs',
    missing: wakeupRefsMissing,
    missingStatus: 'warn',
    okSummary: 'Supervisor wakeup receipts reference existing roadmaps.',
    missingSummary: `${wakeupRefsMissing.length} wakeup receipt(s) reference missing roadmaps.`,
    repairability: 'operator',
  }))

  return checks
}
function lifecycleAuditLedgerChecks(db: DatabaseSync): StorageLifecycleCheck[] {
  if (!sqliteTableExists(db, 'audit_ledger')) {
    return [{
      name: 'audit_ledger_table',
      status: 'fail',
      summary: 'Audit ledger table is missing.',
      repairability: 'restore_required',
    }]
  }
  const checks: StorageLifecycleCheck[] = []
  const sourceEventRefs = lifecycleMissingRows(db, `
    SELECT event_id AS id
    FROM audit_ledger
    WHERE source_event_id IS NOT NULL AND source_event_id NOT IN (SELECT id FROM events)
  `)
  checks.push(lifecycleReferenceCheck({
    name: 'audit_ledger_source_event_refs',
    missing: sourceEventRefs,
    missingStatus: 'warn',
    okSummary: 'Audit ledger source event references point at retained workflow events when present.',
    missingSummary: `${sourceEventRefs.length} audit ledger row(s) reference pruned or missing source workflow events; audit rows remain authoritative.`,
    repairability: 'operator',
  }))

  const rows = db.prepare('SELECT * FROM audit_ledger ORDER BY id ASC').all() as any[]
  const brokenChain: string[] = []
  const badHashes: string[] = []
  const malformedRows: string[] = []
  // Retention prunes the ledger from the oldest end and records the entry hash
  // of the newest pruned row as an anchor; the retained suffix chains from it.
  let previousHash = lifecycleAuditLedgerRetentionAnchor(db)
  for (const row of rows) {
    const eventId = fingerprintId(row.event_id || row.id)
    if ((previousHash || null) !== (row.previous_hash || null)) brokenChain.push(eventId)
    try {
      const expected = auditLedgerEntryHash(lifecycleAuditLedgerRecordWithoutHash(row))
      if (expected !== String(row.entry_hash || '')) badHashes.push(eventId)
    } catch {
      malformedRows.push(eventId)
    }
    previousHash = String(row.entry_hash || '')
  }
  checks.push({
    name: 'audit_ledger_hash_chain',
    status: brokenChain.length ? 'fail' : 'pass',
    summary: brokenChain.length ? `${brokenChain.length} audit ledger row(s) have a broken previous-hash chain.` : 'Audit ledger previous-hash chain is contiguous.',
    repairability: brokenChain.length ? 'restore_required' : 'none',
    ...(brokenChain.length ? { details: { count: brokenChain.length, sample: brokenChain.slice(0, 8) } } : {}),
  })
  checks.push({
    name: 'audit_ledger_entry_hashes',
    status: badHashes.length || malformedRows.length ? 'fail' : 'pass',
    summary: badHashes.length || malformedRows.length
      ? `${badHashes.length + malformedRows.length} audit ledger row(s) failed entry-hash verification.`
      : 'Audit ledger entry hashes verify against redacted payload records.',
    repairability: badHashes.length || malformedRows.length ? 'restore_required' : 'none',
    ...(badHashes.length || malformedRows.length ? { details: { badHashCount: badHashes.length, malformedCount: malformedRows.length, sample: [...badHashes, ...malformedRows].slice(0, 8) } } : {}),
  })
  return checks
}
function lifecycleAuditLedgerRetentionAnchor(db: DatabaseSync): string | undefined {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'auditLedgerRetentionAnchorHash'").get() as any
    return row?.value ? String(row.value) : undefined
  } catch {
    return undefined
  }
}
function lifecycleReferenceCheck(input: {
  name: string
  missing: string[]
  missingStatus: StorageLifecycleStatus
  okSummary: string
  missingSummary: string
  repairability: StorageLifecycleCheck['repairability']
}): StorageLifecycleCheck {
  return {
    name: input.name,
    status: input.missing.length ? input.missingStatus : 'pass',
    summary: input.missing.length ? input.missingSummary : input.okSummary,
    repairability: input.missing.length ? input.repairability : 'none',
    ...(input.missing.length ? { details: { count: input.missing.length, sample: input.missing.slice(0, 8) } } : {}),
  }
}
function lifecycleClassStatus(retentionClass: StorageLifecycleClass['retentionClass'], checks: StorageLifecycleCheck[]): StorageLifecycleStatus {
  const relevant = checks.filter(check => {
    if (retentionClass === 'durable_receipt') return check.name.includes('receipt') || check.name.startsWith('dispatch_') || check.name.startsWith('wakeup_')
    if (retentionClass === 'bounded_event') return check.name.startsWith('event_') || check.name === 'compaction_dry_run'
    if (retentionClass === 'audit_ledger') return check.name.startsWith('audit_ledger')
    if (retentionClass === 'authoritative_state') return check.name.startsWith('gateway_db') || check.name === 'lifecycle_audit_scan'
    return false
  })
  return lifecycleStatus(relevant)
}
function lifecycleStatus(checks: StorageLifecycleCheck[]): StorageLifecycleStatus {
  if (checks.some(check => check.status === 'fail')) return 'fail'
  if (checks.some(check => check.status === 'warn')) return 'warn'
  return 'pass'
}
function lifecycleRepairAction(check: StorageLifecycleCheck): string {
  if (check.repairability === 'restore_required') return 'Stop mutation paths, preserve the current database for inspection, and restore from the latest verified backup before using this state as release evidence.'
  if (check.repairability === 'operator') return 'Keep durable receipts/read models authoritative, then repair or refresh the affected references during a quiet maintenance window before exporting release evidence.'
  if (check.repairability === 'automatic') return 'Run the documented owner repair flow, then rerun the lifecycle audit and storage doctor.'
  return 'No repair required.'
}
function emptyLifecycleCompaction(generatedAt: string): StorageLifecycleCompactionDryRun {
  return {
    mode: 'dry_run',
    mutates: false,
    cutoff: new Date(Date.parse(generatedAt) - WORK_EVENT_RETENTION_MS).toISOString(),
    maxEventRows: MAX_WORK_EVENT_ROWS,
    durableEventTypes: [...DURABLE_WORK_EVENT_TYPES],
    totalEvents: 0,
    durableEvents: 0,
    prunableEvents: 0,
    affectedTypes: [],
  }
}
function storageLifecycleDurableEventSql(): string {
  return `(${DURABLE_WORK_EVENT_TYPES.map(type => `'${type.replace(/'/g, "''")}'`).join(', ')})`
}
function storageLifecycleAuditId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  return `storage-lifecycle-${stamp}`
}
function storageLifecycleUnsupportedClaims(): string[] {
  return [
    'hosted durable state lifecycle certification',
    'multi-tenant retention or legal-hold compliance',
    'managed backup/restore service',
    'arbitrary-scale event retention guarantees',
    'automatic repair of corrupted authoritative state',
    'production data-retention compliance claim',
  ]
}
function lifecycleStringRows(db: DatabaseSync, table: string, column: string): string[] {
  if (!sqliteTableExists(db, table)) return []
  return queryRows(db, `SELECT ${column} AS value FROM ${table}`)
    .map(row => String(row['value'] || ''))
    .filter(Boolean)
}
function lifecycleNumberRows(db: DatabaseSync, table: string, column: string): number[] {
  if (!sqliteTableExists(db, table)) return []
  return queryRows(db, `SELECT ${column} AS value FROM ${table}`)
    .map(row => Number(row['value']))
    .filter(Number.isInteger)
}
function lifecycleMissingRows(db: DatabaseSync, sql: string): string[] {
  try {
    return queryRows(db, sql).map(row => fingerprintId(row['id'])).filter(Boolean)
  } catch {
    return []
  }
}
function lifecycleMissingByPredicate(db: DatabaseSync, table: string, idColumn: string, predicate: (row: any) => boolean): string[] {
  if (!sqliteTableExists(db, table)) return []
  return (db.prepare(`SELECT * FROM ${table}`).all() as any[])
    .filter(predicate)
    .map(row => fingerprintId(row[idColumn]))
    .filter(Boolean)
}
function lifecycleAuditLedgerRecordWithoutHash(row: any): Omit<AuditLedgerRecord, 'entryHash'> {
  return {
    id: 0,
    schemaVersion: Number(row.schema_version || 1) as AuditLedgerRecord['schemaVersion'],
    eventId: String(row.event_id || ''),
    sourceEventId: row.source_event_id === null || row.source_event_id === undefined ? undefined : Number(row.source_event_id),
    sourceEventType: row.source_event_type || undefined,
    class: row.class,
    actorKind: row.actor_kind,
    actorRef: String(row.actor_ref || ''),
    resourceKind: row.resource_kind,
    resourceRef: String(row.resource_ref || ''),
    action: String(row.action || ''),
    result: row.result,
    occurredAt: String(row.occurred_at || ''),
    traceId: String(row.trace_id || ''),
    correlationId: row.correlation_id || undefined,
    retentionClass: row.retention_class,
    evidenceRefs: parseJSON<string[]>(row.evidence_refs_json, []),
    redactedPayload: parseJSON<Record<string, unknown>>(row.redacted_payload_json, {}),
    previousHash: row.previous_hash || undefined,
  }
}
function backendConsistencyBackup(backupPath: string | undefined, counts: StorageBackupMetadata['counts'] | undefined): BackendConsistencyProof['backup'] {
  if (!backupPath) return { status: 'missing', checksumPresent: false, freshness: 'unknown', errors: [] }
  const verification = verifyStorageBackup(backupPath)
  if (!verification.ok) {
    return {
      status: 'failed',
      id: verification.metadata?.id,
      checksumPresent: Boolean(verification.metadata?.checksum),
      freshness: 'unknown',
      errors: verification.errors,
    }
  }
  const countFreshness = counts && verification.metadata?.counts
    ? countsMatchBackup(counts, verification.metadata.counts) ? 'current_counts_match' : 'stale_counts_differ'
    : 'unknown'
  return {
    status: 'verified',
    id: verification.metadata?.id,
    checksumPresent: Boolean(verification.metadata?.checksum),
    freshness: countFreshness,
    errors: [],
  }
}
function backendRuntimePosture(_backend: StorageBackendPosture, status: StorageDoctorStatus): BackendConsistencyRuntimePosture {
  if (status !== 'ok') return 'degraded_backend'
  return 'supported_local_sqlite'
}
function backendConsistencyBlockedStates(
  issues: StorageDoctorIssue[],
  backup: BackendConsistencyProof['backup'],
): BackendConsistencyBlockedState[] {
  const rows = issues
    .filter(issue => issue.severity !== 'info')
    .map(issue => ({
      code: issue.code,
      severity: issue.severity,
      summary: issue.summary,
      remediation: issue.remediation,
    }))
  if (backup.status === 'missing') {
    rows.push({
      code: 'verified_backup_missing',
      severity: 'warning',
      summary: 'No verified backup is available for rollback proof.',
      remediation: 'Create and verify a fresh backup before rollback or cutover evidence.',
    })
  }
  if (backup.status === 'failed') {
    rows.push({
      code: 'backup_verification_failed',
      severity: 'critical',
      summary: 'Selected backup failed verification.',
      remediation: 'Create a fresh backup after fixing storage doctor or metadata errors.',
    })
  }
  return rows.slice(0, 50)
}
function latestRecoveryDrillSummary(stateDir: string): BackendConsistencyProof['rollback']['latestRecoveryDrill'] | undefined {
  const dir = path.join(stateDir, 'recovery-drills')
  if (!fs.existsSync(dir)) return undefined
  const summaries = fs.readdirSync(dir)
    .map(name => summarizeRecoveryDrillEvidence(path.join(dir, name)))
    .filter((summary): summary is StorageRecoveryDrillSummary => Boolean(summary))
    .sort((a, b) => Date.parse(b.completedAt || b.startedAt) - Date.parse(a.completedAt || a.startedAt))
  const latest = summaries[0]
  return latest ? { id: latest.id, status: latest.status, failedChecks: latest.checks.failed } : undefined
}
function coalesceStorageIssues(issues: StorageDoctorIssue[]): StorageDoctorIssue[] {
  const grouped = new Map<string, StorageDoctorIssue & { evidence?: Record<string, unknown> }>()
  for (const issue of issues) {
    const key = `${issue.severity}:${issue.code}:${issue.sourceId}:${issue.summary}`
    const existing = grouped.get(key)
    if (!existing) {
      grouped.set(key, issue)
      continue
    }
    const count = Number(existing.evidence?.['count'] || 1) + Number(issue.evidence?.['count'] || 1)
    existing.evidence = {
      ...(existing.evidence || {}),
      count,
      samples: uniqueStrings([
        ...asStringArray(existing.evidence?.['sample']),
        ...asStringArray(existing.evidence?.['samples']),
        ...asStringArray(issue.evidence?.['sample']),
        ...asStringArray(issue.evidence?.['samples']),
      ]).slice(0, 8),
    }
  }
  return [...grouped.values()]
}
export function sanitizeStorageDoctorForMigrationEvidence(report: StorageDoctorReport): StorageDoctorReport {
  return {
    ...report,
    issues: report.issues.map(issue => ({
      ...issue,
      ...(issue.evidence ? { evidence: sanitizeMigrationEvidenceRecord(issue.evidence) } : {}),
    })),
  }
}
function sanitizeMigrationEvidenceRecord(evidence: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(evidence)) {
    if (key === 'mismatches' && Array.isArray(value)) {
      sanitized['mismatchCount'] = value.length
      continue
    }
    sanitized[key] = value
  }
  return sanitized
}
