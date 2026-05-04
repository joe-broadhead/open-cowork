import { useDraggable } from '@dnd-kit/core'
import type { AutomationCardModel } from './automation-board-support'
import { formatStatus } from './automations-page-support'

type Props = {
  card: AutomationCardModel
  selected: boolean
  onSelect: (automationId: string) => void
  dragDisabled?: boolean
}

function progressPercent(completed: number, total: number) {
  if (total <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((completed / total) * 100)))
}

function statusTone(card: AutomationCardModel) {
  if (card.automation.status === 'failed' || card.inbox.some((item) => item.type === 'failure')) return 'var(--color-red)'
  if (card.hasBlockingInbox) return 'var(--color-warning)'
  if (card.activeRun) return 'var(--color-accent)'
  if (card.columnId === 'delivered') return 'var(--color-green)'
  return 'var(--color-text-muted)'
}

export function AutomationCard({ card, selected, onSelect, dragDisabled = false }: Props) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: card.automation.id,
    disabled: dragDisabled || card.automation.status === 'archived',
    data: { type: 'automation-card' },
  })
  const progress = progressPercent(card.workProgress.completed, card.workProgress.total)
  const tone = statusTone(card)
  const style = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    opacity: isDragging ? 0.55 : 1,
    borderColor: selected ? 'var(--color-accent)' : 'var(--color-border-subtle)',
    boxShadow: selected ? '0 0 0 1px var(--color-accent)' : undefined,
  }

  return (
    <button
      ref={setNodeRef}
      type="button"
      onClick={() => onSelect(card.automation.id)}
      className="group w-full rounded-xl border p-3 text-left transition-colors hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-accent cursor-pointer"
      style={style}
      aria-label={`${card.automation.title}, ${formatStatus(card.automation.status)}, ${card.scheduleLabel}`}
      {...attributes}
      {...listeners}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: tone }} />
          <span className="truncate text-[10px] uppercase tracking-[0.14em] text-text-muted">
            {card.automation.kind === 'managed-project' ? 'project' : 'recurring'}
          </span>
        </div>
        <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] text-text-muted">
          {formatStatus(card.automation.status)}
        </span>
      </div>

      <div className="mt-3 line-clamp-2 text-[13px] font-semibold leading-5 text-text">{card.automation.title}</div>
      <div className="mt-1 line-clamp-2 text-[11px] leading-5 text-text-secondary">{card.automation.goal}</div>
      <div className="mt-3 text-[11px] text-text-muted">{card.scheduleLabel}</div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {card.inboxCount > 0 ? (
          <span className="rounded-full px-2 py-0.5 text-[10px]" style={{ background: 'color-mix(in srgb, var(--color-warning) 14%, transparent)', color: 'var(--color-warning)' }}>
            {card.inboxCount} inbox
          </span>
        ) : null}
        {card.activeRun ? (
          <span className="rounded-full px-2 py-0.5 text-[10px]" style={{ background: 'color-mix(in srgb, var(--color-accent) 14%, transparent)', color: 'var(--color-accent)' }}>
            {card.activeRun.kind}
          </span>
        ) : null}
        {card.latestRun?.nextRetryAt ? (
          <span className="rounded-full px-2 py-0.5 text-[10px]" style={{ background: 'color-mix(in srgb, var(--color-red) 12%, transparent)', color: 'var(--color-red)' }}>
            retry queued
          </span>
        ) : null}
      </div>

      <div className="mt-3">
        <div className="flex items-center justify-between text-[10px] text-text-muted">
          <span>{card.workProgress.total > 0 ? `${card.workProgress.completed}/${card.workProgress.total} items` : 'No work items yet'}</span>
          <span className="truncate ps-2">{card.latestActivityLabel}</span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-active">
          <div
            className="h-full rounded-full"
            style={{
              width: `${progress}%`,
              background: tone,
            }}
          />
        </div>
      </div>
    </button>
  )
}
