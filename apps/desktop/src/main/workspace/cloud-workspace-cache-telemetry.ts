import { log } from '@open-cowork/shared/node'
import type { CloudWorkspaceCacheFileEncoding } from './cloud-workspace-cache-format.ts'

export type CloudWorkspaceCacheTelemetryEvent = {
  operation: 'read' | 'decrypt' | 'write' | 'quarantine' | 'migrate_v1'
  outcome: 'blocked' | 'failed' | 'completed'
  reason:
    | 'secure_storage_unavailable'
    | 'io_error'
    | 'decrypt_error'
    | 'ambiguous_legacy_format'
    | 'invalid_document'
    | 'quarantine_failed'
    | 'workflow_partitions_removed'
    | 'sensitive_views_removed'
    | 'write_error'
  encoding: CloudWorkspaceCacheFileEncoding | 'unknown'
}

export type CloudWorkspaceCacheReporter = (event: CloudWorkspaceCacheTelemetryEvent) => void

function reportCacheEventToLog(event: CloudWorkspaceCacheTelemetryEvent) {
  log(
    'cloud-cache',
    `operation=${event.operation} outcome=${event.outcome} reason=${event.reason} encoding=${event.encoding}`,
  )
}

export function createCloudWorkspaceCacheReporter(
  reporter: CloudWorkspaceCacheReporter = reportCacheEventToLog,
): CloudWorkspaceCacheReporter {
  const reported = new Set<string>()
  return (event) => {
    const key = `${event.operation}:${event.outcome}:${event.reason}:${event.encoding}`
    if (reported.has(key)) return
    reported.add(key)
    try {
      reporter(event)
    } catch {
      // Cache safety and availability never depend on observability delivery.
    }
  }
}
