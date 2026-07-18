import { argValue, assertConfigured, gatewayFetch, hasArg } from '../shared.js'

export async function analyticsCommand() {
  assertConfigured('analytics')
  const analytics = await import('../../analytics.js')
  const scorecard = hasArg('--scorecard')
  const byArg = argValue('--by')
  const windowArg = argValue('--window')
  const request: import('../../analytics.js').AnalyticsRequest = {
    by: byArg === 'agent' || byArg === 'roadmap' || byArg === 'profile' ? byArg : undefined,
    windowDays: windowArg !== undefined && Number.isFinite(Number(windowArg)) ? Number(windowArg) : undefined,
    roadmapId: argValue('--roadmap'),
    profile: argValue('--profile'),
    agent: argValue('--agent'),
  }
  const params = new URLSearchParams()
  if (scorecard) params.set('view', 'scorecard')
  if (request.by) params.set('by', request.by)
  if (request.windowDays !== undefined) params.set('window', String(request.windowDays))
  if (request.roadmapId) params.set('roadmapId', request.roadmapId)
  if (request.profile) params.set('profile', request.profile)
  if (request.agent) params.set('agent', request.agent)
  const emit = (report: unknown) => {
    if (hasArg('--json')) { console.log(JSON.stringify(report, null, 2)); return }
    console.log(scorecard
      ? analytics.formatAnalyticsScorecardText(report as import('../../analytics.js').AnalyticsScorecard)
      : analytics.formatAnalyticsSummaryText(report as import('../../analytics.js').AnalyticsSummary))
  }
  try {
    const res = await gatewayFetch(`/analytics${params.size ? `?${params}` : ''}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    emit(((await res.json()) as any).analytics)
  } catch {
    // Daemon unreachable: analytics is read-only over the local store, so
    // compute it directly for a truthful offline answer. Guard this fallback so
    // a compute error (e.g. a malformed request) yields a clean message and a
    // non-zero exit instead of an uncaught stack trace escaping the outer catch.
    try {
      emit(scorecard ? analytics.buildAnalyticsScorecard(request) : analytics.buildAnalyticsSummary(request))
    } catch (error) {
      console.error(`analytics failed: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    }
  }
}
