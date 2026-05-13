import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  WorkLedgerDrilldownRoute,
  WorkLedgerEntry,
  WorkLedgerFacetBucket,
  WorkLedgerFacetSummary,
  WorkLedgerReviewState,
  WorkLedgerSearchQuery,
  WorkLedgerSort,
  WorkLedgerSourceKind,
  WorkLedgerStatus,
} from '@open-cowork/shared'
import { t } from '../../helpers/i18n'

const WORK_SOURCE_OPTIONS: Array<{ value: WorkLedgerSourceKind; label: string }> = [
  { value: 'thread', label: 'Threads' },
  { value: 'automation', label: 'Automations' },
  { value: 'automation_run', label: 'Automation runs' },
  { value: 'crew', label: 'Crews' },
  { value: 'crew_run', label: 'Crew runs' },
  { value: 'delegated_task', label: 'Delegated tasks' },
  { value: 'approval', label: 'Approvals' },
  { value: 'question', label: 'Questions' },
  { value: 'delivery', label: 'Deliveries' },
  { value: 'channel_event', label: 'Channel events' },
  { value: 'governance_incident', label: 'Incidents' },
]

const WORK_REVIEW_OPTIONS: Array<{ value: WorkLedgerReviewState; label: string }> = [
  { value: 'needs_review', label: 'Needs review' },
  { value: 'approval_requested', label: 'Approval requested' },
  { value: 'failed', label: 'Failed' },
  { value: 'denied', label: 'Denied' },
  { value: 'approved', label: 'Approved' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'none', label: 'No review' },
]

const EMPTY_LEDGER_FACETS: WorkLedgerFacetSummary = {
  sourceKinds: [],
  statuses: [],
  owners: [],
  agents: [],
  capabilities: [],
  riskLabels: [],
  governanceLabels: [],
  reviewStates: [],
}

type Surface = 'threads' | 'work-ledger'

type WorkLedgerQueryState = {
  text: string
  sort: WorkLedgerSort
  dateRange?: WorkLedgerSearchQuery['dateRange']
  sourceKinds: WorkLedgerSourceKind[]
  statuses: WorkLedgerStatus[]
  owners: string[]
  agents: string[]
  capabilities: string[]
  riskLabels: string[]
  governanceLabels: string[]
  reviewStates: WorkLedgerReviewState[]
  needsUserAttention: boolean | null
}

export type WorkLedgerViewProps = {
  activeSurface: Surface
  onSurfaceChange: (surface: Surface) => void
  onOpenThread: (sessionId: string) => void
  onOpenRoute?: (route: WorkLedgerDrilldownRoute) => void
}

function ledgerQueryFromState(state: WorkLedgerQueryState, cursor?: string | null): WorkLedgerSearchQuery {
  return {
    text: state.text || undefined,
    cursor: cursor || null,
    limit: 50,
    sort: state.sort,
    dateRange: state.dateRange,
    sourceKinds: state.sourceKinds.length ? state.sourceKinds : undefined,
    statuses: state.statuses.length ? state.statuses : undefined,
    owners: state.owners.length ? state.owners : undefined,
    agents: state.agents.length ? state.agents : undefined,
    capabilities: state.capabilities.length ? state.capabilities : undefined,
    riskLabels: state.riskLabels.length ? state.riskLabels : undefined,
    governanceLabels: state.governanceLabels.length ? state.governanceLabels : undefined,
    reviewStates: state.reviewStates.length ? state.reviewStates : undefined,
    needsUserAttention: state.needsUserAttention,
  }
}

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}

function daysAgoIso(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

function isRecentRange(range: WorkLedgerSearchQuery['dateRange'], days: number) {
  if (!range?.from || range.to) return false
  const from = new Date(range.from).getTime()
  if (!Number.isFinite(from)) return false
  const expected = Date.now() - days * 24 * 60 * 60 * 1000
  return Math.abs(from - expected) < 60_000
}

function money(value: number) {
  if (!value) return '$0.00'
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(value)
}

function toggleValue<T extends string>(values: T[], value: T) {
  return values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value]
}

function statusLabel(value: string) {
  return value.replaceAll('_', ' ')
}

function hasLedgerFilters(state: WorkLedgerQueryState) {
  return Boolean(
    state.text
    || state.dateRange
    || state.sourceKinds.length
    || state.statuses.length
    || state.owners.length
    || state.agents.length
    || state.capabilities.length
    || state.riskLabels.length
    || state.governanceLabels.length
    || state.reviewStates.length
    || state.needsUserAttention !== null,
  )
}

function SurfaceSwitcher({
  active,
  onChange,
}: {
  active: Surface
  onChange: (surface: Surface) => void
}) {
  return (
    <div className="mt-3 grid grid-cols-2 gap-1 rounded-md border border-border-subtle bg-surface p-1">
      <button
        type="button"
        aria-pressed={active === 'threads'}
        onClick={() => onChange('threads')}
        className={`rounded px-2 py-1.5 text-[11px] font-medium ${active === 'threads' ? 'bg-base text-text shadow-sm' : 'text-text-muted hover:text-text'}`}
      >
        Threads
      </button>
      <button
        type="button"
        aria-pressed={active === 'work-ledger'}
        onClick={() => onChange('work-ledger')}
        className={`rounded px-2 py-1.5 text-[11px] font-medium ${active === 'work-ledger' ? 'bg-base text-text shadow-sm' : 'text-text-muted hover:text-text'}`}
      >
        Work ledger
      </button>
    </div>
  )
}

function FacetButton({
  bucket,
  selected,
  onClick,
}: {
  bucket: WorkLedgerFacetBucket
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`${bucket.label} (${bucket.count})`}
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-[12px] transition-colors ${selected ? 'bg-surface-active text-text' : 'text-text-secondary hover:bg-surface-hover hover:text-text'}`}
    >
      <span className="min-w-0 flex-1 truncate">{bucket.label}</span>
      <span className="shrink-0 text-[10px] text-text-muted">{bucket.count}</span>
    </button>
  )
}

function FacetGroup({
  title,
  buckets,
  selected,
  onToggle,
}: {
  title: string
  buckets: WorkLedgerFacetBucket[]
  selected: string[]
  onToggle: (value: string) => void
}) {
  if (buckets.length === 0) return null
  return (
    <section className="border-b border-border-subtle px-3 py-3">
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-text-muted">{title}</h3>
      <div className="flex flex-col gap-1">
        {buckets.slice(0, 12).map((bucket) => (
          <FacetButton
            key={bucket.value}
            bucket={bucket}
            selected={selected.includes(bucket.value)}
            onClick={() => onToggle(bucket.value)}
          />
        ))}
      </div>
    </section>
  )
}

function OptionFacet<T extends string>({
  title,
  selected,
  buckets,
  options,
  onToggle,
}: {
  title: string
  selected: T[]
  buckets: WorkLedgerFacetBucket[]
  options: Array<{ value: T; label: string }>
  onToggle: (value: T) => void
}) {
  const counts = new Map(buckets.map((bucket) => [bucket.value, bucket.count]))
  return (
    <section className="border-b border-border-subtle px-3 py-3">
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-text-muted">{title}</h3>
      <div className="flex flex-col gap-1">
        {options.map((option) => (
          <FacetButton
            key={option.value}
            bucket={{ value: option.value, label: option.label, count: counts.get(option.value) || 0 }}
            selected={selected.includes(option.value)}
            onClick={() => onToggle(option.value)}
          />
        ))}
      </div>
    </section>
  )
}

function DateFacet({
  range,
  onChange,
}: {
  range?: WorkLedgerSearchQuery['dateRange']
  onChange: (range?: WorkLedgerSearchQuery['dateRange']) => void
}) {
  const options = [
    { label: 'Any time', range: undefined, selected: !range },
    { label: 'Last 7 days', range: { from: daysAgoIso(7) }, selected: isRecentRange(range, 7) },
    { label: 'Last 30 days', range: { from: daysAgoIso(30) }, selected: isRecentRange(range, 30) },
  ]
  return (
    <section className="border-b border-border-subtle px-3 py-3">
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-text-muted">Date</h3>
      <div className="flex flex-col gap-1">
        {options.map((option) => (
          <button
            key={option.label}
            type="button"
            aria-pressed={option.selected}
            onClick={() => onChange(option.range)}
            className={`rounded-md px-2 py-1.5 text-start text-[12px] transition-colors ${option.selected ? 'bg-surface-active text-text' : 'text-text-secondary hover:bg-surface-hover hover:text-text'}`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </section>
  )
}

function WorkLedgerBadges({ entry }: { entry: WorkLedgerEntry }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {entry.agents.slice(0, 2).map((agent) => (
        <span key={agent} className="rounded bg-surface px-1.5 py-0.5 text-[10px] text-text-muted">Agent: {agent}</span>
      ))}
      {entry.capabilities.slice(0, 2).map((capability) => (
        <span key={capability} className="rounded bg-surface px-1.5 py-0.5 text-[10px] text-text-muted">Capability: {capability}</span>
      ))}
      {entry.riskLabels.slice(0, 2).map((label) => (
        <span key={label} className="rounded border border-red-400/25 px-1.5 py-0.5 text-[10px] text-red-200">Risk: {statusLabel(label)}</span>
      ))}
      {entry.governanceLabels.slice(0, 2).map((label) => (
        <span key={label} className="rounded border border-border-subtle px-1.5 py-0.5 text-[10px] text-text-muted">{statusLabel(label)}</span>
      ))}
    </div>
  )
}

function WorkLedgerRow({
  entry,
  selected,
  onSelect,
  onOpen,
}: {
  entry: WorkLedgerEntry
  selected: boolean
  onSelect: () => void
  onOpen: () => void
}) {
  return (
    <div
      role="row"
      className={`grid grid-cols-[minmax(240px,1.35fr)_150px_180px_150px_130px] items-center gap-3 border-b border-border-subtle px-3 py-2.5 text-[12px] transition-colors ${selected ? 'bg-surface-active/70' : 'hover:bg-surface-hover'}`}
    >
      <button type="button" onClick={onSelect} className="min-w-0 text-start">
        <span className="block truncate text-[13px] font-medium text-text">{entry.title}</span>
        <span className="mt-1 flex min-w-0 items-center gap-2 text-[11px] text-text-muted">
          <span className="truncate">{entry.sourceLabel}</span>
          <span aria-hidden="true">·</span>
          <span>{statusLabel(entry.sourceKind)}</span>
          {entry.usage.cost ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{money(entry.usage.cost)}</span>
            </>
          ) : null}
        </span>
        <div className="mt-1.5">
          <WorkLedgerBadges entry={entry} />
        </div>
      </button>
      <span className="truncate text-text-secondary">{entry.owner || 'Local workspace'}</span>
      <span className="truncate text-text-secondary">{entry.agents[0] || entry.capabilities[0] || '-'}</span>
      <div className="flex flex-wrap gap-1">
        <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-[0.04em] ${entry.needsUserAttention ? 'bg-amber-500/15 text-amber-200' : 'bg-surface text-text-muted'}`}>
          {statusLabel(entry.reviewState)}
        </span>
        <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] uppercase tracking-[0.04em] text-text-muted">{statusLabel(entry.status)}</span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-text-muted">{formatDate(entry.updatedAt)}</span>
        <button type="button" onClick={onOpen} className="rounded-md border border-border-subtle px-2 py-1 text-[11px] text-text-secondary hover:bg-surface-hover hover:text-text">
          Open
        </button>
      </div>
    </div>
  )
}

function WorkLedgerDetailDrawer({
  entry,
  onClose,
  onOpen,
}: {
  entry: WorkLedgerEntry | null
  onClose: () => void
  onOpen: (entry: WorkLedgerEntry) => void
}) {
  if (!entry) return null
  return (
    <aside aria-label="Work ledger detail" className="w-[360px] shrink-0 border-s border-border-subtle bg-base">
      <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
        <h2 className="min-w-0 truncate text-[14px] font-semibold text-text">{entry.title}</h2>
        <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-[12px] text-text-muted hover:bg-surface-hover">Close</button>
      </div>
      <div className="space-y-5 overflow-y-auto p-4 text-[12px] text-text-secondary">
        <section>
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-text-muted">Overview</h3>
          <div className="grid grid-cols-[112px_1fr] gap-x-3 gap-y-1">
            <span className="text-text-muted">Source</span><span>{statusLabel(entry.sourceKind)}</span>
            <span className="text-text-muted">Status</span><span>{statusLabel(entry.status)}</span>
            <span className="text-text-muted">Review</span><span>{statusLabel(entry.reviewState)}</span>
            <span className="text-text-muted">Updated</span><span>{formatDate(entry.updatedAt)}</span>
            <span className="text-text-muted">Owner</span><span>{entry.owner || 'Local workspace'}</span>
            <span className="text-text-muted">Cost</span><span>{money(entry.usage.cost)}</span>
          </div>
          {entry.summary ? <p className="mt-3 rounded-md bg-surface px-3 py-2 text-[12px] text-text-secondary">{entry.summary}</p> : null}
          <button type="button" onClick={() => onOpen(entry)} className="mt-3 w-full rounded-md border border-border-subtle px-3 py-2 text-[12px] text-text-secondary hover:bg-surface-hover hover:text-text">
            Open source
          </button>
        </section>
        <section>
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-text-muted">References</h3>
          <div className="grid grid-cols-[112px_1fr] gap-x-3 gap-y-1 break-all">
            <span className="text-text-muted">Source id</span><span>{entry.sourceId}</span>
            {entry.sourceRef.sessionId ? <><span className="text-text-muted">Session</span><span>{entry.sourceRef.sessionId}</span></> : null}
            {entry.sourceRef.automationId ? <><span className="text-text-muted">Automation</span><span>{entry.sourceRef.automationId}</span></> : null}
            {entry.sourceRef.crewId ? <><span className="text-text-muted">Crew</span><span>{entry.sourceRef.crewId}</span></> : null}
            {entry.sourceRef.channelId ? <><span className="text-text-muted">Channel</span><span>{entry.sourceRef.channelId}</span></> : null}
          </div>
        </section>
        <section>
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-text-muted">Indexed metadata</h3>
          <div className="flex flex-wrap gap-1.5">
            {entry.agents.map((agent) => <span key={agent} className="rounded bg-surface px-1.5 py-0.5 text-[10px]">Agent: {agent}</span>)}
            {entry.capabilities.map((capability) => <span key={capability} className="rounded bg-surface px-1.5 py-0.5 text-[10px]">Capability: {capability}</span>)}
            {entry.riskLabels.map((label) => <span key={label} className="rounded border border-red-400/25 px-1.5 py-0.5 text-[10px] text-red-200">Risk: {statusLabel(label)}</span>)}
            {entry.governanceLabels.map((label) => <span key={label} className="rounded border border-border-subtle px-1.5 py-0.5 text-[10px]">{statusLabel(label)}</span>)}
            {!entry.agents.length && !entry.capabilities.length && !entry.riskLabels.length && !entry.governanceLabels.length ? <span className="text-text-muted">No indexed agent, capability, risk, or governance labels.</span> : null}
          </div>
        </section>
      </div>
    </aside>
  )
}

export function WorkLedgerView({
  activeSurface,
  onSurfaceChange,
  onOpenThread,
  onOpenRoute,
}: WorkLedgerViewProps) {
  const [query, setQuery] = useState<WorkLedgerQueryState>({
    text: '',
    sort: 'updated_desc',
    dateRange: undefined,
    sourceKinds: [],
    statuses: [],
    owners: [],
    agents: [],
    capabilities: [],
    riskLabels: [],
    governanceLabels: [],
    reviewStates: [],
    needsUserAttention: null,
  })
  const [entries, setEntries] = useState<WorkLedgerEntry[]>([])
  const [facets, setFacets] = useState<WorkLedgerFacetSummary>(EMPTY_LEDGER_FACETS)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)

  const selectedEntry = useMemo(() => entries.find((entry) => entry.id === detailId) || null, [detailId, entries])

  const loadLedger = useCallback(async (cursor: string | null = null, append = false) => {
    setLoading(true)
    setError(null)
    try {
      const searchQuery = ledgerQueryFromState(query, cursor)
      const [result, facetResult] = await Promise.all([
        window.coworkApi.workLedger.search(searchQuery),
        window.coworkApi.workLedger.facets(searchQuery),
      ])
      setEntries((current) => append ? [...current, ...result.entries] : result.entries)
      setNextCursor(result.nextCursor)
      setTotal(result.totalEstimate)
      setFacets(facetResult)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [query])

  useEffect(() => {
    void loadLedger(null, false)
  }, [loadLedger])

  const reload = useCallback(() => {
    void loadLedger(null, false)
  }, [loadLedger])

  const openEntry = useCallback((entry: WorkLedgerEntry) => {
    if (entry.route.sessionId) {
      onOpenThread(entry.route.sessionId)
      return
    }
    onOpenRoute?.(entry.route)
  }, [onOpenRoute, onOpenThread])

  const resetQuery = () => setQuery({
    text: '',
    sort: 'updated_desc',
    dateRange: undefined,
    sourceKinds: [],
    statuses: [],
    owners: [],
    agents: [],
    capabilities: [],
    riskLabels: [],
    governanceLabels: [],
    reviewStates: [],
    needsUserAttention: null,
  })

  return (
    <div className="flex h-full min-h-0 bg-base text-text">
      <aside aria-label="Work ledger filters" className="flex w-[280px] shrink-0 flex-col border-e border-border-subtle bg-base">
        <div className="border-b border-border-subtle px-3 py-3">
          <div className="text-[15px] font-semibold text-text">{t('threads.workLedgerTitle', 'Work ledger')}</div>
          <div className="mt-1 text-[11px] text-text-muted">{t('threads.workLedgerSubtitle', 'Search sessions, runs, approvals, deliveries, channels, and incidents.')}</div>
          <SurfaceSwitcher active={activeSurface} onChange={onSurfaceChange} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <OptionFacet
            title="Source"
            selected={query.sourceKinds}
            buckets={facets.sourceKinds}
            options={WORK_SOURCE_OPTIONS}
            onToggle={(value) => setQuery((current) => ({ ...current, sourceKinds: toggleValue(current.sourceKinds, value) }))}
          />
          <OptionFacet
            title="Review"
            selected={query.reviewStates}
            buckets={facets.reviewStates}
            options={WORK_REVIEW_OPTIONS}
            onToggle={(value) => setQuery((current) => ({ ...current, reviewStates: toggleValue(current.reviewStates, value) }))}
          />
          <section className="border-b border-border-subtle px-3 py-3">
            <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-text-muted">Attention</h3>
            <button
              type="button"
              aria-pressed={query.needsUserAttention === true}
              onClick={() => setQuery((current) => ({ ...current, needsUserAttention: current.needsUserAttention === true ? null : true }))}
              className={`w-full rounded-md px-2 py-1.5 text-start text-[12px] transition-colors ${query.needsUserAttention === true ? 'bg-surface-active text-text' : 'text-text-secondary hover:bg-surface-hover hover:text-text'}`}
            >
              Needs user attention
            </button>
          </section>
          <DateFacet range={query.dateRange} onChange={(dateRange) => setQuery((current) => ({ ...current, dateRange }))} />
          <FacetGroup title="Statuses" buckets={facets.statuses} selected={query.statuses} onToggle={(value) => setQuery((current) => ({ ...current, statuses: toggleValue(current.statuses, value as WorkLedgerStatus) }))} />
          <FacetGroup title="Owners" buckets={facets.owners} selected={query.owners} onToggle={(value) => setQuery((current) => ({ ...current, owners: toggleValue(current.owners, value) }))} />
          <FacetGroup title="Agents" buckets={facets.agents} selected={query.agents} onToggle={(value) => setQuery((current) => ({ ...current, agents: toggleValue(current.agents, value) }))} />
          <FacetGroup title="Capabilities" buckets={facets.capabilities} selected={query.capabilities} onToggle={(value) => setQuery((current) => ({ ...current, capabilities: toggleValue(current.capabilities, value) }))} />
          <FacetGroup title="Risk" buckets={facets.riskLabels} selected={query.riskLabels} onToggle={(value) => setQuery((current) => ({ ...current, riskLabels: toggleValue(current.riskLabels, value) }))} />
          <FacetGroup title="Governance" buckets={facets.governanceLabels} selected={query.governanceLabels} onToggle={(value) => setQuery((current) => ({ ...current, governanceLabels: toggleValue(current.governanceLabels, value) }))} />
        </div>
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="border-b border-border-subtle px-4 py-3">
          <div className="flex items-center gap-2">
            <label className="sr-only" htmlFor="work-ledger-search">Search work ledger</label>
            <input
              id="work-ledger-search"
              value={query.text}
              onChange={(event) => setQuery((current) => ({ ...current, text: event.target.value }))}
              placeholder="Search work, sources, owners, agents, capabilities, risks, and governance labels"
              className="min-w-0 flex-1 rounded-md border border-border-subtle bg-base px-3 py-2 text-[13px] text-text outline-none focus:border-accent"
            />
            <label className="sr-only" htmlFor="work-ledger-sort">Sort work ledger</label>
            <select
              id="work-ledger-sort"
              value={query.sort}
              onChange={(event) => setQuery((current) => ({ ...current, sort: event.target.value as WorkLedgerSort }))}
              className="rounded-md border border-border-subtle bg-base px-2 py-2 text-[12px] text-text"
            >
              <option value="updated_desc">Recently updated</option>
              <option value="created_desc">Recently created</option>
              <option value="title_asc">Title A-Z</option>
            </select>
            <button type="button" onClick={reload} className="rounded-md border border-border-subtle px-3 py-2 text-[12px] text-text-secondary hover:bg-surface-hover">Refresh</button>
            {hasLedgerFilters(query) ? (
              <button type="button" onClick={resetQuery} className="rounded-md border border-border-subtle px-3 py-2 text-[12px] text-text-secondary hover:bg-surface-hover">
                Clear
              </button>
            ) : null}
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] text-text-muted">
            <span>{loading ? 'Loading...' : `${total} ledger entr${total === 1 ? 'y' : 'ies'}`}</span>
            <span>{query.needsUserAttention ? 'Filtered to work needing user attention.' : 'Rows link to their durable source records.'}</span>
          </div>
        </div>
        {error ? <div role="alert" className="border-b border-red-400/30 bg-red-500/10 px-4 py-2 text-[12px] text-red-100">{error}</div> : null}
        <div className="grid grid-cols-[minmax(240px,1.35fr)_150px_180px_150px_130px] gap-3 border-b border-border-subtle px-3 py-2 text-[10px] font-semibold uppercase tracking-widest text-text-muted">
          <span>Work</span>
          <span>Owner</span>
          <span>Agent / capability</span>
          <span>Review</span>
          <span>Updated</span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {entries.length ? entries.map((entry) => (
            <WorkLedgerRow
              key={entry.id}
              entry={entry}
              selected={entry.id === detailId}
              onSelect={() => setDetailId(entry.id)}
              onOpen={() => openEntry(entry)}
            />
          )) : (
            <div className="p-8 text-center text-[13px] text-text-muted">
              {loading ? 'Loading work ledger...' : 'No ledger entries match this search.'}
            </div>
          )}
          {nextCursor ? (
            <div className="flex justify-center border-t border-border-subtle p-3">
              <button type="button" onClick={() => void loadLedger(nextCursor, true)} className="rounded-md border border-border-subtle px-3 py-2 text-[12px] text-text-secondary hover:bg-surface-hover">
                Load more
              </button>
            </div>
          ) : null}
        </div>
      </section>
      <WorkLedgerDetailDrawer entry={selectedEntry} onClose={() => setDetailId(null)} onOpen={openEntry} />
    </div>
  )
}
