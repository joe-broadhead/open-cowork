import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ThreadFacetBucket,
  ThreadFacetSummary,
  ThreadListItem,
  ThreadSearchQuery,
  ThreadSmartFilter,
  ThreadSort,
  ThreadStatus,
  ThreadTag,
} from '@open-cowork/shared'
import { t } from '../../helpers/i18n'

const STATUS_OPTIONS: Array<{ value: ThreadStatus; label: string }> = [
  { value: 'idle', label: 'Idle' },
  { value: 'running', label: 'Running' },
  { value: 'needs_user', label: 'Needs user' },
  { value: 'error', label: 'Error' },
  { value: 'reverted', label: 'Reverted' },
  { value: 'automation', label: 'Automation' },
]

const TAG_COLORS = ['#64748b', '#22c55e', '#0ea5e9', '#f59e0b', '#ef4444', '#a855f7']

type ThreadsPageProps = {
  onOpenThread: (sessionId: string) => void
}

type QueryState = {
  text: string
  sort: ThreadSort
  dateRange?: ThreadSearchQuery['dateRange']
  projectLabels: string[]
  statuses: ThreadStatus[]
  tagIds: string[]
  providerIds: string[]
  modelIds: string[]
  agents: string[]
  tools: string[]
  mcps: string[]
}

const EMPTY_FACETS: ThreadFacetSummary = {
  projects: [],
  providers: [],
  models: [],
  agents: [],
  tools: [],
  mcps: [],
  statuses: [],
  tags: [],
}

function queryFromState(state: QueryState, cursor?: string | null): ThreadSearchQuery {
  return {
    text: state.text || undefined,
    cursor: cursor || null,
    limit: 50,
    sort: state.sort,
    dateRange: state.dateRange,
    projectLabels: state.projectLabels.length ? state.projectLabels : undefined,
    statuses: state.statuses.length ? state.statuses : undefined,
    tagIds: state.tagIds.length ? state.tagIds : undefined,
    providerIds: state.providerIds.length ? state.providerIds : undefined,
    modelIds: state.modelIds.length ? state.modelIds : undefined,
    agents: state.agents.length ? state.agents : undefined,
    tools: state.tools.length ? state.tools : undefined,
    mcps: state.mcps.length ? state.mcps : undefined,
  }
}

function stateFromQuery(query: ThreadSearchQuery): QueryState {
  return {
    text: query.text || '',
    sort: query.sort || 'updated_desc',
    dateRange: query.dateRange,
    projectLabels: query.projectLabels || [],
    statuses: query.statuses || [],
    tagIds: query.tagIds || [],
    providerIds: query.providerIds || [],
    modelIds: query.modelIds || [],
    agents: query.agents || [],
    tools: query.tools || [],
    mcps: query.mcps || [],
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

function isRecentRange(range: ThreadSearchQuery['dateRange'], days: number) {
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

function hasFilters(state: QueryState) {
  return Boolean(
    state.text
    || state.dateRange
    || state.projectLabels.length
    || state.statuses.length
    || state.tagIds.length
    || state.providerIds.length
    || state.modelIds.length
    || state.agents.length
    || state.tools.length
    || state.mcps.length,
  )
}

function FacetButton({
  bucket,
  selected,
  onClick,
  color,
}: {
  bucket: ThreadFacetBucket
  selected: boolean
  onClick: () => void
  color?: string
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`${bucket.label} (${bucket.count})`}
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-[12px] transition-colors ${selected ? 'bg-surface-active text-text' : 'text-text-secondary hover:bg-surface-hover hover:text-text'}`}
    >
      {color ? <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} /> : null}
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
  buckets: Array<ThreadFacetBucket & { color?: string }>
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
            color={bucket.color}
            selected={selected.includes(bucket.value)}
            onClick={() => onToggle(bucket.value)}
          />
        ))}
      </div>
    </section>
  )
}

function StatusFacet({
  selected,
  buckets,
  onToggle,
}: {
  selected: ThreadStatus[]
  buckets: ThreadFacetBucket[]
  onToggle: (value: ThreadStatus) => void
}) {
  const counts = new Map(buckets.map((bucket) => [bucket.value, bucket.count]))
  return (
    <section className="border-b border-border-subtle px-3 py-3">
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-text-muted">{t('threads.status', 'Status')}</h3>
      <div className="flex flex-col gap-1">
        {STATUS_OPTIONS.map((status) => (
          <FacetButton
            key={status.value}
            bucket={{ value: status.value, label: status.label, count: counts.get(status.value) || 0 }}
            selected={selected.includes(status.value)}
            onClick={() => onToggle(status.value)}
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
  range?: ThreadSearchQuery['dateRange']
  onChange: (range?: ThreadSearchQuery['dateRange']) => void
}) {
  const options = [
    { label: 'Any time', range: undefined, selected: !range },
    { label: 'Last 7 days', range: { from: daysAgoIso(7) }, selected: isRecentRange(range, 7) },
    { label: 'Last 30 days', range: { from: daysAgoIso(30) }, selected: isRecentRange(range, 30) },
  ]
  return (
    <section className="border-b border-border-subtle px-3 py-3">
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-text-muted">{t('threads.date', 'Date')}</h3>
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

function ThreadBadges({ thread }: { thread: ThreadListItem }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {thread.providerId ? <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] text-text-muted">Provider: {thread.providerId}</span> : null}
      {thread.actualAgents.slice(0, 2).map((agent) => (
        <span key={agent.name} className="rounded bg-surface px-1.5 py-0.5 text-[10px] text-text-muted">Agent: {agent.name}</span>
      ))}
      {thread.actualTools.slice(0, 2).map((tool) => (
        <span key={tool.name} className="rounded bg-surface px-1.5 py-0.5 text-[10px] text-text-muted">Tool: {tool.name}</span>
      ))}
      {thread.suggestions.slice(0, 2).map((suggestion) => (
        <span key={suggestion.id} className="rounded border border-dashed border-border-subtle px-1.5 py-0.5 text-[10px] text-text-muted">Suggested: {suggestion.label}</span>
      ))}
    </div>
  )
}

function ThreadRow({
  thread,
  selected,
  onToggleSelected,
  onOpen,
  onSelect,
  onDragStart,
}: {
  thread: ThreadListItem
  selected: boolean
  onToggleSelected: () => void
  onOpen: () => void
  onSelect: () => void
  onDragStart: () => void
}) {
  return (
    <div
      role="row"
      draggable
      onDragStart={onDragStart}
      className={`grid grid-cols-[32px_minmax(220px,1.4fr)_160px_160px_120px] items-center gap-3 border-b border-border-subtle px-3 py-2.5 text-[12px] transition-colors ${selected ? 'bg-surface-active/70' : 'hover:bg-surface-hover'}`}
    >
      <label className="flex items-center justify-center">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelected}
          aria-label={t('threads.selectThread', 'Select thread')}
          className="h-3.5 w-3.5 accent-[var(--color-accent)]"
        />
      </label>
      <button type="button" onClick={onSelect} className="min-w-0 text-start">
        <span className="block truncate text-[13px] font-medium text-text">{thread.title}</span>
        <span className="mt-1 flex min-w-0 items-center gap-2 text-[11px] text-text-muted">
          {thread.projectLabel ? <span className="truncate">{thread.projectLabel}</span> : <span>Personal workspace</span>}
          <span aria-hidden="true">·</span>
          <span>{thread.usage.messages} messages</span>
          {thread.changeSummary && thread.changeSummary.files > 0 ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{thread.changeSummary.files} files</span>
            </>
          ) : null}
        </span>
        <div className="mt-1.5">
          <ThreadBadges thread={thread} />
        </div>
      </button>
      <div className="truncate text-text-secondary">{thread.providerId || '—'}{thread.modelId ? ` / ${thread.modelId.split('/').pop()}` : ''}</div>
      <div className="flex flex-wrap gap-1">
        {thread.tags.length ? thread.tags.map((tag) => (
          <span key={tag.id} className="rounded px-1.5 py-0.5 text-[10px] text-white" style={{ background: tag.color }}>{tag.name}</span>
        )) : <span className="text-text-muted">No tags</span>}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] uppercase tracking-[0.04em] text-text-muted">{thread.status}</span>
        <button type="button" onClick={onOpen} className="rounded-md border border-border-subtle px-2 py-1 text-[11px] text-text-secondary hover:bg-surface-hover hover:text-text">
          Open
        </button>
      </div>
    </div>
  )
}

function TagManager({
  tags,
  selectedIds,
  onCreateTag,
  onApplyTag,
  onRemoveTag,
  onDeleteTag,
  onDropTag,
}: {
  tags: ThreadTag[]
  selectedIds: string[]
  onCreateTag: (input: { name: string; color: string }) => void
  onApplyTag: (tagId: string) => void
  onRemoveTag: (tagId: string) => void
  onDeleteTag: (tagId: string) => void
  onDropTag: (tagId: string) => void
}) {
  const [name, setName] = useState('')
  const [color, setColor] = useState(TAG_COLORS[0]!)
  return (
    <section className="border-b border-border-subtle px-3 py-3">
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-text-muted">{t('threads.tags', 'Tags')}</h3>
      <form
        className="mb-2 flex gap-1.5"
        onSubmit={(event) => {
          event.preventDefault()
          if (!name.trim()) return
          onCreateTag({ name: name.trim(), color })
          setName('')
        }}
      >
        <label className="sr-only" htmlFor="thread-tag-name">Tag name</label>
        <input
          id="thread-tag-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('threads.newTag', 'New tag')}
          className="min-w-0 flex-1 rounded-md border border-border-subtle bg-base px-2 py-1.5 text-[12px] text-text outline-none focus:border-accent"
        />
        <label className="sr-only" htmlFor="thread-tag-color">Tag color</label>
        <select
          id="thread-tag-color"
          value={color}
          onChange={(event) => setColor(event.target.value)}
          className="w-8 rounded-md border border-border-subtle bg-base text-[12px] text-text"
        >
          {TAG_COLORS.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
        </select>
        <button type="submit" className="rounded-md border border-border-subtle px-2 text-[11px] text-text-secondary hover:bg-surface-hover">Add</button>
      </form>
      <div className="flex flex-col gap-1">
        {tags.map((tag) => (
          <div
            key={tag.id}
            className="flex items-center gap-1.5 rounded-md border border-transparent px-1.5 py-1 hover:border-border-subtle"
          >
            <button
              type="button"
              aria-disabled={selectedIds.length === 0}
              aria-label={t('threads.applyOrDropTag', 'Apply or drop selected threads onto {{name}}', { name: tag.name })}
              onClick={() => onApplyTag(tag.id)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => onDropTag(tag.id)}
              className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-surface-hover aria-disabled:opacity-60"
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: tag.color }} />
              <span className="min-w-0 flex-1 truncate text-[12px] text-text-secondary">{tag.name}</span>
            </button>
            <button type="button" disabled={selectedIds.length === 0} onClick={() => onApplyTag(tag.id)} className="rounded px-1.5 py-0.5 text-[10px] text-text-muted hover:bg-surface-hover disabled:opacity-40">Apply</button>
            <button type="button" disabled={selectedIds.length === 0} onClick={() => onRemoveTag(tag.id)} className="rounded px-1.5 py-0.5 text-[10px] text-text-muted hover:bg-surface-hover disabled:opacity-40">Remove</button>
            <button type="button" onClick={() => onDeleteTag(tag.id)} className="rounded px-1.5 py-0.5 text-[10px] text-text-muted hover:bg-surface-hover">Delete</button>
          </div>
        ))}
      </div>
    </section>
  )
}

function SmartFilters({
  filters,
  onSave,
  onApply,
  onDelete,
}: {
  filters: ThreadSmartFilter[]
  onSave: (name: string) => void
  onApply: (filter: ThreadSmartFilter) => void
  onDelete: (filterId: string) => void
}) {
  const [name, setName] = useState('')
  return (
    <section className="border-b border-border-subtle px-3 py-3">
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-text-muted">{t('threads.smartFilters', 'Smart filters')}</h3>
      <form
        className="mb-2 flex gap-1.5"
        onSubmit={(event) => {
          event.preventDefault()
          if (!name.trim()) return
          onSave(name.trim())
          setName('')
        }}
      >
        <label className="sr-only" htmlFor="thread-smart-filter-name">Smart filter name</label>
        <input
          id="thread-smart-filter-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('threads.saveFilter', 'Save filter')}
          className="min-w-0 flex-1 rounded-md border border-border-subtle bg-base px-2 py-1.5 text-[12px] text-text outline-none focus:border-accent"
        />
        <button type="submit" className="rounded-md border border-border-subtle px-2 text-[11px] text-text-secondary hover:bg-surface-hover">Save</button>
      </form>
      <div className="flex flex-col gap-1">
        {filters.map((filter) => (
          <div key={filter.id} className="flex items-center gap-1.5">
            <button type="button" onClick={() => onApply(filter)} className="min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-start text-[12px] text-text-secondary hover:bg-surface-hover">
              {filter.name}
            </button>
            <button type="button" onClick={() => onDelete(filter.id)} className="rounded px-1.5 py-0.5 text-[10px] text-text-muted hover:bg-surface-hover">Delete</button>
          </div>
        ))}
      </div>
    </section>
  )
}

function DetailDrawer({
  thread,
  onClose,
  onOpen,
  onAcceptSuggestion,
  onDismissSuggestion,
  onEditSuggestion,
}: {
  thread: ThreadListItem | null
  onClose: () => void
  onOpen: (sessionId: string) => void
  onAcceptSuggestion: (suggestionId: string) => void
  onDismissSuggestion: (suggestionId: string) => void
  onEditSuggestion: (suggestionId: string, label: string) => void
}) {
  const [editSuggestionId, setEditSuggestionId] = useState<string | null>(null)
  const [editLabel, setEditLabel] = useState('')
  useEffect(() => {
    setEditSuggestionId(null)
    setEditLabel('')
  }, [thread?.sessionId])
  if (!thread) return null
  return (
    <aside aria-label="Thread detail" className="w-[340px] shrink-0 border-s border-border-subtle bg-base">
      <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
        <h2 className="min-w-0 truncate text-[14px] font-semibold text-text">{thread.title}</h2>
        <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-[12px] text-text-muted hover:bg-surface-hover">Close</button>
      </div>
      <div className="space-y-5 overflow-y-auto p-4 text-[12px] text-text-secondary">
        <section>
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-text-muted">Overview</h3>
          <div className="grid grid-cols-[100px_1fr] gap-x-3 gap-y-1">
            <span className="text-text-muted">Updated</span><span>{formatDate(thread.updatedAt)}</span>
            <span className="text-text-muted">Project</span><span>{thread.projectLabel || 'Personal workspace'}</span>
            <span className="text-text-muted">Provider</span><span>{thread.providerId || '—'}</span>
            <span className="text-text-muted">Cost</span><span>{money(thread.usage.cost)}</span>
          </div>
          <button type="button" onClick={() => onOpen(thread.sessionId)} className="mt-3 w-full rounded-md border border-border-subtle px-3 py-2 text-[12px] text-text-secondary hover:bg-surface-hover hover:text-text">
            Open thread
          </button>
        </section>
        <section>
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-text-muted">Actual metadata</h3>
          <div className="flex flex-wrap gap-1.5">
            {thread.actualAgents.map((agent) => <span key={agent.name} className="rounded bg-surface px-1.5 py-0.5 text-[10px]">Agent: {agent.name} ×{agent.count}</span>)}
            {thread.actualTools.map((tool) => <span key={tool.name} className="rounded bg-surface px-1.5 py-0.5 text-[10px]">Tool: {tool.name} ×{tool.count}</span>)}
            {!thread.actualAgents.length && !thread.actualTools.length ? <span className="text-text-muted">No agent or tool usage recorded yet.</span> : null}
          </div>
        </section>
        <section>
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-text-muted">Suggestions</h3>
          <div className="flex flex-col gap-2">
            {thread.suggestions.length ? thread.suggestions.map((suggestion) => (
              <div key={suggestion.id} className="rounded-md border border-dashed border-border-subtle p-2">
                {editSuggestionId === suggestion.id ? (
                  <form
                    className="flex gap-1.5"
                    onSubmit={(event) => {
                      event.preventDefault()
                      if (editLabel.trim()) onEditSuggestion(suggestion.id, editLabel.trim())
                    }}
                  >
                    <label className="sr-only" htmlFor={`suggestion-${suggestion.id}`}>Suggestion label</label>
                    <input id={`suggestion-${suggestion.id}`} value={editLabel} onChange={(event) => setEditLabel(event.target.value)} className="min-w-0 flex-1 rounded border border-border-subtle bg-base px-2 py-1 text-[12px] text-text" />
                    <button type="submit" className="rounded border border-border-subtle px-2 text-[11px]">Save</button>
                  </form>
                ) : (
                  <>
                    <div className="font-medium text-text">Suggested: {suggestion.label}</div>
                    <div className="mt-1 text-[11px] text-text-muted">{suggestion.reason}</div>
                    <div className="mt-2 flex gap-1.5">
                      <button type="button" onClick={() => onAcceptSuggestion(suggestion.id)} className="rounded border border-border-subtle px-2 py-1 text-[11px] hover:bg-surface-hover">Accept</button>
                      <button type="button" onClick={() => { setEditSuggestionId(suggestion.id); setEditLabel(suggestion.label) }} className="rounded border border-border-subtle px-2 py-1 text-[11px] hover:bg-surface-hover">Edit</button>
                      <button type="button" onClick={() => onDismissSuggestion(suggestion.id)} className="rounded border border-border-subtle px-2 py-1 text-[11px] hover:bg-surface-hover">Dismiss</button>
                    </div>
                  </>
                )}
              </div>
            )) : <span className="text-text-muted">No suggestions for this thread.</span>}
          </div>
        </section>
      </div>
    </aside>
  )
}

export function ThreadsPage({ onOpenThread }: ThreadsPageProps) {
  const [query, setQuery] = useState<QueryState>({
    text: '',
    sort: 'updated_desc',
    dateRange: undefined,
    projectLabels: [],
    statuses: [],
    tagIds: [],
    providerIds: [],
    modelIds: [],
    agents: [],
    tools: [],
    mcps: [],
  })
  const [threads, setThreads] = useState<ThreadListItem[]>([])
  const [facets, setFacets] = useState<ThreadFacetSummary>(EMPTY_FACETS)
  const [tags, setTags] = useState<ThreadTag[]>([])
  const [smartFilters, setSmartFilters] = useState<ThreadSmartFilter[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [detailId, setDetailId] = useState<string | null>(null)
  const dragIdsRef = useRef<string[]>([])

  const selectedThread = useMemo(() => threads.find((thread) => thread.sessionId === detailId) || null, [detailId, threads])

  const refreshAuxiliary = useCallback(async () => {
    const [tagList, filterList] = await Promise.all([
      window.coworkApi.threads.tags.list(),
      window.coworkApi.threads.smartFilters.list(),
    ])
    setTags(tagList)
    setSmartFilters(filterList)
  }, [])

  const loadThreads = useCallback(async (cursor: string | null = null, append = false) => {
    setLoading(true)
    setError(null)
    try {
      const searchQuery = queryFromState(query, cursor)
      const [result, facetResult] = await Promise.all([
        window.coworkApi.threads.search(searchQuery),
        window.coworkApi.threads.facets(searchQuery),
      ])
      setThreads((current) => append ? [...current, ...result.threads] : result.threads)
      setNextCursor(result.nextCursor)
      setTotal(result.totalEstimate)
      setFacets(facetResult)
      if (!append) setSelectedIds([])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [query])

  useEffect(() => {
    void refreshAuxiliary()
  }, [refreshAuxiliary])

  useEffect(() => {
    void loadThreads(null, false)
  }, [loadThreads])

  const reload = useCallback(() => {
    void refreshAuxiliary()
    void loadThreads(null, false)
  }, [loadThreads, refreshAuxiliary])

  const toggleSelection = (sessionId: string) => {
    setSelectedIds((current) => toggleValue(current, sessionId))
  }

  const mutateTags = async (operation: 'apply' | 'remove', tagId: string, sourceIds = selectedIds) => {
    if (sourceIds.length === 0) return
    if (operation === 'apply') await window.coworkApi.threads.tags.apply(sourceIds, [tagId])
    else await window.coworkApi.threads.tags.remove(sourceIds, [tagId])
    reload()
  }

  const openThread = (sessionId: string) => {
    onOpenThread(sessionId)
  }

  return (
    <div className="flex h-full min-h-0 bg-base text-text">
      <aside aria-label="Thread filters" className="flex w-[280px] shrink-0 flex-col border-e border-border-subtle bg-base">
        <div className="border-b border-border-subtle px-3 py-3">
          <div className="text-[15px] font-semibold text-text">{t('threads.title', 'Threads')}</div>
          <div className="mt-1 text-[11px] text-text-muted">{t('threads.subtitle', 'Search history, metadata, tags, and saved filters.')}</div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <SmartFilters
            filters={smartFilters}
            onSave={async (name) => {
              await window.coworkApi.threads.smartFilters.create({ name, query: queryFromState(query, null) })
              reload()
            }}
            onApply={(filter) => setQuery(stateFromQuery(filter.query))}
            onDelete={async (filterId) => {
              await window.coworkApi.threads.smartFilters.delete(filterId)
              reload()
            }}
          />
          <TagManager
            tags={tags}
            selectedIds={selectedIds}
            onCreateTag={async (input) => {
              await window.coworkApi.threads.tags.create(input)
              reload()
            }}
            onApplyTag={(tagId) => void mutateTags('apply', tagId)}
            onRemoveTag={(tagId) => void mutateTags('remove', tagId)}
            onDeleteTag={async (tagId) => {
              await window.coworkApi.threads.tags.delete(tagId)
              reload()
            }}
            onDropTag={(tagId) => void mutateTags('apply', tagId, dragIdsRef.current)}
          />
          <StatusFacet
            selected={query.statuses}
            buckets={facets.statuses}
            onToggle={(value) => setQuery((current) => ({ ...current, statuses: toggleValue(current.statuses, value) }))}
          />
          <DateFacet
            range={query.dateRange}
            onChange={(dateRange) => setQuery((current) => ({ ...current, dateRange }))}
          />
          <FacetGroup title="Projects" buckets={facets.projects} selected={query.projectLabels} onToggle={(value) => setQuery((current) => ({ ...current, projectLabels: toggleValue(current.projectLabels, value) }))} />
          <FacetGroup title="Providers" buckets={facets.providers} selected={query.providerIds} onToggle={(value) => setQuery((current) => ({ ...current, providerIds: toggleValue(current.providerIds, value) }))} />
          <FacetGroup title="Models" buckets={facets.models} selected={query.modelIds} onToggle={(value) => setQuery((current) => ({ ...current, modelIds: toggleValue(current.modelIds, value) }))} />
          <FacetGroup title="Agents" buckets={facets.agents} selected={query.agents} onToggle={(value) => setQuery((current) => ({ ...current, agents: toggleValue(current.agents, value) }))} />
          <FacetGroup title="Tools" buckets={facets.tools} selected={query.tools} onToggle={(value) => setQuery((current) => ({ ...current, tools: toggleValue(current.tools, value) }))} />
          <FacetGroup title="MCPs" buckets={facets.mcps} selected={query.mcps} onToggle={(value) => setQuery((current) => ({ ...current, mcps: toggleValue(current.mcps, value) }))} />
          <FacetGroup title="Thread tags" buckets={facets.tags} selected={query.tagIds} onToggle={(value) => setQuery((current) => ({ ...current, tagIds: toggleValue(current.tagIds, value) }))} />
        </div>
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="border-b border-border-subtle px-4 py-3">
          <div className="flex items-center gap-2">
            <label className="sr-only" htmlFor="threads-search">Search threads</label>
            <input
              id="threads-search"
              value={query.text}
              onChange={(event) => setQuery((current) => ({ ...current, text: event.target.value }))}
              placeholder={t('threads.searchPlaceholder', 'Search titles, projects, providers, agents, tools, tags, and suggestions')}
              className="min-w-0 flex-1 rounded-md border border-border-subtle bg-base px-3 py-2 text-[13px] text-text outline-none focus:border-accent"
            />
            <label className="sr-only" htmlFor="threads-sort">Sort threads</label>
            <select
              id="threads-sort"
              value={query.sort}
              onChange={(event) => setQuery((current) => ({ ...current, sort: event.target.value as ThreadSort }))}
              className="rounded-md border border-border-subtle bg-base px-2 py-2 text-[12px] text-text"
            >
              <option value="updated_desc">Recently updated</option>
              <option value="created_desc">Recently created</option>
              <option value="title_asc">Title A-Z</option>
            </select>
            <button type="button" onClick={reload} className="rounded-md border border-border-subtle px-3 py-2 text-[12px] text-text-secondary hover:bg-surface-hover">Refresh</button>
            {hasFilters(query) ? (
              <button
                type="button"
                onClick={() => setQuery({ text: '', sort: 'updated_desc', dateRange: undefined, projectLabels: [], statuses: [], tagIds: [], providerIds: [], modelIds: [], agents: [], tools: [], mcps: [] })}
                className="rounded-md border border-border-subtle px-3 py-2 text-[12px] text-text-secondary hover:bg-surface-hover"
              >
                Clear
              </button>
            ) : null}
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] text-text-muted">
            <span>{loading ? 'Loading…' : `${total} indexed thread${total === 1 ? '' : 's'}`}</span>
            {selectedIds.length ? <span>{selectedIds.length} selected. Use Apply/Remove on a tag or drag rows onto a tag.</span> : <span>Actual metadata and suggestions are kept separate.</span>}
          </div>
        </div>
        {error ? <div role="alert" className="border-b border-red-400/30 bg-red-500/10 px-4 py-2 text-[12px] text-red-100">{error}</div> : null}
        <div className="grid grid-cols-[32px_minmax(220px,1.4fr)_160px_160px_120px] gap-3 border-b border-border-subtle px-3 py-2 text-[10px] font-semibold uppercase tracking-widest text-text-muted">
          <span />
          <span>Thread</span>
          <span>Provider / model</span>
          <span>Tags</span>
          <span>Status</span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {threads.length ? threads.map((thread) => (
            <ThreadRow
              key={thread.sessionId}
              thread={thread}
              selected={selectedIds.includes(thread.sessionId)}
              onToggleSelected={() => toggleSelection(thread.sessionId)}
              onSelect={() => setDetailId(thread.sessionId)}
              onOpen={() => openThread(thread.sessionId)}
              onDragStart={() => {
                dragIdsRef.current = selectedIds.includes(thread.sessionId) ? selectedIds : [thread.sessionId]
              }}
            />
          )) : (
            <div className="p-8 text-center text-[13px] text-text-muted">
              {loading ? 'Loading threads…' : 'No indexed threads match this search.'}
            </div>
          )}
          {nextCursor ? (
            <div className="flex justify-center border-t border-border-subtle p-3">
              <button type="button" onClick={() => void loadThreads(nextCursor, true)} className="rounded-md border border-border-subtle px-3 py-2 text-[12px] text-text-secondary hover:bg-surface-hover">
                Load more
              </button>
            </div>
          ) : null}
        </div>
      </section>
      <DetailDrawer
        thread={selectedThread}
        onClose={() => setDetailId(null)}
        onOpen={openThread}
        onAcceptSuggestion={async (suggestionId) => {
          await window.coworkApi.threads.suggestions.accept(suggestionId)
          reload()
        }}
        onDismissSuggestion={async (suggestionId) => {
          await window.coworkApi.threads.suggestions.dismiss(suggestionId)
          reload()
        }}
        onEditSuggestion={async (suggestionId, label) => {
          await window.coworkApi.threads.suggestions.edit(suggestionId, { label })
          reload()
        }}
      />
    </div>
  )
}
