import { useEffect, useMemo, useRef, useState } from 'react'
import { ModalBackdrop } from '../layout/ModalBackdrop'
import { t } from '../../helpers/i18n'
import { Card, Icon } from '../ui'

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

function describeReasoningVariant(variant: string | null) {
  if (!variant) return t('chat.reasoningAutoDescription', 'Use the model default.')
  switch (variant.trim().toLowerCase()) {
    case 'low':
      return t('chat.reasoningLowDescription', 'Keep reasoning concise for simple edits and quick replies.')
    case 'medium':
      return t('chat.reasoningMediumDescription', 'Balance speed and depth for everyday implementation work.')
    case 'high':
      return t('chat.reasoningHighDescription', 'Spend more effort on complex debugging, planning, and reviews.')
    case 'xhigh':
      return t('chat.reasoningXHighDescription', 'Use maximum effort for risky, multi-step, or deeply coupled changes.')
    default:
      return t('chat.reasoningVariantDescription', 'Use the model variant reported by OpenCode.')
  }
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
      onSelect(options[highlightIndex] ?? null)
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
        className="chat-menu-panel fixed z-50"
        role="listbox"
        tabIndex={-1}
        aria-label={t('chat.reasoningSelect', 'Select reasoning mode')}
        onKeyDown={handleKeyDown}
        style={{
          width: MENU_WIDTH,
          maxHeight: desiredHeight,
          left,
          top,
        }}
      >
        <div className="chat-menu-header">
          {t('chat.reasoning', 'Reasoning')}
        </div>
        <div className="py-1">
          {options.map((variant, index) => {
            const isActive = (currentVariant || null) === variant
            const isHighlighted = highlightIndex === index
            const label = formatReasoningVariantLabel(variant)
            const description = describeReasoningVariant(variant)
            return (
              <Card
                interactive
                padding="sm"
                key={variant || 'auto'}
                role="option"
                aria-selected={isActive}
                data-highlighted={isHighlighted || undefined}
                onClick={() => {
                  onSelect(variant)
                  onClose()
                }}
                className="chat-menu-option text-[12px]"
              >
                <span className="min-w-0">
                  <span className="block font-medium truncate">{label}</span>
                  <span className="block text-[10px] text-text-muted truncate">{description}</span>
                </span>
                {isActive ? (
                  <Icon name="check" size={16} className="shrink-0" />
                ) : null}
              </Card>
            )
          })}
        </div>
      </div>
    </>
  )
}
