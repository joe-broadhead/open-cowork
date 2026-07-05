import {
  clone,
  key,
} from './store-helpers.ts'
import type { CoordinationWatch } from '@open-cowork/shared'
import type {
  CreateCloudCoordinationWatchInput,
  ListCloudCoordinationWatchesInput,
  ListMatchingCloudCoordinationWatchesInput,
  UpdateCloudCoordinationWatchInput,
} from '../in-memory-control-plane-store.ts'
import {
  cloudCoordinationWatchMatchesEvent,
  createCloudCoordinationWatchRecord,
  normalizeCloudCoordinationWatchLimit,
  updateCloudCoordinationWatchRecord,
} from '../coordination-watch-records.ts'

export class InMemoryCoordinationWatchesDomain {
  private readonly watches = new Map<string, CoordinationWatch>()

  create(input: CreateCloudCoordinationWatchInput): CoordinationWatch {
    const watch = createCloudCoordinationWatchRecord(input)
    this.watches.set(key(watch.workspaceId, watch.id), clone(watch))
    return clone(watch)
  }

  update(input: UpdateCloudCoordinationWatchInput): CoordinationWatch | null {
    const current = this.watches.get(key(input.workspaceId, input.watchId))
    if (!current) return null
    const watch = updateCloudCoordinationWatchRecord(current, input.patch, input.updatedAt)
    this.watches.set(key(watch.workspaceId, watch.id), clone(watch))
    return clone(watch)
  }

  get(workspaceId: string, watchId: string): CoordinationWatch | null {
    return clone(this.watches.get(key(workspaceId, watchId)) || null)
  }

  list(input: ListCloudCoordinationWatchesInput): CoordinationWatch[] {
    const limit = normalizeCloudCoordinationWatchLimit(input.limit)
    return [...this.watches.values()]
      .filter((watch) => watch.workspaceId === input.workspaceId)
      .filter((watch) => !input.status || watch.status === input.status)
      .filter((watch) => !input.target || (watch.target.kind === input.target.kind && watch.target.id === input.target.id))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit)
      .map(clone)
  }

  listMatching(input: ListMatchingCloudCoordinationWatchesInput): CoordinationWatch[] {
    const matches = [...this.watches.values()]
      .filter((watch) => cloudCoordinationWatchMatchesEvent(watch, input))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    const limited = input.limit ? matches.slice(0, normalizeCloudCoordinationWatchLimit(input.limit, 1000, 10_000)) : matches
    return limited.map(clone)
  }

  delete(workspaceId: string, watchId: string): boolean {
    return this.watches.delete(key(workspaceId, watchId))
  }
}
