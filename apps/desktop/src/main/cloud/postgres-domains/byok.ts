import type { ByokSecretRecord } from '../control-plane-store.ts'
import { iso, isoOrNull, stringOrNull, type QueryRow } from './shared.ts'

export function byokSecretFromRow(row: QueryRow): ByokSecretRecord {
  return {
    secretId: String(row.secret_id),
    orgId: String(row.org_id),
    providerId: String(row.provider_id),
    ciphertext: stringOrNull(row.ciphertext),
    kmsRef: stringOrNull(row.kms_ref),
    keyFingerprint: String(row.key_fingerprint),
    last4: String(row.last4),
    createdByAccountId: stringOrNull(row.created_by_account_id),
    rotatedFromSecretId: stringOrNull(row.rotated_from_secret_id),
    lastValidatedAt: isoOrNull(row.last_validated_at),
    validationError: stringOrNull(row.validation_error),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    status: String(row.status) as ByokSecretRecord['status'],
  }
}
