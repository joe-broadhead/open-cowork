import { useMemo, useState } from 'react'
import type { ReasoningSegment } from '@open-cowork/shared'
import { t } from '../../helpers/i18n'
import { MarkdownContent } from './MarkdownContent'

function renderReasoningSegments(segments: ReasoningSegment[]) {
  return segments
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((segment) => segment.content)
    .filter(Boolean)
    .join('\n\n')
}

export function ReasoningDisclosure({
  segments,
  streaming = false,
  compact = false,
}: {
  segments?: ReasoningSegment[]
  streaming?: boolean
  compact?: boolean
}) {
  const content = useMemo(() => renderReasoningSegments(segments || []), [segments])
  const [open, setOpen] = useState(false)

  if (!content.trim()) return null
  const label = t('thinking.thinking', 'Thinking')
  const ariaLabel = open ? t('thinking.hideTrace', 'Hide thinking') : t('thinking.showTrace', 'Show thinking')

  return (
    <div
      className={`max-w-full min-w-0 ${compact ? 'text-xs' : 'text-sm'}`}
    >
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-label={ariaLabel}
        className="reasoning-disclosure-trigger group inline-flex max-w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs text-text-muted transition-colors hover:text-text"
      >
        <span className="inline-flex items-center gap-2">
          <span className="font-medium">{label}</span>
        </span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={`shrink-0 opacity-70 transition-transform group-hover:opacity-100 ${open ? 'rotate-180' : ''}`}
        >
          <polyline points="3.5,5.25 7,8.75 10.5,5.25" />
        </svg>
      </button>
      {open && (
        <div
          className={`reasoning-disclosure-panel mt-1 max-w-full min-w-0 overflow-hidden rounded-md border-l ${compact ? 'px-3 py-2' : 'px-3 py-2.5'}`}
          style={{
            borderColor: 'color-mix(in srgb, var(--color-accent) 42%, var(--color-border-subtle))',
            background: 'color-mix(in srgb, var(--color-surface-active) 58%, transparent)',
          }}
        >
          <MarkdownContent
            text={content}
            streaming={streaming}
            className="max-w-full min-w-0 overflow-hidden break-words text-xs text-text-secondary prose-pre:max-w-full prose-pre:overflow-x-auto"
          />
        </div>
      )}
    </div>
  )
}
