import type { WebhookAuthFailureRecord } from '../../workflow/workflow-webhook-server.ts'
import { numberValue, type QueryRow } from './shared.ts'

export function webhookAuthFailureFromRow(row: QueryRow): WebhookAuthFailureRecord {
  return {
    authWindowStartedAt: numberValue(row.auth_window_started_at_ms),
    authFailureCount: numberValue(row.auth_failure_count),
    blockedUntil: numberValue(row.blocked_until_ms),
  }
}
