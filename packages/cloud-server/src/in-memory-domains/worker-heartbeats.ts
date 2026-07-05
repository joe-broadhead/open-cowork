import { clone, nowIso } from './store-helpers.ts'
import type { WorkerHeartbeatRecord, WorkerRole } from '../control-plane-store.ts'

// Worker-heartbeat log extracted from in-memory-control-plane-store.ts. Owns the
// per-worker last-seen heartbeat records (record overwrites by workerId, list
// returns all). No host — no cross-domain dependencies. Behaviour-preserving;
// covered by the cloud-control-plane-store / scheduler-reaper suites.

export class InMemoryWorkerHeartbeatsDomain {
  private readonly heartbeats = new Map<string, WorkerHeartbeatRecord>()

  recordWorkerHeartbeat(input: {
    workerId: string
    role: WorkerRole
    activeSessionIds?: string[]
    now?: Date
  }): WorkerHeartbeatRecord {
    const record: WorkerHeartbeatRecord = {
      workerId: input.workerId,
      role: input.role,
      activeSessionIds: [...new Set(input.activeSessionIds || [])],
      lastSeenAt: nowIso(input.now),
    }
    this.heartbeats.set(input.workerId, record)
    return clone(record)
  }

  listWorkerHeartbeats(): WorkerHeartbeatRecord[] {
    return Array.from(this.heartbeats.values()).map((record) => clone(record))
  }
}
