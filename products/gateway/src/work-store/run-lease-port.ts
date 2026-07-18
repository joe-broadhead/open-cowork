import type { EnvironmentRunRecord } from '../environments.js'
import {
  adoptActiveWorkRunLeases,
  attachTaskDispatchEnvironment,
  countActiveTaskDispatchStarts,
  listTaskDispatchReceipts,
  recoverExpiredTaskDispatchStarts,
  markTaskDispatchFailed,
  markTaskDispatchPromptSubmitted,
  markTaskDispatchStarted,
  recoverExpiredWorkLeases,
  recoverOrphanedWorkRun,
  renewWorkTaskRunLease,
  reserveTaskDispatchStart,
  startWorkTaskRun,
  startWorkTaskRunFromDispatch,
  summarizeWorkLeases,
  type RunResolutionInput,
  type TaskDispatchReceiptRecord,
  type TaskDispatchReceiptStatus,
  type WorkLeaseSummary,
  type WorkState,
  type WorkTaskRunStartResult,
} from '../work-store.js'

export type WorkStoreRunLeaseOperationGroup =
  | 'reserve_dispatch_start'
  | 'start_run'
  | 'renew_run_lease'
  | 'recover_expired_dispatch_starts'
  | 'recover_expired_or_orphaned_runs'

export interface WorkStoreRunLeasePortDomain {
  id: 'runs_leases'
  backendMode: 'local_sqlite'
  releaseStatus: 'supported_public_local_beta'
  operationGroups: WorkStoreRunLeaseOperationGroup[]
}

export interface WorkStoreRunLeasePort {
  readonly domain: WorkStoreRunLeasePortDomain
  reserveDispatchStart(input: { taskId: string; stage: string; profile?: string; leaseOwner?: string; leaseMs?: number; idempotencyKey?: string; now?: number }): TaskDispatchReceiptRecord | undefined
  attachDispatchEnvironment(dispatchId: string, environment: EnvironmentRunRecord): TaskDispatchReceiptRecord | undefined
  markDispatchStarted(dispatchId: string, input: { runId: string; sessionId: string }): TaskDispatchReceiptRecord | undefined
  markDispatchPromptSubmitted(dispatchId: string): TaskDispatchReceiptRecord | undefined
  markDispatchFailed(dispatchId: string | undefined, reason: string): TaskDispatchReceiptRecord | undefined
  countActiveDispatchStarts(filter?: { stage?: string; profile?: string }, now?: number): number
  listDispatchReceipts(filter?: { taskId?: string; status?: TaskDispatchReceiptStatus; stage?: string; profile?: string }): TaskDispatchReceiptRecord[]
  recoverExpiredDispatchStarts(now?: number): { recovered: number; dispatchIds: string[] }
  startRun(id: string, stage: string, sessionId: string, profile: string, lease?: { owner?: string; leaseMs?: number; generation?: string }, resolution?: RunResolutionInput): WorkTaskRunStartResult | undefined
  startRunFromDispatch(dispatchId: string, id: string, stage: string, sessionId: string, profile: string, lease?: { owner?: string; leaseMs?: number; generation?: string }, resolution?: RunResolutionInput): WorkTaskRunStartResult | undefined
  renewRunLease(runId: string, lease?: { owner?: string; leaseMs?: number; generation?: string }): boolean
  adoptActiveRunLeases(lease: { owner: string; generation: string; leaseMs?: number; now?: number }): { adopted: number; runIds: string[] }
  recoverExpiredLeases(retryLimit: number, now?: number): { recovered: number; blocked: number; runIds: string[] }
  recoverOneOrphanedRun(runId: string, retryLimit: number, now?: number): { recovered: number; blocked: number; runIds: string[] }
  summarizeLeases(state: WorkState, now?: number): WorkLeaseSummary
}

export const WORK_STORE_RUN_LEASE_PORT_DOMAIN: WorkStoreRunLeasePortDomain = {
  id: 'runs_leases',
  backendMode: 'local_sqlite',
  releaseStatus: 'supported_public_local_beta',
  operationGroups: ['reserve_dispatch_start', 'start_run', 'renew_run_lease', 'recover_expired_dispatch_starts', 'recover_expired_or_orphaned_runs'],
}

export function createSqliteWorkStoreRunLeasePort(options: { filePath?: string } = {}): WorkStoreRunLeasePort {
  const filePath = options.filePath
  return {
    domain: {
      ...WORK_STORE_RUN_LEASE_PORT_DOMAIN,
      operationGroups: [...WORK_STORE_RUN_LEASE_PORT_DOMAIN.operationGroups],
    },
    reserveDispatchStart(input) {
      return reserveTaskDispatchStart(input, filePath)
    },
    attachDispatchEnvironment(dispatchId, environment) {
      return attachTaskDispatchEnvironment(dispatchId, environment, filePath)
    },
    markDispatchStarted(dispatchId, input) {
      return markTaskDispatchStarted(dispatchId, input, filePath)
    },
    markDispatchPromptSubmitted(dispatchId) {
      return markTaskDispatchPromptSubmitted(dispatchId, filePath)
    },
    markDispatchFailed(dispatchId, reason) {
      return markTaskDispatchFailed(dispatchId, reason, filePath)
    },
    countActiveDispatchStarts(filter = {}, now = Date.now()) {
      return countActiveTaskDispatchStarts(filter, filePath, now)
    },
    listDispatchReceipts(filter = {}) {
      return listTaskDispatchReceipts(filter, filePath)
    },
    recoverExpiredDispatchStarts(now = Date.now()) {
      return recoverExpiredTaskDispatchStarts(filePath, now)
    },
    startRun(id, stage, sessionId, profile, lease = {}, resolution = {}) {
      return startWorkTaskRun(id, stage, sessionId, profile, filePath, lease, resolution)
    },
    startRunFromDispatch(dispatchId, id, stage, sessionId, profile, lease = {}, resolution = {}) {
      return startWorkTaskRunFromDispatch(dispatchId, id, stage, sessionId, profile, filePath, lease, resolution)
    },
    renewRunLease(runId, lease = {}) {
      return renewWorkTaskRunLease(runId, lease, filePath)
    },
    adoptActiveRunLeases(lease) {
      return adoptActiveWorkRunLeases(lease, filePath)
    },
    recoverExpiredLeases(retryLimit, now = Date.now()) {
      return recoverExpiredWorkLeases(retryLimit, filePath, now)
    },
    recoverOneOrphanedRun(runId, retryLimit, now = Date.now()) {
      return recoverOrphanedWorkRun(runId, retryLimit, filePath, now)
    },
    summarizeLeases(state, now = Date.now()) {
      return summarizeWorkLeases(state, now)
    },
  }
}
