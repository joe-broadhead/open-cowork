import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  OperationsAction,
  OperationsQueueStatus,
  OperationsSummary,
  OperationsWorkItem,
  WorkLedgerDrilldownRoute,
} from '@open-cowork/shared'
import { t } from '../../helpers/i18n'
import {
  OPERATIONS_SAVED_FILTERS,
  readOperationsPreference,
  writeOperationsPreference,
  type OperationsSavedFilterId,
  type OperationsViewMode,
} from './operations-ui'

const EMPTY_OPERATIONS_SUMMARY: OperationsSummary = {
  schemaVersion: 1,
  generatedAt: new Date(0).toISOString(),
  totalWorkItems: 0,
  needsAttention: 0,
  running: 0,
  failed: 0,
  delivered: 0,
  queue: [
    { status: 'needs_review', label: 'Needs review', count: 0 },
    { status: 'waiting_on_user', label: 'Waiting on user', count: 0 },
    { status: 'running', label: 'Running', count: 0 },
    { status: 'blocked', label: 'Blocked', count: 0 },
    { status: 'failed', label: 'Failed', count: 0 },
    { status: 'delivered', label: 'Delivered', count: 0 },
    { status: 'quiet_paused', label: 'Quiet / paused', count: 0 },
  ],
  items: [],
  healthSignals: [],
}

type OperationsSort = 'status' | 'updated_desc' | 'title_asc'
const STATUS_RANK: Record<OperationsQueueStatus, number> = {
  needs_review: 0,
  waiting_on_user: 1,
  blocked: 2,
  failed: 3,
  running: 4,
  delivered: 5,
  quiet_paused: 6,
}

export type OperationsPageProps = {
  onOpenThread: (sessionId: string) => void
  onOpenRoute: (route: WorkLedgerDrilldownRoute) => void
  onOpenDiagnostics: () => void
}

function statusLabel(value: string) {
  return value.replaceAll('_', ' ')
}

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}

function searchHaystack(item: OperationsWorkItem) {
  return [
    item.title,
    item.summary,
    item.sourceLabel,
    item.owner,
    item.sourceKind,
    item.status,
    item.queueStatus,
    ...item.agents,
    ...item.capabilities,
    ...item.riskLabels,
    ...item.governanceLabels,
  ].filter(Boolean).join(' ').toLowerCase()
}

function sortItems(items: OperationsWorkItem[], sort: OperationsSort) {
  return [...items].sort((left, right) => {
    if (sort === 'title_asc') return left.title.localeCompare(right.title) || left.id.localeCompare(right.id)
    if (sort === 'updated_desc') return Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id.localeCompare(right.id)
    return STATUS_RANK[left.queueStatus] - STATUS_RANK[right.queueStatus] || Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id.localeCompare(right.id)
  })
}

function ActionButton({
  action,
  onRun,
  busy,
}: {
  action: OperationsAction
  onRun: (action: OperationsAction) => void
  busy: boolean
}) {
  return (
    <button
      type="button"
      disabled={busy || !action.supported}
      title={action.disabledReason || action.label}
      onClick={() => onRun(action)}
      className={`rounded-md border px-2 py-1 text-[11px] transition-colors ${action.destructive ? 'border-red-400/30 text-red-100 hover:bg-red-500/10' : 'border-border-subtle text-text-secondary hover:bg-surface-hover hover:text-text'} disabled:cursor-not-allowed disabled:opacity-50`}
    >
      {action.label}
    </button>
  )
}

function StatusPill({ status }: { status: OperationsQueueStatus }) {
  const tone = status === 'failed'
    ? 'border-red-400/25 bg-red-500/10 text-red-100'
    : status === 'blocked' || status === 'waiting_on_user' || status === 'needs_review'
      ? 'border-amber-400/25 bg-amber-500/10 text-amber-100'
      : status === 'running'
        ? 'border-blue-400/25 bg-blue-500/10 text-blue-100'
        : status === 'delivered'
          ? 'border-emerald-400/25 bg-emerald-500/10 text-emerald-100'
          : 'border-border-subtle bg-surface text-text-muted'
  return (
    <span className={`inline-flex rounded px-1.5 py-0.5 text-[10px] uppercase tracking-[0.04em] ${tone}`}>
      {statusLabel(status)}
    </span>
  )
}

function SummaryCard({ label, value, detail }: { label: string; value: string | number; detail: string }) {
  return (
    <div className="min-w-0 border-e border-border-subtle px-4 py-3 last:border-e-0">
      <div className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">{label}</div>
      <div className="mt-1 text-[22px] font-semibold text-text">{value}</div>
      <div className="mt-0.5 truncate text-[11px] text-text-muted">{detail}</div>
    </div>
  )
}

function WorkRow({
  item,
  viewMode,
  onOpen,
  onRunAction,
  busyActionId,
}: {
  item: OperationsWorkItem
  viewMode: OperationsViewMode
  onOpen: (item: OperationsWorkItem) => void
  onRunAction: (action: OperationsAction) => void
  busyActionId: string | null
}) {
  const actions = item.actions.slice(0, 4)
  if (viewMode === 'list') {
    return (
      <article className="border-b border-border-subtle px-4 py-3 hover:bg-surface-hover">
        <div className="flex min-w-0 items-start justify-between gap-4">
          <button type="button" onClick={() => onOpen(item)} className="min-w-0 flex-1 text-start">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-[14px] font-medium text-text">{item.title}</span>
              <StatusPill status={item.queueStatus} />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-text-muted">
              <span>{item.sourceLabel}</span>
              <span>{statusLabel(item.sourceKind)}</span>
              <span>{item.owner || 'Local workspace'}</span>
              {item.agents[0] ? <span>Agent: {item.agents[0]}</span> : null}
              {item.capabilities[0] ? <span>Capability: {item.capabilities[0]}</span> : null}
            </div>
            {item.summary ? <p className="mt-2 line-clamp-2 text-[12px] text-text-secondary">{item.summary}</p> : null}
          </button>
          <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
            {actions.map((action) => (
              <ActionButton key={action.id} action={action} busy={busyActionId === action.id} onRun={onRunAction} />
            ))}
          </div>
        </div>
      </article>
    )
  }
  return (
    <div className="grid grid-cols-[minmax(260px,1.4fr)_142px_160px_130px_130px_210px] items-center gap-3 border-b border-border-subtle px-3 py-2.5 text-[12px] hover:bg-surface-hover">
      <button type="button" onClick={() => onOpen(item)} className="min-w-0 text-start">
        <span className="block truncate text-[13px] font-medium text-text">{item.title}</span>
        <span className="mt-1 block truncate text-[11px] text-text-muted">{item.sourceLabel} · {statusLabel(item.sourceKind)}</span>
      </button>
      <StatusPill status={item.queueStatus} />
      <span className="truncate text-text-secondary">{item.owner || 'Local workspace'}</span>
      <span className="truncate text-text-secondary">{item.agents[0] || item.capabilities[0] || '-'}</span>
      <span className="text-text-muted">{formatDate(item.updatedAt)}</span>
      <div className="flex flex-wrap justify-end gap-1.5">
        {actions.map((action) => (
          <ActionButton key={action.id} action={action} busy={busyActionId === action.id} onRun={onRunAction} />
        ))}
      </div>
    </div>
  )
}

export function OperationsPage({ onOpenThread, onOpenRoute, onOpenDiagnostics }: OperationsPageProps) {
  const preference = useMemo(() => readOperationsPreference(), [])
  const [summary, setSummary] = useState<OperationsSummary>(EMPTY_OPERATIONS_SUMMARY)
  const [savedFilter, setSavedFilter] = useState<OperationsSavedFilterId>(preference.savedFilter || 'attention')
  const [viewMode, setViewMode] = useState<OperationsViewMode>(preference.viewMode || 'table')
  const [activeStatus, setActiveStatus] = useState<OperationsQueueStatus | 'all'>('all')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<OperationsSort>('status')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyActionId, setBusyActionId] = useState<string | null>(null)

  const loadSummary = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setError(null)
    try {
      setSummary(await window.coworkApi.operations.summary())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadSummary()
    const refresh = () => void loadSummary(true)
    const unsubscribeAutomation = window.coworkApi.on.automationUpdated(refresh)
    const unsubscribeSessionPatch = window.coworkApi.on.sessionPatch(refresh)
    const unsubscribeSessionUpdated = window.coworkApi.on.sessionUpdated(refresh)
    const unsubscribeDashboardUpdated = window.coworkApi.on.dashboardSummaryUpdated(refresh)
    const interval = window.setInterval(refresh, 15000)
    window.addEventListener('focus', refresh)
    return () => {
      unsubscribeAutomation()
      unsubscribeSessionPatch()
      unsubscribeSessionUpdated()
      unsubscribeDashboardUpdated()
      window.clearInterval(interval)
      window.removeEventListener('focus', refresh)
    }
  }, [loadSummary])

  useEffect(() => {
    writeOperationsPreference({ savedFilter, viewMode })
  }, [savedFilter, viewMode])

  const selectedSavedFilter = OPERATIONS_SAVED_FILTERS.find((filter) => filter.id === savedFilter) || OPERATIONS_SAVED_FILTERS[0]!
  const filteredItems = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return sortItems(summary.items.filter((item) => {
      if (activeStatus !== 'all' && item.queueStatus !== activeStatus) return false
      if (selectedSavedFilter.statuses?.length && !selectedSavedFilter.statuses.includes(item.queueStatus)) return false
      if (normalized && !searchHaystack(item).includes(normalized)) return false
      return true
    }), sort)
  }, [activeStatus, query, selectedSavedFilter, sort, summary.items])

  const openItem = useCallback((item: OperationsWorkItem) => {
    if (item.route.sessionId) {
      onOpenThread(item.route.sessionId)
      return
    }
    onOpenRoute(item.route)
  }, [onOpenRoute, onOpenThread])

  const runAction = useCallback(async (action: OperationsAction) => {
    if (!action.supported) return
    if (action.kind === 'open_source') {
      const route = action.target.route
      if (route.sessionId) onOpenThread(route.sessionId)
      else onOpenRoute(route)
      return
    }
    if (action.destructive && !window.confirm(`${action.label}?`)) return
    setBusyActionId(action.id)
    setError(null)
    try {
      if (action.kind === 'pause_automation' && action.target.automationId) {
        await window.coworkApi.automation.pause(action.target.automationId)
      } else if (action.kind === 'resume_automation' && action.target.automationId) {
        await window.coworkApi.automation.resume(action.target.automationId)
      } else if (action.kind === 'retry_automation_run' && action.target.automationRunId) {
        await window.coworkApi.automation.retryRun(action.target.automationRunId)
      } else if (action.kind === 'cancel_automation_run' && action.target.automationRunId) {
        await window.coworkApi.automation.cancelRun(action.target.automationRunId)
      }
      await loadSummary(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyActionId(null)
    }
  }, [loadSummary, onOpenRoute, onOpenThread])

  return (
    <div className="flex h-full min-h-0 flex-col bg-base text-text">
      <header className="border-b border-border-subtle">
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="min-w-0">
            <h1 className="truncate text-[18px] font-semibold text-text">{t('operations.title', 'Operations')}</h1>
            <div className="mt-0.5 text-[11px] text-text-muted">{loading ? 'Loading...' : `Updated ${formatDate(summary.generatedAt)}`}</div>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void loadSummary()} className="rounded-md border border-border-subtle px-3 py-2 text-[12px] text-text-secondary hover:bg-surface-hover hover:text-text">Refresh</button>
            <button type="button" onClick={onOpenDiagnostics} className="rounded-md border border-border-subtle px-3 py-2 text-[12px] text-text-secondary hover:bg-surface-hover hover:text-text">Diagnostics</button>
          </div>
        </div>
        <div className="grid grid-cols-4 border-t border-border-subtle">
          <SummaryCard label="Needs attention" value={summary.needsAttention} detail={`${summary.failed} failed`} />
          <SummaryCard label="Running" value={summary.running} detail={`${summary.totalWorkItems} total rows`} />
          <SummaryCard label="Delivered" value={summary.delivered} detail="Completed outputs" />
          <SummaryCard label="Risk signals" value={summary.healthSignals.length} detail="Queue, capability, governance" />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[280px] shrink-0 flex-col border-e border-border-subtle">
          <section className="border-b border-border-subtle px-3 py-3">
            <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-text-muted">Saved filters</h2>
            <div className="flex flex-col gap-1">
              {OPERATIONS_SAVED_FILTERS.map((filter) => (
                <button
                  key={filter.id}
                  type="button"
                  aria-pressed={savedFilter === filter.id}
                  onClick={() => setSavedFilter(filter.id)}
                  className={`rounded-md px-2 py-1.5 text-start text-[12px] ${savedFilter === filter.id ? 'bg-surface-active text-text' : 'text-text-secondary hover:bg-surface-hover hover:text-text'}`}
                >
                  {filter.label}
                </button>
              ))}
            </div>
          </section>
          <section className="min-h-0 flex-1 overflow-y-auto border-b border-border-subtle px-3 py-3">
            <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-text-muted">Status lanes</h2>
            <div className="flex flex-col gap-1">
              <button
                type="button"
                aria-pressed={activeStatus === 'all'}
                onClick={() => setActiveStatus('all')}
                className={`flex items-center justify-between rounded-md px-2 py-1.5 text-[12px] ${activeStatus === 'all' ? 'bg-surface-active text-text' : 'text-text-secondary hover:bg-surface-hover hover:text-text'}`}
              >
                <span>All lanes</span><span className="text-[10px] text-text-muted">{summary.totalWorkItems}</span>
              </button>
              {summary.queue.map((lane) => (
                <button
                  key={lane.status}
                  type="button"
                  aria-pressed={activeStatus === lane.status}
                  onClick={() => setActiveStatus(lane.status)}
                  className={`flex items-center justify-between rounded-md px-2 py-1.5 text-[12px] ${activeStatus === lane.status ? 'bg-surface-active text-text' : 'text-text-secondary hover:bg-surface-hover hover:text-text'}`}
                >
                  <span>{lane.label}</span><span className="text-[10px] text-text-muted">{lane.count}</span>
                </button>
              ))}
            </div>
          </section>
          <section className="px-3 py-3">
            <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-text-muted">Health</h2>
            <div className="flex flex-col gap-2">
              {summary.healthSignals.slice(0, 6).map((signal) => (
                <div key={signal.id} className="rounded-md border border-border-subtle bg-surface px-2 py-2">
                  <div className={`text-[11px] font-medium ${signal.severity === 'critical' ? 'text-red-100' : 'text-amber-100'}`}>{signal.title}</div>
                  <div className="mt-1 line-clamp-2 text-[11px] text-text-muted">{signal.message}</div>
                </div>
              ))}
              {summary.healthSignals.length === 0 ? <div className="text-[12px] text-text-muted">No active health signals.</div> : null}
            </div>
          </section>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          <div className="border-b border-border-subtle px-4 py-3">
            <div className="flex items-center gap-2">
              <label htmlFor="operations-search" className="sr-only">Search operations</label>
              <input
                id="operations-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search work, owners, agents, capabilities, and risk labels"
                className="min-w-0 flex-1 rounded-md border border-border-subtle bg-base px-3 py-2 text-[13px] text-text outline-none focus:border-accent"
              />
              <label htmlFor="operations-sort" className="sr-only">Sort operations</label>
              <select
                id="operations-sort"
                value={sort}
                onChange={(event) => setSort(event.target.value as OperationsSort)}
                className="rounded-md border border-border-subtle bg-base px-2 py-2 text-[12px] text-text"
              >
                <option value="status">Status priority</option>
                <option value="updated_desc">Recently updated</option>
                <option value="title_asc">Title A-Z</option>
              </select>
              <div className="grid grid-cols-2 gap-1 rounded-md border border-border-subtle bg-surface p-1">
                <button type="button" aria-pressed={viewMode === 'table'} onClick={() => setViewMode('table')} className={`rounded px-2 py-1.5 text-[11px] ${viewMode === 'table' ? 'bg-base text-text' : 'text-text-muted hover:text-text'}`}>Table</button>
                <button type="button" aria-pressed={viewMode === 'list'} onClick={() => setViewMode('list')} className={`rounded px-2 py-1.5 text-[11px] ${viewMode === 'list' ? 'bg-base text-text' : 'text-text-muted hover:text-text'}`}>List</button>
              </div>
            </div>
            <div className="mt-2 text-[11px] text-text-muted">{filteredItems.length} visible rows</div>
          </div>
          {error ? <div role="alert" className="border-b border-red-400/30 bg-red-500/10 px-4 py-2 text-[12px] text-red-100">{error}</div> : null}
          {viewMode === 'table' ? (
            <div className="grid grid-cols-[minmax(260px,1.4fr)_142px_160px_130px_130px_210px] gap-3 border-b border-border-subtle px-3 py-2 text-[10px] font-semibold uppercase tracking-widest text-text-muted">
              <span>Work</span>
              <span>Status</span>
              <span>Owner</span>
              <span>Agent / capability</span>
              <span>Updated</span>
              <span className="text-end">Actions</span>
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-auto">
            {filteredItems.length ? filteredItems.map((item) => (
              <WorkRow
                key={item.id}
                item={item}
                viewMode={viewMode}
                onOpen={openItem}
                onRunAction={runAction}
                busyActionId={busyActionId}
              />
            )) : (
              <div className="p-8 text-center text-[13px] text-text-muted">
                {loading ? 'Loading operations...' : 'No work matches this filter.'}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
