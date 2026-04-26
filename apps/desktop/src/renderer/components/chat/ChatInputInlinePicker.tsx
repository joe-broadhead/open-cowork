import type { RefObject } from 'react'
import { compactDescription } from './chat-input-utils'
import type { InlinePickerState, MentionableAgent } from './chat-input-types'

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
      className="fixed z-50 rounded-xl border shadow-2xl overflow-hidden flex flex-col"
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
        background: 'color-mix(in srgb, var(--color-base) 96%, var(--color-text) 4%)',
        borderColor: 'var(--color-border)',
      }}
    >
      <div
        className="shrink-0 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] border-b"
        style={{
          color: 'var(--color-text-muted)',
          borderColor: 'var(--color-border-subtle)',
          background: 'color-mix(in srgb, var(--color-base) 88%, var(--color-text) 12%)',
        }}
      >
        Sub-Agents
      </div>
      <div className="overflow-y-auto flex-1">
      {suggestions.map((item, index) => (
        <button
          key={`agent:${item.id}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(item)}
          className="w-full px-3 py-2 text-start transition-colors cursor-pointer"
          style={{
            background: index === picker.selectedIndex ? 'var(--color-surface-hover)' : 'transparent',
          }}
        >
          <div className="flex items-center gap-2">
            <span
              className="px-1.5 py-0.5 rounded-md text-[9px] font-semibold uppercase tracking-[0.06em] border"
              style={{
                background: 'color-mix(in srgb, var(--color-base) 86%, var(--color-text) 14%)',
                color: 'var(--color-text-secondary)',
                borderColor: 'var(--color-border)',
              }}
            >
              Agent
            </span>
            <span className="text-[11px] font-medium text-text-secondary">{item.label}</span>
            <span className="text-[10px] text-text-muted font-mono">@{item.id}</span>
          </div>
          <div className="mt-1 text-[10px] text-text-muted">{compactDescription(item.description, 72)}</div>
        </button>
      ))}
      {suggestions.length === 0 ? (
        <div className="px-3 py-3 text-[11px] text-text-muted">
          No agents match “{picker.query}”.
        </div>
      ) : null}
      </div>
    </div>
  )
}
