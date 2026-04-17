import electron from 'electron'
import type { DashboardSummary, DashboardTimeRangeKey, SessionUsageSummary } from '@open-cowork/shared'

// Access BrowserWindow defensively — the test harness imports this
// module without Electron runtime, and the static named import throws
// on Node. Falling back to an empty window list makes the emit a no-op
// in tests without a conditional at every call site.
type BrowserWindowLike = { isDestroyed(): boolean; webContents: { send: (channel: string) => void } }
const getBrowserWindows = (): BrowserWindowLike[] => {
  const impl = (electron as { BrowserWindow?: { getAllWindows?: () => BrowserWindowLike[] } }).BrowserWindow
  return impl?.getAllWindows?.() || []
}
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
  mergeAgentBreakdowns,
  sumSessionUsageSummaries,
  toDashboardSessionSummary,
} from './session-usage-summary.ts'

// The dashboard's first paint has to land fast — long histories with
// dozens of ungeraded summaries would otherwise block the IPC for
// seconds. We drain at most FAST_BACKFILL_LIMIT synchronously, then
// hand the remainder to `drainBackfillQueue()` which chews through
// sessions one at a time on setImmediate ticks. When the queue makes
// progress we emit `dashboard:summary-updated` so the renderer can
// silently re-fetch and show the newly-reconstructed totals.
const FAST_BACKFILL_LIMIT = 12

// Sessions that fail backfill are remembered across calls so we don't
// retry them every refresh cycle. Cleared when a successful backfill
// writes their summary to disk (which would remove them from the
// "missing summary" filter anyway) or on process restart.
const persistentFailures = new Set<string>()

// Session ids currently queued for background backfill. Shared module
// state lets repeated dashboard fetches union their pending work
// rather than kicking off duplicate drainers per call.
const pendingBackfill = new Set<string>()
let drainerRunning = false

async function backfillSessionUsageSummary(sessionId: string) {
  const view = await syncSessionView(sessionId, { activate: false })
  return view
}

function emitSummaryUpdated() {
  for (const win of getBrowserWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send('dashboard:summary-updated')
  }
}

async function processOneBackfill(sessionId: string) {
  try {
    const view = await backfillSessionUsageSummary(sessionId)
    const usage = sessionEngine.getSessionUsageSummary(sessionId) || buildSessionUsageSummary(view)
    updateSessionRecord(sessionId, { summary: usage })
    persistentFailures.delete(sessionId)
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log('dashboard', `Failed to backfill summary for ${shortSessionId(sessionId)}: ${message}`)
    persistentFailures.add(sessionId)
    return false
  }
}

function scheduleDrainer() {
  if (drainerRunning) return
  drainerRunning = true
  // setImmediate hands control back so the current IPC reply lands
  // before the drainer starts chewing. Sequential one-at-a-time keeps
  // disk I/O calm; a small await-delay between sessions avoids starving
  // other work under extreme backlogs (e.g. 200+ legacy threads).
  setImmediate(async () => {
    try {
      let processed = 0
      while (pendingBackfill.size > 0) {
        const [next] = pendingBackfill
        pendingBackfill.delete(next)
        const ok = await processOneBackfill(next)
        if (ok) processed += 1
        // Batch the update signal so a long drain doesn't spam the
        // renderer with refresh events. Emit every 3 successes or when
        // the queue empties.
        if (ok && (processed % 3 === 0 || pendingBackfill.size === 0)) {
          emitSummaryUpdated()
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      if (processed > 0) emitSummaryUpdated()
    } finally {
      drainerRunning = false
    }
  })
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

  // Never retry a session that failed backfill on a prior call in this
  // process — we'd just keep bumping the failed count and churning
  // through the same broken session on every refresh.
  const missingRecords = records.filter((record) => !record.summary && !persistentFailures.has(record.id))
  const immediateBatch = missingRecords.slice(0, FAST_BACKFILL_LIMIT)
  const deferred = missingRecords.slice(FAST_BACKFILL_LIMIT)

  for (const record of immediateBatch) {
    const ok = await processOneBackfill(record.id)
    if (ok) {
      backfilledSessions += 1
      // Re-read so the session summary we just wrote is visible to the
      // summary-computation below without a second disk round-trip.
      const fresh = listSessionRecords().find((r) => r.id === record.id)
      if (fresh?.summary) record.summary = fresh.summary
    }
  }

  for (const record of deferred) {
    pendingBackfill.add(record.id)
  }
  if (pendingBackfill.size > 0) scheduleDrainer()

  const sessionSummaries = records.map((record) => {
    const usage = sessionEngine.getSessionUsageSummary(record.id)
      || record.summary
      || EMPTY_SESSION_USAGE_SUMMARY
    return toDashboardSessionSummary(record, usage)
  })

  const usages = sessionSummaries.map((session) => session.usage as SessionUsageSummary)
  const totals = sumSessionUsageSummaries(usages)
  const topAgents = mergeAgentBreakdowns(usages)

  // `processOneBackfill` populates `persistentFailures` on each failure,
  // so the set already reflects this-call failures. Report its size as
  // the total count — it's the union of "failed today" and "failed in
  // an earlier refresh this process".
  const failedRecordIdsInRange = records.filter((record) => persistentFailures.has(record.id)).length

  return {
    range,
    totals,
    recentSessions: sessionSummaries.slice(0, 6),
    topAgents,
    generatedAt: new Date().toISOString(),
    backfilledSessions,
    backfillFailedCount: failedRecordIdsInRange,
    backfillPendingCount: pendingBackfill.size,
  }
}
