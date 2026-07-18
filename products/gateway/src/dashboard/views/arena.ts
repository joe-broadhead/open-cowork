import { esc, escAttr } from '../html.js'
import { asArray, shortId, fmtNumber, fmtPct, formatDateTime } from '../format.js'
import { card, metric, headFig, mini } from '../components.js'
import { renderRunAttribution, renderArtifactLinks } from './shared.js'
import type { DashboardView, ArenaView, ArenaRunView, ArenaComparisonView, PromotionHistoryEntryView } from '../types.js'

function renderArena(view: DashboardView): string {
  const arena = view.arena
  return `<section class="view" data-view="arena">
    <div class="view-head"><div><h1 class="page-h">Arena</h1><p class="page-sub">Evaluation runs, evidence, comparisons, and promotion outcomes from durable Gateway scorecards and promotion decisions.</p></div><div class="head-figs">
      ${headFig(String(arena.totals.runs), 'eval runs')}${headFig(String(arena.totals.failed), 'failed')}${headFig(String(arena.totals.history), 'history')}
    </div></div>
    ${renderArenaSourceState(arena)}
    <div class="kpis">
      ${metric('Passed Evidence', String(arena.totals.passed), 'promote-ready scorecards')}
      ${metric('Blocked Evidence', String(arena.totals.failed), 'failed or blocking scorecards')}
      ${metric('Comparisons', String(arena.totals.comparisons), 'same fixture/source')}
      ${metric('Artifacts', String(arena.totals.artifacts), 'linked evidence refs')}
    </div>
    <div class="grid-2">
      ${card('Arena Run List', 'R', renderArenaFilter(arena), renderArenaRuns(arena.runs))}
      ${card('Run Detail', 'D', `<span class="pill">${arena.runs.length ? 'selectable' : 'empty'}</span>`, renderArenaRunDetails(arena.runs))}
    </div>
    <div class="grid-2">
      ${card('Promotion History', 'H', `<span class="pill">${arena.promotionHistory.length} events</span>`, renderPromotionHistory(arena.promotionHistory))}
      ${card('Comparison Summaries', 'C', `<span class="pill">${arena.comparisons.length} groups</span>`, renderArenaComparisons(arena.comparisons))}
    </div>
    ${card('Recent Gateway Runs', 'R', `<span class="pill">${view.runs.length} runs</span>`, renderRunAttribution(view.runs))}
  </section>`
}
function renderArenaFilter(_arena: ArenaView): string {
  return `<div class="tabs" aria-label="Arena evidence filter"><button type="button" data-filter-group="arena" data-filter-button="all" aria-pressed="true">All</button><button type="button" data-filter-group="arena" data-filter-button="passed" aria-pressed="false">Passed</button><button type="button" data-filter-group="arena" data-filter-button="failed" aria-pressed="false">Failed</button></div>`
}

function renderArenaSourceState(arena: ArenaView): string {
  const stateClass = !arena.source.available ? 'bad' : arena.source.partial ? 'warn' : 'good'
  const body = !arena.source.available
    ? '<p class="empty bad-text">Promotion evidence could not be loaded from durable Gateway storage. Existing dashboard sections continue rendering with available data.</p>'
    : arena.source.partial
      ? `<p class="empty">Partial data: ${fmtNumber(arena.source.scorecards)} scorecards loaded, but no promotion decisions are recorded yet. Run evidence is still shown.</p>`
      : `<div class="grid-3">${mini('Scorecards', fmtNumber(arena.source.scorecards))}${mini('Decisions', fmtNumber(arena.source.decisions))}${mini('Loading', 'complete')}</div>`
  return card('Arena Data Source', 'S', `<span class="pill ${stateClass}">${arena.source.available ? arena.source.partial ? 'partial' : 'loaded' : 'failed'}</span>`, `${body}<div class="src-note">source: promotion_scorecards and promotion_decisions in Gateway durable storage. No synthetic Arena run store is rendered.</div>`)
}

function renderArenaRuns(runs: ArenaRunView[]): string {
  if (!runs.length) return '<p class="empty">No eval scorecards have been persisted yet. Create scorecards with gateway_promotion_scorecard_create.</p>'
  return `<div class="table-wrap"><table class="table"><thead><tr><th>Run</th><th>Candidate</th><th>Inputs</th><th>Score</th><th>Status</th><th>Promotion</th><th>Artifacts</th><th>Updated</th></tr></thead><tbody>${runs.map((run, index) => {
    const filterValues = `${run.passed ? 'passed' : 'failed'} ${escAttr(run.status || '')}`
    return `<tr data-filter-row="arena" data-filter-values="${escAttr(filterValues)}"><td class="name"><button class="edge-select" type="button" data-arena-select="${escAttr(run.id)}" aria-pressed="${index === 0 ? 'true' : 'false'}">${esc(shortId(run.id))}</button></td><td><a href="${escAttr(run.candidateHref)}">${esc(run.candidateLabel)}</a><div class="meta">version ${esc(shortId(run.version))}</div></td><td>${esc(run.inputLabel)}</td><td>${esc(run.scoreLabel)}</td><td><span class="pill ${run.passed ? 'good' : 'bad'}">${esc(run.status || '?')}</span></td><td>${esc(run.promotionOutcome)}<div class="meta">${esc(run.regressionLabel)}</div></td><td>${renderArtifactLinks(run.artifacts)}</td><td>${run.updatedAt ? esc(formatDateTime(run.updatedAt)) : '--'}</td></tr>`
  }).join('')}</tbody></table></div>`
}

function renderArenaRunDetails(runs: ArenaRunView[]): string {
  if (!runs.length) return '<p class="empty">Select an Arena run after scorecard evidence has been persisted.</p>'
  return runs.map((run, index) => {
    const failed = run.failedMetrics.length ? run.failedMetrics.map(metric => `${metric.id}${metric.diagnostic ? `: ${metric.diagnostic}` : ''}`) : ['No failed metrics recorded.']
    const thresholds = asArray(run.thresholds).length ? asArray(run.thresholds).map((threshold: any) => `${threshold.id || threshold.metric}: ${threshold.passed ? 'passed' : 'failed'}${threshold.actualPercentage !== undefined ? ` (${fmtPct(Number(threshold.actualPercentage))})` : ''}`) : ['No thresholds recorded.']
    return `<div class="work-detail ${index === 0 ? 'active' : ''}" data-arena-detail="${escAttr(run.id)}">
      <div class="title">${esc(run.sourceLabel)}</div>
      <div class="meta">${esc(run.candidateLabel)} / ${esc(run.scoreLabel)} / ${esc(run.recommendation)}</div>
      <dl class="detail-kv">
        <dt>Run</dt><dd>${esc(run.id)}</dd>
        <dt>Input</dt><dd>${esc(run.inputLabel)}</dd>
        <dt>Candidate</dt><dd><a href="${escAttr(run.candidateHref)}">${esc(run.candidateLabel)}</a></dd>
        <dt>Version</dt><dd>${esc(run.version)}</dd>
        <dt>Gate</dt><dd>${esc(run.gateResult)}</dd>
        <dt>Outcome</dt><dd>${esc(run.promotionOutcome)}</dd>
        <dt>Regression</dt><dd>${esc(run.regressionLabel)}</dd>
        <dt>Updated</dt><dd>${run.updatedAt ? esc(formatDateTime(run.updatedAt)) : '--'}</dd>
      </dl>
      <div class="src-note">${esc(run.conclusion)}</div>
      <div class="lane" style="margin-top:10px">
        <div class="row compact"><div><div class="title">Failed metrics</div><div class="meta">${esc(failed.slice(0, 5).join(' / '))}</div></div><span class="pill ${run.failedMetrics.length ? 'bad' : 'good'}">${run.failedMetrics.length}</span></div>
        <div class="row compact"><div><div class="title">Thresholds</div><div class="meta">${esc(thresholds.slice(0, 5).join(' / '))}</div></div><span class="pill">${run.thresholds.length}</span></div>
        <div class="row compact"><div><div class="title">Evidence links</div><div class="meta">${renderArtifactLinks(run.artifacts)}</div></div><span class="pill purple">${run.evidence.length}</span></div>
      </div>
    </div>`
  }).join('')
}

function renderPromotionHistory(history: PromotionHistoryEntryView[]): string {
  if (!history.length) return '<p class="empty">No promotion scorecards or decisions have been recorded yet.</p>'
  return `<div class="table-wrap"><table class="table"><thead><tr><th>Time</th><th>Subject</th><th>Version</th><th>Gate Result</th><th>Reviewer / Source</th><th>Rollback</th><th>Event</th></tr></thead><tbody>${history.map(entry => `<tr><td>${entry.timestamp ? esc(formatDateTime(entry.timestamp)) : '--'}</td><td class="name"><a href="${escAttr(entry.subjectHref)}">${esc(entry.subjectLabel)}</a></td><td>${esc(shortId(entry.version))}</td><td><span class="pill ${entry.statusClass}">${esc(entry.gateResult)}</span></td><td>${esc(entry.reviewer)}<div class="meta">${esc(shortId(entry.sourceLabel))}</div></td><td>${esc(entry.rollbackEligibility)}</td><td>${esc(entry.event)}</td></tr>`).join('')}</tbody></table></div>`
}

function renderArenaComparisons(comparisons: ArenaComparisonView[]): string {
  if (!comparisons.length) return '<p class="empty">No comparison groups yet. Multiple scorecards with the same arena/eval source will be grouped here.</p>'
  return `<div class="lane">${comparisons.map(comparison => {
    const hasBlocker = comparison.rows.some(row => row.scorecard.status === 'blocked' || row.scorecard.recommendation === 'block')
    return `<div class="row compact"><span class="dot ${hasBlocker ? 'pending' : 'done'}"></span><div><div class="title">${esc(comparison.label)}</div><div class="meta">${esc(comparison.rows.map(row => `${row.subject} ${row.scoreLabel}`).join(' / '))}</div></div><span class="pill ${hasBlocker ? 'warn' : 'good'}">${comparison.rows.length} contestants</span></div>`
  }).join('')}</div>`
}

export { renderArena }
