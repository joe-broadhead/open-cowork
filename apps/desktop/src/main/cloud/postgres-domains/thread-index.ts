import type { ThreadSmartFilterRecord, ThreadTagRecord } from '../control-plane-store.ts'
import { iso, jsonRecord, type QueryRow } from './shared.ts'

export function threadTagFromRow(row: QueryRow): ThreadTagRecord {
  return {
    tenantId: String(row.tenant_id),
    tagId: String(row.tag_id),
    name: String(row.name),
    color: String(row.color),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

export function threadSmartFilterFromRow(row: QueryRow): ThreadSmartFilterRecord {
  return {
    tenantId: String(row.tenant_id),
    filterId: String(row.filter_id),
    name: String(row.name),
    query: jsonRecord(row.query),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}
