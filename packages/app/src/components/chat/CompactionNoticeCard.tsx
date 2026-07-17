import type { CompactionNotice } from '../../stores/session'
import { t } from '../../helpers/i18n'
import { Badge, Card, Icon, type BadgeTone } from '@open-cowork/ui'

// Describe why this compaction happened. Overflow = the context window was
// full and the runtime had no choice. Voluntary = auto-compaction fired
// proactively while there was still slack, or the user invoked it manually.
function noticeText(notice: CompactionNotice) {
  if (notice.status === 'compacting') {
    if (notice.overflow) return t('compaction.runningOverflow', 'Context window overflowed — shortening older turns to make room.')
    if (notice.auto) return t('compaction.runningAuto', 'Approaching the context limit — compacting proactively.')
    return t('compaction.runningManual', 'Manually summarizing the session to trim older turns.')
  }
  if (notice.overflow) return t('compaction.doneOverflow', 'Older turns were summarized because the context window was full.')
  if (notice.auto) return t('compaction.doneAuto', 'Older turns were summarized automatically to leave room for new responses.')
  return t('compaction.doneManual', 'Older turns were manually summarized.')
}

function causeLabel(notice: CompactionNotice) {
  if (notice.overflow) return t('compaction.causeOverflow', 'overflow')
  if (notice.auto) return t('compaction.causeAuto', 'auto')
  return t('compaction.causeManual', 'manual')
}

export function CompactionNoticeCard({ notice }: { notice: CompactionNotice }) {
  const isRunning = notice.status === 'compacting'
  const isOverflow = Boolean(notice.overflow)
  // Overflow is the only forced compaction, so it earns the louder danger tone;
  // proactive/manual compactions stay on the calmer warning tone.
  const tone: BadgeTone = isOverflow ? 'danger' : 'warning'
  const accentColor = isOverflow ? 'text-red' : 'text-amber'

  return (
    <Card variant="flat" padding="sm" className="flex items-start gap-2.5">
      <div className={`shrink-0 pt-0.5 ${accentColor}`}>
        <Icon
          name={isRunning ? 'loader-circle' : 'rotate-ccw'}
          size={16}
          className={isRunning ? 'ui-spin' : undefined}
        />
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-2xs font-[750] uppercase tracking-[0.06em] ${accentColor}`}>
            {notice.status === 'compacting' ? t('compaction.running', 'Compacting') : t('compaction.done', 'Compacted')}
          </span>
          <Badge tone={tone} className="uppercase tracking-[0.06em]">
            {causeLabel(notice)}
          </Badge>
        </div>
        <div className="text-xs text-text-secondary leading-relaxed">
          {noticeText(notice)}
        </div>
      </div>
    </Card>
  )
}
