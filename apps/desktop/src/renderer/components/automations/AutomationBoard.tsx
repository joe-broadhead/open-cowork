import { useMemo, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import type { AutomationListPayload } from '@open-cowork/shared'
import { AutomationCard } from './AutomationCard'
import {
  AUTOMATION_COLUMNS,
  buildAutomationBoard,
  buildAutomationCardModel,
  summarizeAutomationBoard,
  type AutomationColumn,
  type AutomationColumnId,
} from './automation-board-support'
import { AUTOMATION_TEMPLATES } from './automations-page-support'

type Props = {
  payload: AutomationListPayload
  selectedAutomationId: string | null
  onSelectAutomation: (automationId: string) => void
  onDropAutomation: (automationId: string, targetColumn: AutomationColumnId) => void
  onNewAutomation: (templateId?: string) => void
  onLearnMore: () => void
  feedback?: string | null
}

function AutomationColumnView({
  column,
  selectedAutomationId,
  onSelectAutomation,
}: {
  column: AutomationColumn
  selectedAutomationId: string | null
  onSelectAutomation: (automationId: string) => void
}) {
  const { isOver, setNodeRef } = useDroppable({ id: column.id })
  return (
    <section
      ref={setNodeRef}
      className="flex h-full min-h-[520px] w-[280px] shrink-0 flex-col rounded-2xl border border-border-subtle"
      style={{
        background: isOver ? 'color-mix(in srgb, var(--color-accent) 8%, var(--color-elevated))' : 'var(--color-elevated)',
      }}
      aria-label={`${column.title} automations`}
    >
      <div className="border-b border-border-subtle px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[13px] font-semibold text-text">{column.title}</h2>
          <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-text-muted">{column.cards.length}</span>
        </div>
        <p className="mt-1 min-h-8 text-[11px] leading-4 text-text-muted">{column.description}</p>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {column.cards.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border-subtle px-3 py-8 text-center text-[11px] leading-5 text-text-muted">
            Drop a supported automation here or use a card action.
          </div>
        ) : column.cards.map((card) => (
          <AutomationCard
            key={card.automation.id}
            card={card}
            selected={selectedAutomationId === card.automation.id}
            onSelect={onSelectAutomation}
          />
        ))}
      </div>
    </section>
  )
}

function EmptyBoard({
  onNewAutomation,
  onLearnMore,
}: {
  onNewAutomation: (templateId?: string) => void
  onLearnMore: () => void
}) {
  return (
    <div className="grid min-h-[520px] gap-4 lg:grid-cols-[0.9fr_1.1fr]">
      <div className="rounded-3xl border border-border-subtle p-6" style={{ background: 'var(--color-elevated)' }}>
        <div className="text-[11px] uppercase tracking-[0.18em] text-text-muted">Automations</div>
        <h2 className="mt-2 text-[28px] font-semibold text-text">Turn repeatable work into a standing agent program</h2>
        <p className="mt-3 text-[14px] leading-7 text-text-secondary">
          Start with a small recurring task. Cowork plans it, asks for review when needed, and runs the approved work through OpenCode.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => onNewAutomation()}
            className="rounded-xl px-4 py-2 text-[13px] font-medium cursor-pointer"
            style={{ background: 'var(--color-accent)', color: 'var(--color-accent-foreground)' }}
          >
            New automation
          </button>
          <button type="button" onClick={onLearnMore} className="rounded-xl border border-border px-4 py-2 text-[13px] cursor-pointer">
            Learn more
          </button>
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {AUTOMATION_TEMPLATES.map((template) => (
          <button
            key={template.id}
            type="button"
            onClick={() => onNewAutomation(template.id)}
            className="rounded-2xl border border-dashed border-border-subtle p-4 text-left transition-colors hover:bg-surface-hover cursor-pointer"
            style={{ background: 'color-mix(in srgb, var(--color-elevated) 72%, transparent)' }}
          >
            <div className="text-[11px] uppercase tracking-[0.16em] text-text-muted">Template</div>
            <div className="mt-2 text-[15px] font-semibold text-text">{template.label}</div>
            <p className="mt-2 text-[12px] leading-6 text-text-secondary">{template.description}</p>
          </button>
        ))}
      </div>
    </div>
  )
}

export function AutomationBoard({
  payload,
  selectedAutomationId,
  onSelectAutomation,
  onDropAutomation,
  onNewAutomation,
  onLearnMore,
  feedback,
}: Props) {
  const [activeCardId, setActiveCardId] = useState<string | null>(null)
  const columns = useMemo(() => buildAutomationBoard(payload), [payload])
  const stats = useMemo(() => summarizeAutomationBoard(payload), [payload])
  const cardById = useMemo(() => {
    return new Map(payload.automations.map((automation) => [
      automation.id,
      buildAutomationCardModel(payload, automation),
    ]))
  }, [payload])
  const activeCard = activeCardId ? cardById.get(activeCardId) || null : null
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  )

  const handleDragStart = (event: DragStartEvent) => {
    setActiveCardId(String(event.active.id))
  }

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveCardId(null)
    const targetColumn = event.over?.id
    if (!targetColumn || !AUTOMATION_COLUMNS.some((column) => column.id === targetColumn)) return
    onDropAutomation(String(event.active.id), targetColumn as AutomationColumnId)
  }

  if (payload.automations.length === 0) {
    return <EmptyBoard onNewAutomation={onNewAutomation} onLearnMore={onLearnMore} />
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2 text-[12px] text-text-secondary">
          <span className="rounded-full border border-border px-3 py-1">{stats.active} active</span>
          <span className="rounded-full border border-border px-3 py-1">{stats.needsReview} need review</span>
          <span className="rounded-full border border-border px-3 py-1">{stats.running} running</span>
          <span className="rounded-full border border-border px-3 py-1">{stats.delivered} delivered</span>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={onLearnMore} className="rounded-xl border border-border px-3 py-2 text-[12px] cursor-pointer">
            Learn more
          </button>
          <button
            type="button"
            onClick={() => onNewAutomation()}
            className="rounded-xl px-3 py-2 text-[12px] font-medium cursor-pointer"
            style={{ background: 'var(--color-accent)', color: 'var(--color-accent-foreground)' }}
          >
            New Automation
          </button>
        </div>
      </div>
      {feedback ? (
        <div className="mb-3 rounded-xl border border-border-subtle px-4 py-2 text-[12px] text-text-secondary" role="status">
          {feedback}
        </div>
      ) : null}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd} onDragCancel={() => setActiveCardId(null)}>
        <div className="flex min-h-0 flex-1 gap-4 overflow-x-auto pb-3" aria-label="Automation lifecycle board">
          {columns.map((column) => (
            <AutomationColumnView
              key={column.id}
              column={column}
              selectedAutomationId={selectedAutomationId}
              onSelectAutomation={onSelectAutomation}
            />
          ))}
        </div>
        <DragOverlay>
          {activeCard ? (
            <div className="w-[280px]">
              <AutomationCard card={activeCard} selected={false} onSelect={() => undefined} dragDisabled />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  )
}
