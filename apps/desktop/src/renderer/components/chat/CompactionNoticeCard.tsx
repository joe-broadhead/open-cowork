import type { CompactionNotice } from '../../stores/session'

// Describe why this compaction happened. Overflow = the context window was
// full and the runtime had no choice. Voluntary = auto-compaction fired
// proactively while there was still slack, or the user invoked it manually.
function noticeText(notice: CompactionNotice) {
  if (notice.status === 'compacting') {
    if (notice.overflow) return 'Context window overflowed — shortening older turns to make room.'
    if (notice.auto) return 'Approaching the context limit — compacting proactively.'
    return 'Manually summarizing the session to trim older turns.'
  }
  if (notice.overflow) return 'Older turns were summarized because the context window was full.'
  if (notice.auto) return 'Older turns were summarized automatically to leave room for new responses.'
  return 'Older turns were manually summarized.'
}

function causeLabel(notice: CompactionNotice) {
  if (notice.overflow) return 'overflow'
  if (notice.auto) return 'auto'
  return 'manual'
}

export function CompactionNoticeCard({ notice }: { notice: CompactionNotice }) {
  const isRunning = notice.status === 'compacting'
  const isOverflow = Boolean(notice.overflow)
  const accent = isOverflow ? 'var(--color-red)' : 'var(--color-amber)'

  return (
    <div
      className="rounded-lg border px-3.5 py-2.5 flex items-start gap-2.5"
      style={{
        borderColor: `color-mix(in srgb, ${accent} 35%, var(--color-border))`,
        background: `color-mix(in srgb, ${accent} 8%, transparent)`,
      }}
    >
      <div className="shrink-0 pt-0.5">
        {isRunning ? (
          <span
            className="inline-block w-3.5 h-3.5 border-2 border-t-transparent rounded-full animate-spin"
            style={{ borderColor: accent, borderTopColor: 'transparent' }}
          />
        ) : (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke={accent} strokeWidth="1.3" strokeLinecap="round">
            <path d="M3 4.5C4.2 3.2 5.4 2.6 7 2.6c2.4 0 4.4 1.8 4.4 4.4 0 .7-.1 1.2-.4 1.8" />
            <path d="M11 9.5C9.8 10.8 8.6 11.4 7 11.4c-2.4 0-4.4-1.8-4.4-4.4 0-.7.1-1.2.4-1.8" />
            <polyline points="9.3,2.8 11.3,2.8 11.3,4.8" />
            <polyline points="4.7,11.2 2.7,11.2 2.7,9.2" />
          </svg>
        )}
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] font-medium" style={{ color: accent }}>
            {notice.status === 'compacting' ? 'Compacting' : 'Compacted'}
          </span>
          <span
            className="text-[10px] uppercase tracking-[0.08em] px-1.5 py-0.5 rounded-full"
            style={{
              color: accent,
              background: `color-mix(in srgb, ${accent} 14%, transparent)`,
            }}
          >
            {causeLabel(notice)}
          </span>
        </div>
        <div className="text-[12px] text-text-secondary leading-relaxed">
          {noticeText(notice)}
        </div>
      </div>
    </div>
  )
}
