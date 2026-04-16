import type { DashboardSummary, DashboardTimeRangeKey, SessionUsageSummary } from '@open-cowork/shared'
import { log } from './logger.ts'
import { shortSessionId } from './log-sanitizer.ts'
import { listSessionRecords, updateSessionRecord } from './session-registry.ts'
import { syncSessionView } from './session-history-loader.ts'
import { sessionEngine } from './session-engine.ts'
import {
  buildSessionUsageSummary,
  createDashboardTimeRange,
  createEmptyDashboardSummary,
  EMPTY_SESSION_USAGE_SUMMARY,
  isRecordInDashboardRange,
  sumSessionUsageSummaries,
  toDashboardSessionSummary,
} from './session-usage-summary.ts'

const BACKFILL_LIMIT = 12

async function backfillSessionUsageSummary(sessionId: string) {
  const view = await syncSessionView(sessionId, { activate: false })
  return view
}

export async function getDashboardSummary(rangeKey: DashboardTimeRangeKey = 'last7d'): Promise<DashboardSummary> {
  const range = createDashboardTimeRange(rangeKey)
  const records = listSessionRecords()
    .filter((record) => isRecordInDashboardRange(record, range))
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())

  if (records.length === 0) {
    return createEmptyDashboardSummary(range)
  }

  let backfilledSessions = 0
  const missingSummaryRecords = records
    .filter((record) => !record.summary)
    .slice(0, BACKFILL_LIMIT)

  for (const record of missingSummaryRecords) {
    try {
      const view = await backfillSessionUsageSummary(record.id)
      const usage = sessionEngine.getSessionUsageSummary(record.id)
        || buildSessionUsageSummary(view)
      updateSessionRecord(record.id, { summary: usage })
      record.summary = usage
      backfilledSessions += 1
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log('dashboard', `Failed to backfill summary for ${shortSessionId(record.id)}: ${message}`)
    }
  }

  const sessionSummaries = records.map((record) => {
    const usage = sessionEngine.getSessionUsageSummary(record.id)
      || record.summary
      || EMPTY_SESSION_USAGE_SUMMARY
    return toDashboardSessionSummary(record, usage)
  })

  const totals = sumSessionUsageSummaries(sessionSummaries.map((session) => session.usage as SessionUsageSummary))

  return {
    range,
    totals,
    recentSessions: sessionSummaries.slice(0, 6),
    generatedAt: new Date().toISOString(),
    backfilledSessions,
  }
}
