import { clone, key, normalizeOptionalText, normalizeText, nowIso, stableJson } from './store-helpers.ts'
import type {
  CreateThreadSmartFilterInput,
  ThreadSmartFilterRecord,
  UpdateThreadSmartFilterInput,
} from '../control-plane-store.ts'

// Thread smart-filter domain extracted from in-memory-control-plane-store.ts. Owns
// the saved smart-filter records and their create (idempotent, reuse-guarded) /
// list / update / delete lifecycle. Tenant validation arrives via the injected
// host; no cross-domain reads. Behaviour-preserving; covered by the
// cloud-control-plane-store thread suite.

const THREAD_SMART_FILTER_NAME_MAX_LENGTH = 64
const SMART_FILTER_QUERY_MAX_BYTES = 16_384

type InMemorySmartFiltersHost = {
  requireTenant(tenantId: string): void
}

export class InMemorySmartFiltersDomain {
  private readonly threadSmartFilters = new Map<string, ThreadSmartFilterRecord>()
  private readonly host: InMemorySmartFiltersHost

  constructor(host: InMemorySmartFiltersHost) {
    this.host = host
  }

  listThreadSmartFilters(tenantId: string): ThreadSmartFilterRecord[] {
    this.host.requireTenant(tenantId)
    return Array.from(this.threadSmartFilters.values())
      .filter((filter) => filter.tenantId === tenantId)
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
      .map((filter) => clone(filter))
  }

  createThreadSmartFilter(input: CreateThreadSmartFilterInput): ThreadSmartFilterRecord {
    this.host.requireTenant(input.tenantId)
    const filterKey = key(input.tenantId, input.filterId)
    const name = normalizeText(input.name, THREAD_SMART_FILTER_NAME_MAX_LENGTH, 'Smart filter name')
    const query = normalizeThreadQuery(input.query)
    const existing = this.threadSmartFilters.get(filterKey)
    if (existing) {
      if (existing.name !== name || stableJson(existing.query) !== stableJson(query)) {
        throw new Error(`Smart filter id ${input.filterId} was reused with different content.`)
      }
      return clone(existing)
    }
    const createdAt = nowIso(input.createdAt)
    const record: ThreadSmartFilterRecord = {
      tenantId: input.tenantId,
      filterId: input.filterId,
      name,
      query,
      createdAt,
      updatedAt: createdAt,
    }
    this.threadSmartFilters.set(filterKey, record)
    return clone(record)
  }

  updateThreadSmartFilter(input: UpdateThreadSmartFilterInput): ThreadSmartFilterRecord | null {
    this.host.requireTenant(input.tenantId)
    const filter = this.threadSmartFilters.get(key(input.tenantId, input.filterId))
    if (!filter) return null
    filter.name = normalizeOptionalText(input.name, THREAD_SMART_FILTER_NAME_MAX_LENGTH, 'Smart filter name') ?? filter.name
    if (input.query !== undefined) filter.query = normalizeThreadQuery(input.query)
    filter.updatedAt = nowIso(input.updatedAt)
    return clone(filter)
  }

  deleteThreadSmartFilter(tenantId: string, filterId: string): boolean {
    this.host.requireTenant(tenantId)
    return this.threadSmartFilters.delete(key(tenantId, filterId))
  }
}

function normalizeThreadQuery(value: unknown) {
  const query = value && typeof value === 'object' && !Array.isArray(value)
    ? clone(value as Record<string, unknown>)
    : {}
  const serialized = stableJson(query)
  if (Buffer.byteLength(serialized, 'utf8') > SMART_FILTER_QUERY_MAX_BYTES) {
    throw new Error(`Smart filter query exceeds ${SMART_FILTER_QUERY_MAX_BYTES} bytes.`)
  }
  return query
}
