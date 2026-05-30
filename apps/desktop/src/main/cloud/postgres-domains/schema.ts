import type { SchemaMigrationRecord } from '../control-plane-store.ts'
import { iso, type QueryRow } from './shared.ts'

export function migrationFromRow(row: QueryRow): SchemaMigrationRecord {
  return {
    id: String(row.id),
    appliedAt: iso(row.applied_at),
  }
}
