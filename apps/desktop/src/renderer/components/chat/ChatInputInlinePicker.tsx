import type { RefObject } from 'react'
import { compactDescription } from './chat-input-utils'
import type { InlinePickerState, MentionableAgent } from './chat-input-types'
import { Badge, Card } from '../ui'

type ChatInputInlinePickerProps = {
  picker: InlinePickerState | null
  suggestions: MentionableAgent[]
  pickerRef: RefObject<HTMLDivElement | null>
  left: number
  top: number
  onSelect: (item: MentionableAgent) => void
}

export function ChatInputInlinePicker({
  picker,
  suggestions,
  pickerRef,
  left,
  top,
  onSelect,
}: ChatInputInlinePickerProps) {
  if (!picker) return null

  const inlineMenuWidth = 260
  // Anchor by the picker's BOTTOM edge instead of its top — the parent
  // hands us the composer's top-of-viewport y-coordinate, and we want
  // the menu's bottom to sit 8px above that, regardless of how tall the
  // menu is. Using `bottom` instead of `top` means we don't have to
  // estimate the rendered height (which was the source of the
  // "floating far above" bug — description wrapping blew the estimate).
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 0
  const bottomOffset = Math.max(12, viewportHeight - top + 8)

  return (
    <div
      ref={pickerRef}
      className="chat-menu-panel fixed z-50 flex flex-col"
      style={{
        width: inlineMenuWidth,
        maxHeight: Math.max(120, top - 24),
        left: Math.max(
          12,
          Math.min(
            left,
            (typeof window !== 'undefined' ? window.innerWidth : 0) - inlineMenuWidth - 12,
          ),
        ),
        bottom: bottomOffset,
      }}
    >
      <div className="chat-menu-header">
        Coworkers
      </div>
      <div className="overflow-y-auto flex-1 py-1">
      {suggestions.map((item, index) => (
        <Card
          interactive
          padding="sm"
          key={`agent:${item.id}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(item)}
          data-highlighted={index === picker.selectedIndex || undefined}
          className="chat-menu-option flex-col items-stretch text-start"
        >
          <span className="flex items-center gap-2">
            <Badge tone="muted" className="shrink-0 uppercase tracking-[0.06em]">
              Coworker
            </Badge>
            <span className="text-2xs font-medium text-text-secondary truncate">{item.label}</span>
            <span className="text-2xs text-text-muted font-mono shrink-0">@{item.id}</span>
          </span>
          <span className="mt-1 text-2xs text-text-muted">{compactDescription(item.description, 72)}</span>
        </Card>
      ))}
      {suggestions.length === 0 ? (
        <div className="px-3 py-3 text-2xs text-text-muted">
          No coworkers match “{picker.query}”.
        </div>
      ) : null}
      </div>
    </div>
  )
}
