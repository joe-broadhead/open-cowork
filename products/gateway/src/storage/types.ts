import type { GatewayConfig } from '../config.js'
import type { WorkStoreMutationEntryPoint, recoverExpiredWorkLeases, recoverOrphanedWorkRuns } from '../work-store.js'

export type StorageSourceKind = 'authoritative_sqlite' | 'transactional_sqlite' | 'derived_cache' | 'append_only_evidence' | 'operator_artifact'
export type StorageDoctorSeverity = 'info' | 'warning' | 'critical'
export type StorageDoctorStatus = 'ok' | 'degraded' | 'down'
export type StorageBackendMode = 'local_sqlite'

export interface BackendActivationBlocker {
  severity: StorageDoctorSeverity
  code: string
  summary: string
  remediation: string
  evidence?: Record<string, unknown>
}

export interface BackendActivationReadiness {
  mode: 'backend_activation'
  status: 'local_sqlite_default'
  runtimeBackend: StorageBackendMode
  supportedDefault: 'local_sqlite'
  effectivePersistence: 'local_sqlite'
  currentReleaseClaim: 'local_sqlite_public_beta'
  cutoverReadiness: 'not_selectable'
  rollbackReadiness: 'drill_available_requires_verified_backup'
  consistencyScan: 'storage_doctor_available'
  requiredProofs: string[]
  supportedCommands: Array<{ id: string; command: string; purpose: string; safeByDefault: boolean }>
  blockers: BackendActivationBlocker[]
  unsupportedModes: string[]
  evidencePolicy: {
    redacted: true
    allowed: string[]
    forbidden: string[]
  }
}

export interface StorageBackendPosture {
  mode: StorageBackendMode
  releaseStatus: 'supported_public_local_beta'
  transactionalAuthority: 'gateway_db'
  effectivePersistence: 'local_sqlite'
  hostedTeamStatus: 'unsupported_until_m25_decision'
  stateDir: string
  gatewayDb: string
  authoritativeSources: string[]
  sidecarSources: string[]
  activation: BackendActivationReadiness
  caveats: string[]
}

export interface StorageSourceRecord {
  id: string
  label: string
  kind: StorageSourceKind
  path: string
  required: boolean
  backedUp: boolean
  owner: string
  description: string
  remediation: string
  exists: boolean
  size?: number
  updatedAt?: string
}

export interface StorageDoctorIssue {
  severity: StorageDoctorSeverity
  code: string
  sourceId: string
  summary: string
  remediation: string
  evidence?: Record<string, unknown>
}

export interface StorageDoctorReport {
  status: StorageDoctorStatus
  generatedAt: string
  stateDir: string
  backupPath?: string
  backend: StorageBackendPosture
  consistency: BackendConsistencyProof
  lifecycle: StorageLifecycleReport
  summary: string
  sources: StorageSourceRecord[]
  issues: StorageDoctorIssue[]
  counts?: StorageBackupMetadata['counts']
}

export interface StorageDoctorOptions {
  stateDir?: string
  backupPath?: string
  now?: Date | string
  config?: GatewayConfig
  env?: NodeJS.ProcessEnv
}

export interface StorageBackupFile {
  name: string
  size: number
  sha256: string
}

export interface StorageBackupMetadata {
  version: number
  id: string
  createdAt: string
  packageVersion: string
  configHash?: string
  counts: { roadmaps: number; supervisors: number; projectBindings: number; completionProposals: number; tasks: number; runs: number; channelBindings: number; events: number }
  files: StorageBackupFile[]
  checksum: string
}

export interface StorageBackupSummary extends StorageBackupMetadata {
  path: string
  ok?: boolean
  errors?: string[]
}

export interface StorageBackupVerification {
  ok: boolean
  path: string
  metadata?: StorageBackupMetadata
  errors: string[]
}

export type StorageRestoreOptions = { maintenanceMode?: boolean; skipSafetyBackup?: boolean }
export type BackupFileEntryValidation = { ok: true; file: StorageBackupFile } | { ok: false; error: string }


export interface StorageRecoveryDrillCheck {
  name: string
  status: 'pass' | 'fail'
  summary: string
  details?: Record<string, unknown>
}

export interface StorageRecoveryDrillEvidence {
  id: string
  status: 'pass' | 'fail'
  startedAt: string
  completedAt: string
  evidenceDir: string
  evidencePath: string
  reportPath: string
  backup: {
    path: string
    id?: string
    created: boolean
    verification: StorageBackupVerification
  }
  restore?: {
    stateDir: string
    restoredFiles: string[]
    safetyBackup?: string
    counts: StorageBackupMetadata['counts']
  }
  storageDoctor?: StorageDoctorReport
  drill?: {
    expiredLease: ReturnType<typeof recoverExpiredWorkLeases>
    orphanedRun: ReturnType<typeof recoverOrphanedWorkRuns>
    channelBindings: number
    events: string[]
  }
  checks: StorageRecoveryDrillCheck[]
}

export interface StorageRecoveryDrillSummary {
  id: string
  status: StorageRecoveryDrillEvidence['status']
  startedAt: string
  completedAt: string
  path: string
  evidencePath: string
  reportPath: string
  backupPath?: string
  restoredStateDir?: string
  checks: { total: number; passed: number; failed: number }
  error?: string
}


export interface BackendMigrationEvidencePolicy {
  redacted: true
  allowed: string[]
  forbidden: string[]
}

export interface BackendRollbackReceipt {
  id: string
  mode: 'backend_rollback_drill'
  status: 'pass' | 'fail'
  startedAt: string
  completedAt: string
  evidenceDir: string
  evidencePath: string
  reportPath: string
  backup: {
    path: string
    id?: string
    verification: StorageBackupVerification
  }
  restore?: {
    stateDir: string
    restoredFiles: string[]
    counts: StorageBackupMetadata['counts']
  }
  storageDoctor?: StorageDoctorReport
  recoveryDrill?: {
    id: string
    status: StorageRecoveryDrillEvidence['status']
    evidencePath: string
    reportPath: string
    checks: { total: number; passed: number; failed: number }
  }
  checks: StorageRecoveryDrillCheck[]
}

export type BackendConsistencyProofStatus = 'pass' | 'warn' | 'fail'
export type BackendConsistencyRuntimePosture =
  | 'supported_local_sqlite'
  | 'degraded_backend'

export interface BackendConsistencyContract {
  domain: string
  owner: string
  transactionOwner: string
  mutationEntryPoint: WorkStoreMutationEntryPoint
  rollbackGate: 'verified_gateway_db_backup'
  tables: string[]
  operationGroups: string[]
  requiredProofCount: number
  invariantCount: number
}

export interface BackendConsistencyCheck {
  id: string
  domain: string
  status: BackendConsistencyProofStatus
  summary: string
  evidence?: Record<string, unknown>
}

export interface BackendConsistencyBlockedState {
  code: string
  severity: StorageDoctorSeverity
  summary: string
  remediation: string
}

export interface BackendConsistencyProof {
  mode: 'm28_backend_consistency_proof'
  status: BackendConsistencyProofStatus
  generatedAt: string
  runtimePosture: BackendConsistencyRuntimePosture
  runtimeBackend: StorageBackendMode
  effectivePersistence: 'local_sqlite'
  releaseClaim: 'tested_backend_modes_only_no_hosted_or_multi_tenant_storage_claim'
  consistencyScan: {
    status: StorageDoctorStatus
    issueCodes: string[]
    criticalCount: number
    warningCount: number
    scannedDomains: string[]
  }
  backup: {
    status: 'verified' | 'missing' | 'failed'
    id?: string
    checksumPresent: boolean
    freshness: 'current_counts_match' | 'stale_counts_differ' | 'unknown'
    errors: string[]
  }
  rollback: {
    status: 'drill_available' | 'blocked_missing_verified_backup' | 'blocked_failed_backup'
    requiredCommand: string
    latestRecoveryDrill?: { id: string; status: StorageRecoveryDrillEvidence['status']; failedChecks: number }
  }
  readModel: {
    status: BackendConsistencyProofStatus
    checksum?: string
    deterministicAfterRestart: boolean
    counts?: StorageBackupMetadata['counts']
  }
  contracts: BackendConsistencyContract[]
  checks: BackendConsistencyCheck[]
  blockedStates: BackendConsistencyBlockedState[]
  evidencePolicy: BackendMigrationEvidencePolicy
  unsupportedClaims: string[]
}

export interface DurableStateOwnershipRecord {
  id: string
  label: string
  kind: StorageSourceKind
  owner: string
  required: boolean
  backedUp: boolean
  path: string
  description: string
  recovery: string
}

export interface DurableStateConsistencyProof {
  mode: 'durable_state_consistency'
  status: BackendConsistencyProofStatus
  generatedAt: string
  stateDir: string
  releaseClaim: 'local_beta_durable_state_consistency_only_no_hosted_or_managed_storage_claim'
  ownership: {
    totalSources: number
    authoritativeSources: number
    backedUpSources: number
    owners: string[]
    sources: DurableStateOwnershipRecord[]
  }
  scanner: {
    status: StorageDoctorStatus
    criticalCount: number
    warningCount: number
    issueCodes: string[]
    orphanIssueCodes: string[]
    staleBindingIssueCodes: string[]
    outputRedacted: true
  }
  backupRestore: {
    backup: BackendConsistencyProof['backup']
    rollback: BackendConsistencyProof['rollback']
    lifecycle: Pick<StorageLifecycleReport, 'mode' | 'status' | 'releaseClaim'>
  }
  checks: BackendConsistencyCheck[]
  blockedStates: BackendConsistencyBlockedState[]
  safeNextActions: string[]
  unsupportedClaims: string[]
}

export type DurableStateRepairBoundaryKind = 'inspect_only' | 'operator_repair' | 'restore_required' | 'isolated_recovery_drill'

export interface DurableStateIntegrityInventorySource {
  id: string
  owner: string
  kind: StorageSourceKind
  sourceOfTruth: string
  retentionClass: StorageLifecycleClass['retentionClass'] | 'source_artifact'
  required: boolean
  backedUp: boolean
  repairBoundary: DurableStateRepairBoundaryKind
  recovery: string
}

export interface DurableStateIntegrityInventoryClass {
  id: string
  retentionClass: StorageLifecycleClass['retentionClass']
  owner: string
  rows: number
  status: StorageLifecycleStatus
  compactionBehavior: string
  repairBehavior: string
}

export interface DurableStateIntegrityRepairBoundary {
  id: string
  kind: DurableStateRepairBoundaryKind
  owner: string
  command: string
  mutatesLiveState: boolean
  auditEvidence: string
  allowedWhen: string
  forbiddenIn: string[]
}

export interface DurableStateIntegrityFixture {
  id: string
  domain: 'consistency_scan' | 'backup_restore' | 'repair_boundary' | 'read_only_diagnostic'
  status: 'pass' | 'warn' | 'fail'
  expectedIssueCodes: string[]
  detectedIssueCodes: string[]
  mutatesLiveState: boolean
  evidence: Record<string, unknown>
}

export interface DurableStateIntegrityReport {
  mode: 'durable_state_integrity'
  status: BackendConsistencyProofStatus
  generatedAt: string
  stateDir: string
  releaseClaim: 'local_first_durable_state_integrity_only_no_managed_or_self_healing_claim'
  inventory: {
    sources: DurableStateIntegrityInventorySource[]
    classes: DurableStateIntegrityInventoryClass[]
    totalSources: number
    totalClasses: number
    owners: string[]
    requiredSourceCount: number
    backedUpSourceCount: number
  }
  consistencyScan: {
    status: StorageDoctorStatus
    criticalCount: number
    warningCount: number
    detectedIssueCodes: string[]
    representativeFixtures: DurableStateIntegrityFixture[]
    outputRedacted: true
  }
  backupRestore: {
    backup: BackendConsistencyProof['backup']
    rollback: BackendConsistencyProof['rollback']
    verificationErrors: string[]
    refusesUnsafeRestore: boolean
  }
  repairBoundaries: DurableStateIntegrityRepairBoundary[]
  readOnlyDiagnostics: {
    commands: string[]
    mutatesLiveState: false
    implicitRepairAllowed: false
    evidence: {
      doctorStatus: StorageDoctorStatus
      lifecycleCompactionMutates: false
    }
  }
  evidencePolicy: {
    redacted: true
    allowed: string[]
    forbidden: string[]
  }
  residualRisks: string[]
  unsupportedClaims: string[]
}

export type LocalDurableStateAdapterCapabilityId =
  | 'inspect_state'
  | 'verify_backup'
  | 'create_verified_backup'
  | 'restore_verified_backup'
  | 'isolated_recovery_drill'
  | 'operator_repair_receipt'
  | 'hosted_multi_tenant_backend'

export interface LocalDurableStateAdapterCapability {
  id: LocalDurableStateAdapterCapabilityId
  status: 'supported' | 'unsupported'
  readOnly: boolean
  mutatesLiveState: boolean
  requiresExplicitOperatorCall: boolean
  command: string
  evidence: string
  safeByDefault: boolean
  blocker?: string
}

export interface LocalDurableStateAdapterReport {
  mode: 'm49_local_durable_state_adapter'
  status: BackendConsistencyProofStatus
  generatedAt: string
  stateDir: string
  releaseClaim: 'local_durable_state_adapter_only_no_hosted_or_managed_storage_claim'
  adapter: {
    backendMode: 'local_sqlite'
    effectivePersistence: 'local_sqlite'
    capabilities: LocalDurableStateAdapterCapability[]
    unsupportedModes: string[]
  }
  inspect: {
    mutatesLiveState: false
    doctorStatus: StorageDoctorStatus
    criticalCount: number
    warningCount: number
    issueCodes: string[]
    outputRedacted: true
  }
  backupRestore: {
    latestBackup: BackendConsistencyProof['backup']
    rollback: BackendConsistencyProof['rollback']
    roundTripCommand: 'opencode-gateway backend durable-state-round-trip --json'
  }
  repair: {
    implicitRepairAllowed: false
    idempotencyKeyRequired: true
    safetyBackupRequiredForRestore: true
    evidenceDir: string
    supportedOperations: LocalDurableStateRepairOperation[]
  }
  readiness: {
    storageDoctorStatus: StorageDoctorStatus
    adapterStatus: BackendConsistencyProofStatus
    blocksDispatch: boolean
  }
  checks: BackendConsistencyCheck[]
  safeNextActions: string[]
  unsupportedClaims: string[]
}

export type LocalDurableStateRepairOperation =
  | 'create_verified_backup'
  | 'restore_verified_backup'
  | 'record_unsupported_repair_blocker'

export interface LocalDurableStateRepairReceipt {
  mode: 'm49_local_durable_state_repair_receipt'
  idempotencyKey: string
  operation: LocalDurableStateRepairOperation
  status: 'pass' | 'blocked' | 'fail'
  generatedAt: string
  stateDir: string
  evidencePath: string
  explicitOperatorCall: true
  mutatesLiveState: boolean
  issueCodes: string[]
  backup?: {
    id?: string
    path?: string
    verified: boolean
    errors: string[]
  }
  restore?: {
    restoredFiles: number
    safetyBackup?: string
  }
  actions: string[]
  blockers: BackendConsistencyBlockedState[]
  checks: BackendConsistencyCheck[]
  unsupportedClaims: string[]
}

export interface LocalDurableStateBackupRoundTripEvidence {
  mode: 'm49_local_durable_state_backup_round_trip'
  status: BackendConsistencyProofStatus
  generatedAt: string
  stateDir: string
  backup: {
    id: string
    path: string
    verification: StorageBackupVerification
  }
  recoveryDrill?: {
    id: string
    status: StorageRecoveryDrillEvidence['status']
    evidencePath: string
    failedChecks: number
  }
  checks: BackendConsistencyCheck[]
  unsupportedClaims: string[]
}

export type StorageLifecycleStatus = 'pass' | 'warn' | 'fail'

export interface StorageLifecycleCheck {
  name: string
  status: StorageLifecycleStatus
  summary: string
  repairability: 'none' | 'automatic' | 'operator' | 'restore_required'
  details?: Record<string, unknown>
}

export interface StorageLifecycleClass {
  id: string
  retentionClass: 'authoritative_state' | 'durable_receipt' | 'bounded_event' | 'audit_ledger' | 'derived_sidecar' | 'backup_artifact'
  rows: number
  status: StorageLifecycleStatus
  compactionBehavior: string
  repairBehavior: string
}

export interface StorageLifecycleCompactionDryRun {
  mode: 'dry_run'
  mutates: false
  cutoff: string
  maxEventRows: number
  durableEventTypes: string[]
  totalEvents: number
  durableEvents: number
  prunableEvents: number
  affectedTypes: Array<{ type: string; rows: number; olderThanRetention: number; outsideRowCap: number; firstEventId?: number; lastEventId?: number; oldestCreatedAt?: string; newestCreatedAt?: string }>
}

export interface StorageLifecycleReport {
  id: string
  mode: 'm34_durable_state_lifecycle_audit'
  status: StorageLifecycleStatus
  generatedAt: string
  stateDir: string
  releaseClaim: 'local_beta_lifecycle_audit_only_no_hosted_or_compliance_retention_claim'
  classes: StorageLifecycleClass[]
  compaction: StorageLifecycleCompactionDryRun
  checks: StorageLifecycleCheck[]
  repairPlan: Array<{ code: string; severity: StorageLifecycleStatus; action: string; evidence?: Record<string, unknown> }>
  unsupportedClaims: string[]
}

export interface StorageSourceSpec {
  id: string
  label: string
  kind: StorageSourceKind
  rawPath: string
  fileName?: string
  directory?: boolean
  json?: boolean
  required: boolean
  backedUp: boolean
  owner: string
  description: string
  remediation: string
}
