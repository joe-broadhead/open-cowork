import { html, attr, trustedHtml, type HtmlSafe } from '../html.js'
import { shortId, fmtMoney, compactNumber, fmtDuration, formatDateTime, fmtPct } from '../format.js'
import { card, headFig, stackedBar } from '../components.js'
import { renderDetailDocument } from '../document.js'
import {
  getRoadmapDetailData,
  getTaskDetailData,
  getRunDetailData,
  type RunRecord,
  type WorkDependencyRecord,
  type TaskDependencyRef,
} from '../../mission-data.js'
import {
  buildAnalyticsSummary,
  buildAnalyticsScorecard,
  parseAnalyticsRequestFromParams,
  type AnalyticsRequest,
  type AnalyticsSummary,
  type AnalyticsScorecard,
} from '../../analytics.js'

function breadcrumbTrail(items: Array<{ label: string; href?: string }>): HtmlSafe {
  const parts: HtmlSafe[] = []
  items.forEach((item, index) => {
    if (index > 0) parts.push(html`<span class="sep">/</span>`)
    parts.push(item.href ? html`<a href="${attr(item.href)}">${item.label}</a>` : html`<span>${item.label}</span>`)
  })
  return html`<nav class="breadcrumb" aria-label="Breadcrumb">${parts}</nav>`
}

function filterBox(target: string, placeholder: string, total: number): HtmlSafe {
  return html`<div class="filter-box"><input type="search" data-filter-input="${attr(target)}" placeholder="${attr(placeholder)}" aria-label="${attr(placeholder)}"><span class="count" data-filter-count="${attr(target)}">${String(total)}/${String(total)}</span></div>`
}

function kvGrid(rows: Array<{ k: string; v: HtmlSafe | string }>): HtmlSafe {
  return html`<div class="kv-grid">${rows.map(row => html`<div class="kv"><div class="k">${row.k}</div><div class="v">${row.v}</div></div>`)}</div>`
}

function runStatusClass(status: string | undefined): string {
  return status === 'passed' ? 'good' : status === 'running' ? 'warn' : 'bad'
}

function tokenTotal(run: RunRecord): number {
  return (run.inputTokens || 0) + (run.outputTokens || 0) + (run.reasoningTokens || 0)
}

function renderRunsTable(runs: RunRecord[], filterTarget: string): HtmlSafe {
  if (!runs.length) return html`<p class="empty">No runs recorded yet.</p>`
  return html`<div class="table-wrap"><table class="table"><thead><tr><th>Run</th><th>Stage</th><th>Profile</th><th>Status</th><th class="num">Attempt</th><th class="num">Cost</th><th class="num">Tokens</th><th class="num">Runtime</th><th>Started</th></tr></thead><tbody>${runs.map(run =>
    html`<tr data-filter-row="${attr(filterTarget)}" data-filter-text="${attr(`${run.id || ''} ${run.stage || ''} ${run.profile || ''} ${run.status || ''}`)}"><td class="name"><a class="detail-link" href="/dashboard?view=run&id=${encodeURIComponent(run.id)}">${shortId(run.id)}</a></td><td>${run.stage || '?'}</td><td>${run.resolvedProfile || run.profile || '?'}</td><td><span class="pill ${trustedHtml(runStatusClass(run.status))}">${run.status || '?'}</span></td><td class="num">${String(run.attempt ?? 0)}</td><td class="num">${fmtMoney(run.costUsd || 0)}</td><td class="num">${compactNumber(tokenTotal(run))}</td><td class="num">${fmtDuration(run.runtimeMs || 0)}</td><td>${run.startedAt ? formatDateTime(run.startedAt) : '--'}</td></tr>`)}</tbody></table></div>`
}

// ---- Analytics view -------------------------------------------------------

function analyticsDimLink(dim: string, key: string): HtmlSafe {
  if (dim === 'roadmap') return html`<a class="detail-link" href="/dashboard?view=roadmap&id=${encodeURIComponent(key)}">${key || '(unattributed)'}</a>`
  const param = dim === 'agent' ? 'agent' : 'profile'
  const query = new URLSearchParams({ view: 'analytics', by: dim, [param]: key })
  return html`<a class="detail-link" href="/dashboard?${attr(query.toString())}">${key || '(unattributed)'}</a>`
}

function analyticsScopeChip(label: string, query: URLSearchParams, active: boolean): HtmlSafe {
  return html`<a class="${active ? 'active' : ''}" href="/dashboard?${attr(query.toString())}">${label}</a>`
}

function renderAnalyticsControls(request: AnalyticsRequest, dimension: string): HtmlSafe {
  const windowDays = request.windowDays ?? 30
  // Preserve every active scope param so switching window/dimension from a
  // scoped drill-down (e.g. ?by=profile&profile=X) keeps that scope instead of
  // silently widening back to the global view.
  const scopedQuery = (by: string, window: number): URLSearchParams => {
    const query = new URLSearchParams({ view: 'analytics', by, window: String(window) })
    for (const key of ['roadmapId', 'profile', 'agent', 'stage'] as const) {
      const value = request[key]
      if (value) query.set(key, value)
    }
    return query
  }
  const dimChips = (['profile', 'agent', 'roadmap'] as const).map(dim =>
    analyticsScopeChip(`by ${dim}`, scopedQuery(dim, windowDays), dim === dimension))
  const windowChips = [7, 30, 90].map(days =>
    analyticsScopeChip(`${days}d`, scopedQuery(dimension, days), windowDays === days))
  return html`<div class="analytics-scope">${dimChips}<span class="sep">|</span>${windowChips}</div>`
}

export function renderAnalyticsView(input: { summary: AnalyticsSummary; scorecard: AnalyticsScorecard; request: AnalyticsRequest }): string {
  const { summary, scorecard, request } = input
  const dim = summary.dimension
  const outcome = summary.outcomeDistribution
  const totalCost = summary.usageByDimension.reduce((sum, row) => sum + (row.costUsd || 0), 0)
  const totalRuns = summary.usageByDimension.reduce((sum, row) => sum + (row.runCount || 0), 0)
  const scopeBits = Object.entries(summary.scope).filter(([, value]) => value).map(([key, value]) => `${key}=${value}`)
  const usageBody = summary.usageByDimension.length
    ? html`${filterBox('an-usage', `Filter ${dim}s`, summary.usageByDimension.length)}<div class="table-wrap"><table class="table"><thead><tr><th>${dim}</th><th class="num">Runs</th><th class="num">Cost</th><th class="num">Tokens</th><th class="num">Runtime</th></tr></thead><tbody>${summary.usageByDimension.map(row =>
        html`<tr data-filter-row="an-usage" data-filter-text="${attr(row.key)}"><td class="name">${analyticsDimLink(dim, row.key)}</td><td class="num">${String(row.runCount)}</td><td class="num">${fmtMoney(row.costUsd)}</td><td class="num">${compactNumber(row.tokens)}</td><td class="num">${fmtDuration(row.runtimeMs)}</td></tr>`)}</tbody></table></div>`
    : html`<p class="empty">No runs in the selected window.</p>`
  const scoreBody = scorecard.scorecards.length
    ? html`${filterBox('an-score', `Filter ${dim}s`, scorecard.scorecards.length)}<div class="table-wrap"><table class="table"><thead><tr><th>${dim}</th><th class="num">Runs</th><th class="num">Completion</th><th class="num">Genuine fail</th><th class="num">Avg attempts</th><th class="num">Completed</th><th class="num">Cost</th><th class="num">Cost/task</th></tr></thead><tbody>${scorecard.scorecards.map(row =>
        html`<tr data-filter-row="an-score" data-filter-text="${attr(row.key)}"><td class="name">${analyticsDimLink(dim, row.key)}</td><td class="num">${String(row.totalRuns)}</td><td class="num">${fmtPct(row.completionRate)}</td><td class="num">${row.genuineErrored > 0 ? html`<span class="pill ${row.genuineFailureRate > 0.5 ? 'bad' : 'warn'}">${fmtPct(row.genuineFailureRate)}</span>` : fmtPct(row.genuineFailureRate)}</td><td class="num">${row.avgAttempts.toFixed(2)}</td><td class="num">${String(row.completedTasks)}</td><td class="num">${fmtMoney(row.costUsd)}</td><td class="num">${row.costPerCompletedTask !== undefined ? fmtMoney(row.costPerCompletedTask) : 'n/a'}</td></tr>`)}</tbody></table></div>`
    : html`<p class="empty">No terminal runs to score in the selected window.</p>`
  const overall = scorecard.overall
  const errorClassRow = (label: string, value: number, cohort: string): HtmlSafe =>
    html`<tr><td class="name">${label}</td><td>${cohort}</td><td class="num">${String(value)}</td></tr>`
  const errorBody = overall.errorClasses.total
    ? html`<p class="page-sub">Of ${String(overall.errorClasses.total)} errored run(s): <strong>${String(overall.operationalErrored)} operational</strong> (Gateway run-lifecycle churn, not the profile's fault), <strong>${String(overall.externalErrored)} external</strong> (provider/account/infra), <strong>${String(overall.genuineErrored)} genuine</strong> (the profile's own fault), <strong>${String(overall.unknownErrored)} unknown</strong> (no durable result; cause indeterminate). Genuine failure rate ${fmtPct(overall.genuineFailureRate)}.</p><div class="table-wrap"><table class="table"><thead><tr><th>Error class</th><th>Cohort</th><th class="num">Runs</th></tr></thead><tbody>${[
        errorClassRow('recovered_session', overall.errorClasses.recovered_session, 'operational'),
        errorClassRow('force_done', overall.errorClasses.force_done, 'operational'),
        errorClassRow('lease_expired', overall.errorClasses.lease_expired, 'operational'),
        errorClassRow('provider_balance', overall.errorClasses.provider_balance, 'external'),
        errorClassRow('transport', overall.errorClasses.transport, 'external'),
        errorClassRow('provider_error', overall.errorClasses.provider_error, 'external'),
        errorClassRow('genuine_failure', overall.errorClasses.genuine_failure, 'genuine'),
        errorClassRow('unknown', overall.errorClasses.unknown, 'unknown'),
      ]}</tbody></table></div>`
    : html`<p class="empty good">No errored runs in the selected window.</p>`
  const hotspotBody = summary.retryHotspots.length
    ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Task</th><th class="num">Max attempt</th><th class="num">Runs</th><th class="num">Cost</th></tr></thead><tbody>${summary.retryHotspots.map(spot =>
        html`<tr><td class="name"><a class="detail-link" href="/dashboard?view=task&id=${encodeURIComponent(spot.taskId)}">${shortId(spot.taskId)}</a></td><td class="num">${String(spot.maxAttempt)}</td><td class="num">${String(spot.runCount)}</td><td class="num">${fmtMoney(spot.costUsd)}</td></tr>`)}</tbody></table></div>`
    : html`<p class="empty good">No retry hotspots in the selected window.</p>`
  const underBody = scorecard.underperformers.length
    ? html`<div class="lane">${scorecard.underperformers.map(row =>
        html`<div class="row compact"><span class="dot blocked"></span><div><div class="title">${analyticsDimLink(dim, row.key)}</div><div class="meta">${row.reason}</div></div><span class="pill bad">${fmtPct(row.completionRate)}</span></div>`)}</div>`
    : html`<p class="empty good">No underperformers: no group is strictly worse than its peers on both spend and completion.</p>`
  const budgetBody = summary.budgetTrend.entries.length
    ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Scope</th><th class="num">Window spend</th><th class="num">Configured limit</th></tr></thead><tbody>${summary.budgetTrend.entries.map(entry => {
        const limit = entry.monthlyCostUsd ?? entry.weeklyCostUsd ?? entry.dailyCostUsd ?? entry.totalCostUsd
        return html`<tr><td class="name">${entry.name}</td><td class="num">${fmtMoney(entry.windowCostUsd)}</td><td class="num">${limit !== undefined ? fmtMoney(limit) : '--'}</td></tr>`
      })}</tbody></table></div><div class="src-note">${summary.budgetTrend.note}</div>`
    : html`<p class="empty">${summary.budgetTrend.note}</p>`
  const outcomeBar = trustedHtml(stackedBar([
    { label: 'Passed', value: outcome.passed, color: 'var(--green)' },
    { label: 'Failed', value: outcome.failed, color: 'var(--red)' },
    { label: 'Blocked', value: outcome.blocked, color: 'var(--orange)' },
    { label: 'Errored', value: outcome.errored, color: 'var(--pink)' },
    { label: 'Running', value: outcome.running, color: 'var(--cyan)' },
  ]))
  return html`<div class="view-head"><div><h1 class="page-h">Run Analytics</h1><p class="page-sub">Read-only run-history analytics over the last ${summary.window.days.toFixed(0)} days, grouped by ${dim}. ${scopeBits.length ? `Scope: ${scopeBits.join(', ')}.` : 'Global scope.'}</p></div><div class="head-figs">${trustedHtml(headFig(fmtMoney(totalCost), 'window spend'))}${trustedHtml(headFig(String(totalRuns), 'runs'))}${trustedHtml(headFig(fmtPct(outcome.completionRate), 'completion'))}</div></div>
    ${renderAnalyticsControls(request, dim)}
    ${trustedHtml(card('Outcome Distribution', 'O', html`<span class="pill">${String(outcome.total)} runs</span>`.value, html`${outcomeBar}`.value))}
    ${trustedHtml(card(`Spend & Usage by ${dim}`, '$', html`<span class="pill purple">${String(summary.usageByDimension.length)} ${dim}s</span>`.value, usageBody.value))}
    ${trustedHtml(card(`Completion Scorecard by ${dim}`, 'S', html`<span class="pill">medians: ${fmtMoney(scorecard.medians.costUsd)} / ${fmtPct(scorecard.medians.completionRate)}</span>`.value, scoreBody.value))}
    ${trustedHtml(card('Errored Diagnostics', 'E', html`<span class="pill ${overall.genuineErrored > 0 ? 'bad' : overall.errorClasses.total > 0 ? 'warn' : 'good'}">${String(overall.genuineErrored)} genuine</span>`.value, errorBody.value))}
    <div class="grid-2">
      ${trustedHtml(card('Retry Hotspots', 'R', html`<span class="pill ${summary.retryHotspots.length ? 'warn' : 'good'}">${String(summary.retryHotspots.length)}</span>`.value, hotspotBody.value))}
      ${trustedHtml(card('Underperformers', '!', html`<span class="pill ${scorecard.underperformers.length ? 'bad' : 'good'}">${String(scorecard.underperformers.length)}</span>`.value, underBody.value))}
    </div>
    ${trustedHtml(card('Budget Trend', 'B', html`<span class="pill ${summary.budgetTrend.enabled ? 'purple' : ''}">${summary.budgetTrend.enabled ? 'enabled' : 'disabled'}</span>`.value, budgetBody.value))}`.value
}

function renderAnalyticsDocument(params: URLSearchParams): string {
  const request = parseAnalyticsRequestFromParams(params)
  let body: string
  try {
    const summary = buildAnalyticsSummary(request)
    const scorecard = buildAnalyticsScorecard(request)
    body = renderAnalyticsView({ summary, scorecard, request })
  } catch {
    body = html`<div class="view-head"><div><h1 class="page-h">Run Analytics</h1><p class="page-sub">Analytics are unavailable right now.</p></div></div><p class="empty">No run history could be read for this window.</p>`.value
  }
  return renderDetailDocument({
    route: 'analytics',
    title: 'Gateway Mission Control - Analytics',
    breadcrumb: breadcrumbTrail([{ label: 'Mission Control', href: '/dashboard' }, { label: 'Analytics' }]),
    body: trustedHtml(body),
  })
}

// ---- Roadmap detail -------------------------------------------------------

export function renderRoadmapDetailView(input: {
  id: string
  roadmap?: any
  tasks: any[]
  dependencies: WorkDependencyRecord[]
  runs: RunRecord[]
  summary?: AnalyticsSummary
  statusFilter?: string
}): string {
  const { id, roadmap, tasks, dependencies, runs, summary, statusFilter } = input
  if (!roadmap) {
    return html`<div class="view-head"><div><h1 class="page-h">Roadmap not found</h1><p class="page-sub">No roadmap with id ${id || '(none)'} is in the durable store.</p></div></div><p class="empty">It may have been archived or deleted. <a class="detail-link" href="/dashboard">Return to Mission Control.</a></p>`.value
  }
  const done = tasks.filter(task => task.status === 'done').length
  const blocked = tasks.filter(task => task.status === 'blocked').length
  const running = tasks.filter(task => task.status === 'running').length
  const progress = tasks.length ? Math.round((done / tasks.length) * 100) : 0
  const windowSpend = summary ? summary.usageByDimension.reduce((sum, row) => sum + (row.costUsd || 0), 0) : 0
  const statuses = ['all', ...Array.from(new Set(tasks.map(task => String(task.status || 'unknown'))))]
  const shownTasks = statusFilter ? tasks.filter(task => String(task.status || 'unknown') === statusFilter) : tasks
  const statusChips = statuses.map(status => {
    const query = new URLSearchParams({ view: 'roadmap', id })
    if (status !== 'all') query.set('status', status)
    return html`<a class="chip-link ${(!statusFilter && status === 'all') || statusFilter === status ? 'active' : ''}" href="/dashboard?${attr(query.toString())}">${status}</a>`
  })
  const tasksBody = shownTasks.length
    ? html`${filterBox('rm-tasks', 'Filter tasks', shownTasks.length)}<div class="lane">${shownTasks.map(task =>
        html`<div class="row" data-filter-row="rm-tasks" data-filter-text="${attr(`${task.title || ''} ${task.status || ''} ${task.id || ''}`)}"><span class="priority ${priorityClass(task.priority)}">${task.priority || '?'}</span><div><div class="title"><a class="detail-link" href="/dashboard?view=task&id=${encodeURIComponent(task.id)}">${task.title || task.id}</a></div><div class="meta">${task.status || '?'} / ${task.currentStage || 'complete'} / ${shortId(task.id)}</div></div><span class="dot ${trustedHtml(taskDotClass(task.status))}"></span></div>`)}</div>`
    : html`<p class="empty">No tasks match this filter.</p>`
  const depsBody = dependencies.length
    ? html`<div class="lane">${dependencies.map(dep =>
        html`<div class="row compact"><div><div class="title"><a class="detail-link" href="/dashboard?view=task&id=${encodeURIComponent(dep.taskId)}">${shortId(dep.taskId)}</a></div><div class="meta">${dep.type || 'depends-on'} -> ${shortId(dep.dependsOnTaskId)}</div></div></div>`)}</div>`
    : html`<p class="empty good">No dependencies recorded between this roadmap's tasks.</p>`
  return html`<div class="view-head"><div><h1 class="page-h">${roadmap.title || roadmap.id}</h1><p class="page-sub">Roadmap ${shortId(roadmap.id)} / ${roadmap.status || 'active'}${roadmap.agentTeam ? ` / team ${roadmap.agentTeam}` : ''}.</p></div><div class="head-figs">${trustedHtml(headFig(`${done}/${tasks.length}`, 'tasks done'))}${trustedHtml(headFig(`${progress}%`, 'progress'))}${trustedHtml(headFig(fmtMoney(windowSpend), 'spend (last 30d)'))}</div></div>
    ${kvGrid([
      { k: 'Status', v: html`<span class="pill ${blocked ? 'bad' : running ? 'warn' : 'good'}">${roadmap.status || 'active'}</span>` },
      { k: 'Priority', v: String(roadmap.priority || '--') },
      { k: 'Supervisor / Team', v: String(roadmap.agentTeam || '--') },
      { k: 'Blocked / Running', v: `${blocked} / ${running}` },
      { k: 'Updated', v: roadmap.updatedAt ? formatDateTime(roadmap.updatedAt) : '--' },
    ])}
    <div class="filter-bar" style="margin-top:12px" aria-label="Task status filter">${statusChips}</div>
    ${trustedHtml(card('Tasks', 'T', html`<span class="pill">${String(shownTasks.length)}/${String(tasks.length)}</span>`.value, tasksBody.value))}
    <div class="grid-2">
      ${trustedHtml(card('Dependencies', 'D', html`<span class="pill">${String(dependencies.length)}</span>`.value, depsBody.value))}
      ${trustedHtml(card('Completion', 'C', '', html`<div class="progress"><span style="width:${trustedHtml(String(progress))}%"></span></div><div class="src-note">${done} of ${tasks.length} tasks done, ${blocked} blocked, ${running} running.</div>`.value))}
    </div>
    ${trustedHtml(card('Recent runs (latest 100)', 'R', html`<span class="pill">${String(runs.length)} runs</span>`.value, html`<div class="src-note">Latest 100 runs across this roadmap's full history; the head "spend (last 30d)" figure covers only the trailing 30-day analytics window.</div>${filterBox('rm-runs', 'Filter runs', runs.length)}${renderRunsTable(runs, 'rm-runs')}`.value))}`.value
}

function renderRoadmapDetailDocument(params: URLSearchParams): string {
  const id = (params.get('id') || '').trim()
  const statusFilter = (params.get('status') || '').trim() || undefined
  let detail: ReturnType<typeof getRoadmapDetailData> = { roadmap: undefined, tasks: [], dependencies: [], runs: [] }
  let summary: AnalyticsSummary | undefined
  try {
    detail = getRoadmapDetailData(id)
    if (detail.roadmap) summary = buildAnalyticsSummary({ roadmapId: id, by: 'agent' })
  } catch {
    detail = { roadmap: undefined, tasks: [], dependencies: [], runs: [] }
  }
  const body = renderRoadmapDetailView({ id, roadmap: detail.roadmap, tasks: detail.tasks, dependencies: detail.dependencies, runs: detail.runs, summary, statusFilter })
  return renderDetailDocument({
    route: 'roadmap',
    title: `Gateway Mission Control - ${detail.roadmap?.title || 'Roadmap'}`,
    breadcrumb: breadcrumbTrail([{ label: 'Mission Control', href: '/dashboard' }, { label: 'Work Graph', href: '/dashboard#/work-graph' }, { label: detail.roadmap?.title || id || 'Roadmap' }]),
    body: trustedHtml(body),
  })
}

// ---- Task detail ----------------------------------------------------------

export function renderTaskDetailView(input: {
  id: string
  task?: any
  roadmap?: any
  dependencies: TaskDependencyRef[]
  dependents: TaskDependencyRef[]
  gates: any[]
  runs: RunRecord[]
}): string {
  const { id, task, roadmap, dependencies, dependents, gates, runs } = input
  if (!task) {
    return html`<div class="view-head"><div><h1 class="page-h">Task not found</h1><p class="page-sub">No task with id ${id || '(none)'} is in the durable store.</p></div></div><p class="empty">It may have been archived or deleted. <a class="detail-link" href="/dashboard">Return to Mission Control.</a></p>`.value
  }
  const readiness = task.readiness
  const depBody = dependencies.length
    ? html`<div class="lane">${dependencies.map(dep =>
        html`<div class="row compact"><span class="dot ${trustedHtml(taskDotClass(dep.status))}"></span><div><div class="title"><a class="detail-link" href="/dashboard?view=task&id=${encodeURIComponent(dep.id)}">${dep.title || dep.id}</a></div><div class="meta">${dep.status || '?'} / ${dep.type || 'depends-on'} / ${shortId(dep.id)}</div></div></div>`)}</div>`
    : html`<p class="empty good">No upstream dependencies.</p>`
  const dependentBody = dependents.length
    ? html`<div class="lane">${dependents.map(dep =>
        html`<div class="row compact"><span class="dot ${trustedHtml(taskDotClass(dep.status))}"></span><div><div class="title"><a class="detail-link" href="/dashboard?view=task&id=${encodeURIComponent(dep.id)}">${dep.title || dep.id}</a></div><div class="meta">${dep.status || '?'} / ${shortId(dep.id)}</div></div></div>`)}</div>`
    : html`<p class="empty">Nothing depends on this task.</p>`
  const gatesBody = gates.length
    ? html`<div class="lane">${gates.map(gate =>
        html`<div class="row compact"><span class="dot ${trustedHtml(gate.status === 'approved' ? 'done' : gate.status === 'pending' ? 'pending' : 'blocked')}"></span><div><div class="title">${gate.type || 'gate'}</div><div class="meta">${gate.status || '?'} / ${gate.reason || ''}</div></div><span class="pill ${gate.status === 'approved' ? 'good' : gate.status === 'pending' ? 'warn' : 'bad'}">${gate.status || '?'}</span></div>`)}</div>`
    : html`<p class="empty good">No human gates on this task.</p>`
  return html`<div class="view-head"><div><h1 class="page-h">${task.title || task.id}</h1><p class="page-sub">Task ${shortId(task.id)}${roadmap ? html` in <a class="detail-link" href="/dashboard?view=roadmap&id=${encodeURIComponent(roadmap.id)}">${roadmap.title || roadmap.id}</a>` : ''}.</p></div><div class="head-figs">${trustedHtml(headFig(String(task.status || '?'), 'status'))}${trustedHtml(headFig(String(runs.length), 'runs'))}${trustedHtml(headFig(String(dependencies.length), 'deps'))}</div></div>
    ${kvGrid([
      { k: 'Status', v: html`<span class="pill ${task.status === 'blocked' || task.status === 'paused' ? 'bad' : task.status === 'running' ? 'warn' : 'good'}">${task.status || '?'}</span>` },
      { k: 'Priority', v: String(task.priority || '--') },
      { k: 'Stage', v: String(task.currentStage || task.lastRun?.stage || '--') },
      { k: 'Team', v: String(task.agentTeam || task.effectiveAgentTeam || '--') },
      { k: 'Readiness', v: String(readiness?.status || '--') },
      { k: 'Reason', v: String(readiness?.reason || '--') },
    ])}
    ${task.description ? trustedHtml(card('Description', 'i', '', html`<div class="result-block">${task.description}</div>`.value)) : ''}
    <div class="grid-2">
      ${trustedHtml(card('Depends On', 'D', html`<span class="pill">${String(dependencies.length)}</span>`.value, depBody.value))}
      ${trustedHtml(card('Blocks', 'B', html`<span class="pill">${String(dependents.length)}</span>`.value, dependentBody.value))}
    </div>
    ${trustedHtml(card('Human Gates', 'G', html`<span class="pill ${gates.length ? 'warn' : 'good'}">${String(gates.length)}</span>`.value, gatesBody.value))}
    ${trustedHtml(card('Run History', 'R', html`<span class="pill">${String(runs.length)} runs</span>`.value, html`${filterBox('task-runs', 'Filter runs', runs.length)}${renderRunsTable(runs, 'task-runs')}`.value))}`.value
}

function renderTaskDetailDocument(params: URLSearchParams): string {
  const id = (params.get('id') || '').trim()
  let detail: ReturnType<typeof getTaskDetailData> = { task: undefined, dependencies: [], dependents: [], gates: [], runs: [] }
  try {
    detail = getTaskDetailData(id)
  } catch {
    detail = { task: undefined, dependencies: [], dependents: [], gates: [], runs: [] }
  }
  const roadmap = detail.roadmap
  const body = renderTaskDetailView({ id, task: detail.task, roadmap, dependencies: detail.dependencies, dependents: detail.dependents, gates: detail.gates, runs: detail.runs })
  return renderDetailDocument({
    route: 'task',
    title: `Gateway Mission Control - ${detail.task?.title || 'Task'}`,
    breadcrumb: breadcrumbTrail([
      { label: 'Mission Control', href: '/dashboard' },
      ...(roadmap ? [{ label: roadmap.title || roadmap.id, href: `/dashboard?view=roadmap&id=${encodeURIComponent(roadmap.id)}` }] : []),
      { label: detail.task?.title || id || 'Task' },
    ]),
    body: trustedHtml(body),
  })
}

// ---- Run detail -----------------------------------------------------------

export function renderRunDetailView(input: { id: string; run?: RunRecord }): string {
  const { id, run } = input
  if (!run) {
    return html`<div class="view-head"><div><h1 class="page-h">Run not found</h1><p class="page-sub">No run with id ${id || '(none)'} is in the durable store.</p></div></div><p class="empty">It may have been pruned. <a class="detail-link" href="/dashboard">Return to Mission Control.</a></p>`.value
  }
  const result = run.result
  const tokens = tokenTotal(run)
  return html`<div class="view-head"><div><h1 class="page-h">Run ${shortId(run.id)}</h1><p class="page-sub">Stage ${run.stage || '?'} / attempt ${String(run.attempt ?? 0)} / <a class="detail-link" href="/dashboard?view=task&id=${encodeURIComponent(run.taskId)}">task ${shortId(run.taskId)}</a>.</p></div><div class="head-figs">${trustedHtml(headFig(fmtMoney(run.costUsd || 0), 'cost'))}${trustedHtml(headFig(compactNumber(tokens), 'tokens'))}${trustedHtml(headFig(fmtDuration(run.runtimeMs || 0), 'runtime'))}</div></div>
    ${kvGrid([
      { k: 'Status', v: html`<span class="pill ${trustedHtml(runStatusClass(run.status))}">${run.status || '?'}</span>` },
      { k: 'Attempt', v: String(run.attempt ?? 0) },
      { k: 'Profile', v: String(run.resolvedProfile || run.profile || '--') },
      { k: 'Agent', v: String(run.resolvedAgent || '--') },
      { k: 'Team', v: String(run.agentTeam || '--') },
      { k: 'Session', v: shortId(run.sessionId) },
      { k: 'Started', v: run.startedAt ? formatDateTime(run.startedAt) : '--' },
      { k: 'Completed', v: run.completedAt ? formatDateTime(run.completedAt) : '--' },
    ])}
    ${kvGrid([
      { k: 'Cost', v: fmtMoney(run.costUsd || 0) },
      { k: 'Input tokens', v: compactNumber(run.inputTokens || 0) },
      { k: 'Output tokens', v: compactNumber(run.outputTokens || 0) },
      { k: 'Reasoning tokens', v: compactNumber(run.reasoningTokens || 0) },
      { k: 'Runtime', v: fmtDuration(run.runtimeMs || 0) },
    ])}
    ${result ? trustedHtml(card('Result', 'R', html`<span class="pill ${result.status === 'pass' ? 'good' : result.status === 'blocked' ? 'warn' : 'bad'}">${result.status || '?'}</span>`.value, html`<div class="src-note">${result.summary || 'No summary.'}${result.failureClass ? ` / failure: ${result.failureClass}` : ''}</div>${result.feedback ? html`<div class="result-block">${result.feedback}</div>` : ''}${result.raw ? html`<div class="result-block">${result.raw}</div>` : ''}`.value)) : trustedHtml(card('Result', 'R', '', html`<p class="empty">No result recorded for this run.</p>`.value))}`.value
}

function renderRunDetailDocument(params: URLSearchParams): string {
  const id = (params.get('id') || '').trim()
  let run: RunRecord | undefined
  try {
    run = getRunDetailData(id).run
  } catch {
    run = undefined
  }
  const body = renderRunDetailView({ id, run })
  return renderDetailDocument({
    route: 'run',
    title: `Gateway Mission Control - Run ${run ? shortId(run.id) : 'detail'}`,
    breadcrumb: breadcrumbTrail([
      { label: 'Mission Control', href: '/dashboard' },
      ...(run ? [{ label: `task ${shortId(run.taskId)}`, href: `/dashboard?view=task&id=${encodeURIComponent(run.taskId)}` }] : []),
      { label: run ? `run ${shortId(run.id)}` : 'Run' },
    ]),
    body: trustedHtml(body),
  })
}

function taskDotClass(status: string | undefined): string {
  const value = String(status || '')
  return ['running', 'pending', 'done', 'blocked', 'paused', 'passed', 'failed', 'errored'].includes(value) ? value : ''
}

/**
 * Map a task priority to a fixed CSS class token. Whitelisting at the output
 * sink keeps the class attribute safe regardless of the stored value, rather
 * than relying on an upstream enum invariant holding forever.
 */
function priorityClass(priority: string | undefined): 'high' | 'medium' | 'low' {
  const value = String(priority || '').toLowerCase()
  return value === 'high' || value === 'medium' || value === 'low' ? value : 'low'
}

export { renderAnalyticsDocument, renderRoadmapDetailDocument, renderTaskDetailDocument, renderRunDetailDocument }
