// Facade for the storage domain. The implementation is decomposed into
// layered submodules under ./storage/ (types -> internal -> backup/restore ->
// doctor -> integrity/drills). This module re-exports the public storage API so
// existing importers keep a single stable entry point.

export {
  storageStateDir,
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
  StorageBackupSummary,
  StorageRecoveryDrillSummary,
} from './storage/types.js'
