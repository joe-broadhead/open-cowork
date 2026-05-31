import type { ControlPlaneStore } from '../control-plane-store.ts'

export type ManagedWorkersControlPlaneStore = Pick<ControlPlaneStore,
  | 'createManagedWorkerPool'
  | 'updateManagedWorkerPool'
  | 'getManagedWorkerPool'
  | 'listManagedWorkerPools'
  | 'registerManagedWorker'
  | 'updateManagedWorkerStatus'
  | 'getManagedWorker'
  | 'listManagedWorkers'
  | 'issueManagedWorkerCredential'
  | 'listManagedWorkerCredentials'
  | 'findManagedWorkerCredentialByPlaintext'
  | 'revokeManagedWorkerCredential'
  | 'recordManagedWorkerHeartbeat'
  | 'listManagedWorkerHeartbeats'
  | 'recordAuditEvent'
>
