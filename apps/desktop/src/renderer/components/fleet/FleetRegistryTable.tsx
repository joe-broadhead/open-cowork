import { useEffect, useMemo, useState } from 'react'
import type { FleetBulkAction, FleetBulkActionKind, FleetRegistryItem } from '@open-cowork/shared'
import {
  FLEET_REGISTRY_QUICK_FILTERS,
  FLEET_REGISTRY_SORT_LABELS,
  toggleFleetRegistrySort,
  type FleetRegistryQuickFilter,
  type FleetRegistrySort,
  type FleetRegistrySortKey,
  type FleetRegistryViewMode,
} from './fleet-registry-model'

const BULK_ACTION_ORDER: FleetBulkActionKind[] = [
  'pause',
  'resume',
  'archive',
  'tag',
  'untag',
  'duplicate',
  'open_dependency',
  'run',
  'test',
]

type Props = {
  surfaceLabel: string
  items: FleetRegistryItem[]
  totalCount: number
  quickFilter: FleetRegistryQuickFilter
  sort: FleetRegistrySort
  onQuickFilterChange: (filter: FleetRegistryQuickFilter) => void
  onSortChange: (sort: FleetRegistrySort) => void
  onOpenItem: (item: FleetRegistryItem) => void
  onBulkAction?: (action: FleetBulkAction, items: FleetRegistryItem[]) => void | Promise<void>
  emptyMessage?: string
  minTableWidthClass?: string
}

export function FleetRegistryViewToggle({
  viewMode,
  onViewModeChange,
}: {
  viewMode: FleetRegistryViewMode
  onViewModeChange: (viewMode: FleetRegistryViewMode) => void
}) {
  return (
    <div className="flex rounded-lg border border-border-subtle overflow-hidden" aria-label="Registry view mode">
      {(['cards', 'table'] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          aria-pressed={viewMode === mode}
          onClick={() => onViewModeChange(mode)}
          className={`px-3 py-1.5 text-[12px] font-medium capitalize transition-colors ${viewMode === mode ? 'bg-surface-active text-text' : 'text-text-muted hover:text-text-secondary'}`}
        >
          {mode}
        </button>
      ))}
    </div>
  )
}

export function FleetRegistryTable({
  surfaceLabel,
  items,
  totalCount,
  quickFilter,
  sort,
  onQuickFilterChange,
  onSortChange,
  onOpenItem,
  onBulkAction,
  emptyMessage,
  minTableWidthClass = 'min-w-[1120px]',
}: Props) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const visibleIds = useMemo(() => new Set(items.map((item) => item.id)), [items])

  useEffect(() => {
    setSelectedIds((current) => {
      const next = new Set(Array.from(current).filter((id) => visibleIds.has(id)))
      return next.size === current.size ? current : next
    })
  }, [visibleIds])

  const selectedItems = useMemo(
    () => items.filter((item) => selectedIds.has(item.id)),
    [items, selectedIds],
  )
  const allVisibleSelected = items.length > 0 && items.every((item) => selectedIds.has(item.id))
  const bulkActions = useMemo(() => buildBulkActions(selectedItems, items, Boolean(onBulkAction)), [items, onBulkAction, selectedItems])

  const toggleAll = () => {
    setSelectedIds((current) => {
      if (items.length === 0) return current
      if (items.every((item) => current.has(item.id))) return new Set()
      return new Set(items.map((item) => item.id))
    })
  }

  const toggleOne = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <section className="min-h-0 rounded-lg border border-border-subtle bg-surface" aria-label={`${surfaceLabel} registry`}>
      <div className="border-b border-border-subtle px-3 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[12px] font-semibold text-text">{surfaceLabel} registry</div>
            <div className="mt-1 text-[11px] text-text-muted">
              {items.length} shown of {totalCount}
              {selectedIds.size > 0 ? ` · ${selectedIds.size} selected` : ''}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {bulkActions.map((entry) => (
              <button
                key={entry.action.kind}
                type="button"
                disabled={entry.disabled}
                title={entry.reason || undefined}
                onClick={() => {
                  if (entry.disabled || !onBulkAction) return
                  void onBulkAction(entry.action, selectedItems)
                }}
                className={`rounded-md border px-2.5 py-1.5 text-[11px] font-medium disabled:cursor-not-allowed disabled:opacity-50 ${entry.action.destructive ? 'border-red-400/40 text-red-100' : 'border-border-subtle text-text-secondary hover:bg-surface-hover'}`}
              >
                {entry.action.label}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-3 flex gap-2 overflow-x-auto pb-1" aria-label={`${surfaceLabel} quick filters`}>
          {FLEET_REGISTRY_QUICK_FILTERS.map((filter) => (
            <button
              key={filter.id}
              type="button"
              aria-pressed={quickFilter === filter.id}
              onClick={() => onQuickFilterChange(filter.id)}
              className={`shrink-0 rounded-md border px-2.5 py-1 text-[11px] ${quickFilter === filter.id ? 'border-accent bg-accent/10 text-text' : 'border-border-subtle text-text-muted hover:text-text-secondary'}`}
            >
              {filter.label}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className={`${minTableWidthClass} w-full border-collapse text-left text-[12px]`} aria-label={`${surfaceLabel} registry table`}>
          <thead className="bg-elevated text-[10px] uppercase tracking-[0.12em] text-text-muted">
            <tr>
              <th className="w-10 border-b border-border-subtle px-3 py-2">
                <label className="sr-only" htmlFor={`${surfaceLabel}-registry-select-all`}>Select all visible {surfaceLabel}</label>
                <input
                  id={`${surfaceLabel}-registry-select-all`}
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={toggleAll}
                  disabled={items.length === 0}
                />
              </th>
              <SortableHeader label="Name" columnKey="name" sort={sort} onSortChange={onSortChange} />
              <SortableHeader label="Kind" columnKey="kind" sort={sort} onSortChange={onSortChange} />
              <SortableHeader label="Status" columnKey="status" sort={sort} onSortChange={onSortChange} />
              <SortableHeader label="Source" columnKey="source" sort={sort} onSortChange={onSortChange} />
              <SortableHeader label="Model" columnKey="model" sort={sort} onSortChange={onSortChange} />
              <SortableHeader label="Caps" columnKey="capabilities" sort={sort} onSortChange={onSortChange} />
              <SortableHeader label="Activity" columnKey="activity" sort={sort} onSortChange={onSortChange} />
              <SortableHeader label="Runs" columnKey="runs" sort={sort} onSortChange={onSortChange} />
              <SortableHeader label="Review" columnKey="backlog" sort={sort} onSortChange={onSortChange} />
              <SortableHeader label="Cost" columnKey="cost" sort={sort} onSortChange={onSortChange} />
              <th className="border-b border-border-subtle px-3 py-2">Tags</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={12} className="px-3 py-10 text-center text-[12px] text-text-muted">
                  {emptyMessage || 'No registry items match the current filters.'}
                </td>
              </tr>
            ) : items.map((item) => (
              <tr key={item.id} className="border-b border-border-subtle last:border-b-0 hover:bg-surface-hover">
                <td className="px-3 py-2 align-top">
                  <label className="sr-only" htmlFor={`${surfaceLabel}-registry-${item.id}`}>Select {item.name}</label>
                  <input
                    id={`${surfaceLabel}-registry-${item.id}`}
                    type="checkbox"
                    checked={selectedIds.has(item.id)}
                    onChange={() => toggleOne(item.id)}
                  />
                </td>
                <td className="max-w-[260px] px-3 py-2 align-top">
                  <button type="button" onClick={() => onOpenItem(item)} className="block max-w-full truncate text-left font-semibold text-text hover:text-accent">
                    {item.name}
                  </button>
                  {item.description ? <div className="mt-1 line-clamp-2 text-[11px] leading-4 text-text-muted">{item.description}</div> : null}
                </td>
                <td className="px-3 py-2 align-top text-text-secondary">{item.typeLabel}</td>
                <td className="px-3 py-2 align-top"><StatusBadge status={item.statusLabel} /></td>
                <td className="px-3 py-2 align-top text-text-secondary">{item.source}</td>
                <td className="px-3 py-2 align-top text-text-secondary">{item.model || item.provider || 'Default'}</td>
                <td className="px-3 py-2 align-top text-text-secondary">
                  <div>{item.capabilitiesCount}</div>
                  <div className="text-[10px] text-text-muted">{item.skillsCount} skills · {item.toolsCount} tools</div>
                </td>
                <td className="px-3 py-2 align-top text-text-secondary">{formatActivity(item)}</td>
                <td className="px-3 py-2 align-top text-text-secondary">{item.activeRuns} active · {item.failedRuns} failed</td>
                <td className="px-3 py-2 align-top text-text-secondary">{item.reviewBacklog + item.approvalBacklog}</td>
                <td className="px-3 py-2 align-top text-text-secondary">
                  {formatCost(item.costUsd)}
                  <div className="text-[10px] text-text-muted">{formatTokens(item.tokenCount)}</div>
                </td>
                <td className="max-w-[220px] px-3 py-2 align-top">
                  <div className="flex flex-wrap gap-1">
                    {item.tags.slice(0, 4).map((tag) => (
                      <span key={tag} className="rounded border border-border-subtle px-1.5 py-0.5 text-[10px] text-text-muted">{tag}</span>
                    ))}
                    {item.tags.length > 4 ? <span className="text-[10px] text-text-muted">+{item.tags.length - 4}</span> : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function SortableHeader({
  label,
  columnKey,
  sort,
  onSortChange,
}: {
  label: string
  columnKey: FleetRegistrySortKey
  sort: FleetRegistrySort
  onSortChange: (sort: FleetRegistrySort) => void
}) {
  const active = sort.key === columnKey
  return (
    <th className="border-b border-border-subtle px-3 py-2">
      <button
        type="button"
        onClick={() => onSortChange(toggleFleetRegistrySort(sort, columnKey))}
        className={`inline-flex items-center gap-1 ${active ? 'text-text' : 'text-text-muted hover:text-text-secondary'}`}
        title={`Sort by ${FLEET_REGISTRY_SORT_LABELS[columnKey]}`}
      >
        {label}
        <span aria-hidden="true">{active ? (sort.direction === 'asc' ? '↑' : '↓') : ''}</span>
      </button>
    </th>
  )
}

function StatusBadge({ status }: { status: string }) {
  const normalized = status.toLowerCase()
  const tone = normalized.includes('failed') || normalized.includes('blocked') || normalized.includes('disabled')
    ? 'border-red-400/30 bg-red-500/10 text-red-100'
    : normalized.includes('paused') || normalized.includes('review')
      ? 'border-amber-400/30 bg-amber-500/10 text-amber-100'
      : normalized.includes('active') || normalized.includes('ready') || normalized.includes('completed')
        ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-100'
        : 'border-border-subtle bg-elevated text-text-secondary'
  return <span className={`inline-flex rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest ${tone}`}>{status}</span>
}

function formatActivity(item: FleetRegistryItem) {
  return formatDate(item.lastRunAt || item.lastUsedAt || null)
}

function formatDate(value: string | null | undefined) {
  if (!value) return 'Never'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function formatCost(value: number | null | undefined) {
  if (!value) return '$0.00'
  return value < 0.01 ? '<$0.01' : `$${value.toFixed(2)}`
}

function formatTokens(value: number | null | undefined) {
  if (!value) return '0 tokens'
  return `${new Intl.NumberFormat().format(value)} tokens`
}

function buildBulkActions(selectedItems: FleetRegistryItem[], allItems: FleetRegistryItem[], hasHandler: boolean) {
  const candidates = selectedItems.length > 0 ? selectedItems : allItems
  const kinds = BULK_ACTION_ORDER.filter((kind) => candidates.some((item) => item.bulkActions.some((action) => action.kind === kind)))
  return kinds.map((kind) => {
    const firstAction = candidates.flatMap((item) => item.bulkActions).find((action) => action.kind === kind) || fallbackAction(kind)
    const selectedActions = selectedItems.map((item) => item.bulkActions.find((action) => action.kind === kind) || null)
    const missing = selectedItems.length > 0 && selectedActions.some((action) => action === null)
    const unsupported = selectedActions.find((action) => action && !action.supported)
    const singleOnly = firstAction.selection === 'single' && selectedItems.length !== 1
    const disabled = selectedItems.length === 0 || missing || Boolean(unsupported) || singleOnly || !hasHandler
    const reason = selectedItems.length === 0
      ? 'Select one or more rows first.'
      : !hasHandler
        ? 'This surface has not wired a bulk action handler yet.'
        : singleOnly
          ? 'Select exactly one row for this action.'
          : missing
            ? 'At least one selected row does not expose this action.'
            : unsupported?.disabledReason || null
    return {
      action: firstAction,
      disabled,
      reason,
    }
  })
}

function fallbackAction(kind: FleetBulkActionKind): FleetBulkAction {
  return {
    id: kind,
    kind,
    label: kind.replaceAll('_', ' '),
    supported: false,
    disabledReason: 'This action is unavailable.',
  }
}
