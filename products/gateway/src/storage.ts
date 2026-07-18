// Facade for the storage domain. The implementation is decomposed into
// layered submodules under ./storage/ (types -> internal -> backup/restore ->
// doctor -> integrity/drills). This module re-exports the public storage API so
// existing importers keep a single stable entry point.

export {
  CURRENT_BACKUP_VERSION,
  storageStateDir,
  storageRecoveryDrillDir,
  storageBackendDrillDir,
  listStorageSources,
} from './storage/internal.js'

export {
  createStorageBackup,
  listStorageBackups,
  verifyStorageBackup,
  exportGatewayState,
  describeStorageBackend,
} from './storage/backup.js'

export { restoreStorageBackup } from './storage/restore.js'

export {
  runStorageDoctor,
  runStorageLifecycleAudit,
} from './storage/doctor.js'

export {
  listStorageRecoveryDrills,
  runStorageRecoveryDrill,
  runBackendRollbackDrill,
} from './storage/drills.js'

export {
  buildBackendConsistencyProof,
  buildDurableStateConsistencyProof,
  buildDurableStateIntegrityReport,
  buildLocalDurableStateAdapterReport,
  runLocalDurableStateRepair,
  validateLocalDurableStateBackupRoundTrip,
} from './storage/integrity.js'

export type {
  StorageSourceKind,
  StorageDoctorSeverity,
  StorageDoctorStatus,
  StorageBackendMode,
  BackendActivationBlocker,
  BackendActivationReadiness,
  StorageBackendPosture,
  StorageSourceRecord,
  StorageDoctorIssue,
  StorageDoctorReport,
  StorageDoctorOptions,
  StorageBackupFile,
  StorageBackupMetadata,
  StorageBackupSummary,
  StorageBackupVerification,
  StorageRecoveryDrillCheck,
  StorageRecoveryDrillEvidence,
  StorageRecoveryDrillSummary,
  BackendMigrationEvidencePolicy,
  BackendRollbackReceipt,
  BackendConsistencyProofStatus,
  BackendConsistencyRuntimePosture,
  BackendConsistencyContract,
  BackendConsistencyCheck,
  BackendConsistencyBlockedState,
  BackendConsistencyProof,
  DurableStateOwnershipRecord,
  DurableStateConsistencyProof,
  DurableStateRepairBoundaryKind,
  DurableStateIntegrityInventorySource,
  DurableStateIntegrityInventoryClass,
  DurableStateIntegrityRepairBoundary,
  DurableStateIntegrityFixture,
  DurableStateIntegrityReport,
  LocalDurableStateAdapterCapabilityId,
  LocalDurableStateAdapterCapability,
  LocalDurableStateAdapterReport,
  LocalDurableStateRepairOperation,
  LocalDurableStateRepairReceipt,
  LocalDurableStateBackupRoundTripEvidence,
  StorageLifecycleStatus,
  StorageLifecycleCheck,
  StorageLifecycleClass,
  StorageLifecycleCompactionDryRun,
  StorageLifecycleReport,
} from './storage/types.js'
