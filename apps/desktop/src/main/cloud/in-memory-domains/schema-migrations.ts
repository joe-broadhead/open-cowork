import { clone } from './store-helpers.ts'
import type { SchemaMigrationRecord } from '../control-plane-store.ts'

// Schema-migration log extracted from in-memory-control-plane-store.ts. Owns the
// applied-migration records (idempotent record + list). No host — it has no
// cross-domain dependencies. Behaviour-preserving; covered by the
// cloud-control-plane-store suite.

export class InMemorySchemaMigrationsDomain {
  private readonly migrations = new Map<string, SchemaMigrationRecord>()

  recordSchemaMigration(id: string, appliedAt = new Date()): SchemaMigrationRecord {
    const existing = this.migrations.get(id)
    if (existing) return clone(existing)
    const record: SchemaMigrationRecord = {
      id,
      appliedAt: appliedAt.toISOString(),
    }
    this.migrations.set(id, record)
    return clone(record)
  }

  listSchemaMigrations(): SchemaMigrationRecord[] {
    return Array.from(this.migrations.values()).map((record) => clone(record))
  }
}
