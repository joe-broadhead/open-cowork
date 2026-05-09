import { useEffect, useMemo, useRef, useState } from 'react'
import { ModalBackdrop } from '../layout/ModalBackdrop'
import { t } from '../../helpers/i18n'

type ChatInputReasoningMenuProps = {
  visible: boolean
  anchorRect: DOMRect | null
  variants: string[]
  currentVariant: string | null
  onClose: () => void
  onSelect: (variant: string | null) => void
}

const MENU_WIDTH = 240

const VARIANT_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  reasoning: 'Reasoning',
  thinking: 'Thinking',
}

export function formatReasoningVariantLabel(variant: string | null | undefined) {
  if (!variant) return t('chat.reasoningAuto', 'Auto')
  const normalized = variant.trim()
  return VARIANT_LABELS[normalized.toLowerCase()]
    || normalized
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

export function ChatInputReasoningMenu({
  visible,
  anchorRect,
  variants,
  currentVariant,
  onClose,
  onSelect,
}: ChatInputReasoningMenuProps) {
  const options = useMemo(() => [null, ...variants], [variants])
  const [highlightIndex, setHighlightIndex] = useState(0)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!visible) return
    const activeIndex = Math.max(0, options.findIndex((variant) => variant === (currentVariant || null)))
    setHighlightIndex(activeIndex)
    requestAnimationFrame(() => menuRef.current?.focus())
  }, [currentVariant, options, visible])

  if (!visible || !anchorRect) return null

  const desiredHeight = Math.min(320, options.length * 48 + 42)
  const above = anchorRect.top - desiredHeight - 4
  const below = anchorRect.bottom + 4
  const top = Math.max(
    8,
    Math.min(above >= 8 ? above : below, window.innerHeight - desiredHeight - 8),
  )
  const left = Math.min(
    anchorRect.left,
    Math.max(8, window.innerWidth - MENU_WIDTH - 8),
  )

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlightIndex((current) => (current + 1) % options.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlightIndex((current) => (current - 1 + options.length) % options.length)
    } else if (event.key === 'Home') {
      event.preventDefault()
      setHighlightIndex(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      setHighlightIndex(options.length - 1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      onSelect(options[highlightIndex])
      onClose()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  return (
    <>
      <ModalBackdrop onDismiss={onClose} className="fixed inset-0 z-40" />
      <div
        ref={menuRef}
        className="fixed z-50 rounded-xl border shadow-xl overflow-hidden"
        role="listbox"
        tabIndex={-1}
        aria-label={t('chat.reasoningSelect', 'Select reasoning mode')}
        onKeyDown={handleKeyDown}
        style={{
          background: 'var(--color-base)',
          borderColor: 'var(--color-border)',
          width: MENU_WIDTH,
          maxHeight: desiredHeight,
          left,
          top,
        }}
      >
        <div
          className="px-3 py-2 text-[11px] text-text-muted font-medium border-b"
          style={{ borderColor: 'var(--color-border-subtle)' }}
        >
          {t('chat.reasoning', 'Reasoning')}
        </div>
        <div className="py-1">
          {options.map((variant, index) => {
            const isActive = (currentVariant || null) === variant
            const isHighlighted = highlightIndex === index
            const label = formatReasoningVariantLabel(variant)
            const description = variant
              ? t('chat.reasoningVariantDescription', 'Use the model variant reported by OpenCode.')
              : t('chat.reasoningAutoDescription', 'Use the model default.')
            return (
              <button
                key={variant || 'auto'}
                type="button"
                role="option"
                aria-selected={isActive}
                onClick={() => {
                  onSelect(variant)
                  onClose()
                }}
                className="w-full text-start px-3 py-2 text-[12px] cursor-pointer transition-colors flex items-center justify-between gap-2 hover:bg-surface-hover"
                style={{
                  color: 'var(--color-text)',
                  background: isHighlighted
                    ? 'var(--color-surface-hover)'
                    : isActive
                      ? 'color-mix(in srgb, var(--color-accent) 10%, transparent)'
                      : 'transparent',
                }}
              >
                <span className="min-w-0">
                  <span className="block font-medium truncate">{label}</span>
                  <span className="block text-[10px] text-text-muted truncate">{description}</span>
                </span>
                {isActive ? (
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="var(--color-text)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                    <polyline points="3,7.5 6,10.5 11,4" />
                  </svg>
                ) : null}
              </button>
            )
          })}
        </div>
      </div>
    </>
  )
}
