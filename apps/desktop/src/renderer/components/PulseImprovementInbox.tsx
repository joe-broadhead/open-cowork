import type { ImprovementReviewQueue } from '@open-cowork/shared'
import { t } from '../helpers/i18n'

export type PulseImprovementReviewAction =
  | 'approve-memory'
  | 'reject-memory'
  | 'approve-proposal'
  | 'reject-proposal'
  | 'archive-proposal'

interface PulseImprovementInboxProps {
  inbox: ImprovementReviewQueue | null
  actionId: string | null
  onReview: (id: string, action: PulseImprovementReviewAction) => void
}

const itemShellStyle = { boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-text) 4%, transparent)' }

function ReviewButton({
  actionId,
  currentActionId,
  label,
  tone = 'neutral',
  onClick,
}: {
  actionId: string
  currentActionId: string | null
  label: string
  tone?: 'accent' | 'muted' | 'neutral'
  onClick: () => void
}) {
  const isCurrentAction = currentActionId === actionId
  const toneClass = tone === 'accent'
    ? 'text-accent hover:border-accent'
    : tone === 'muted'
      ? 'text-text-muted hover:border-border-strong'
      : 'text-text-secondary hover:border-border-strong'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={currentActionId !== null}
      aria-busy={isCurrentAction}
      className={`rounded-full border border-border-subtle px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] disabled:opacity-50 ${toneClass}`}
    >
      {label}
    </button>
  )
}

export function PulseImprovementInbox({ inbox, actionId, onReview }: PulseImprovementInboxProps) {
  const pendingMemories = inbox?.memory || []
  const pendingProposals = inbox?.proposals || []
  const attentionDreamRuns = inbox?.dreamRuns || []
  if (!inbox || (pendingMemories.length === 0 && pendingProposals.length === 0 && attentionDreamRuns.length === 0)) return null

  return (
    <div className="mt-4 space-y-3">
      {pendingProposals.slice(0, 3).map((proposal) => (
        <div
          key={`proposal:${proposal.id}`}
          className="rounded-2xl bg-surface px-4 py-3"
          style={itemShellStyle}
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-[10px] uppercase tracking-[0.14em] text-accent">{t('homepage.card.improvementProposal', 'Improvement proposal')}</span>
            <span className="text-[10px] uppercase tracking-[0.14em] text-text-muted">{proposal.targetType.replace(/_/g, ' ')}</span>
          </div>
          <div className="mt-2 text-[12px] font-medium text-text">{proposal.title}</div>
          <div className="mt-1 line-clamp-2 text-[11px] text-text-secondary leading-relaxed">{proposal.summary}</div>
          <div className="mt-3 flex flex-wrap gap-2">
            <ReviewButton
              actionId={`approve-proposal:${proposal.id}`}
              currentActionId={actionId}
              label={t('homepage.card.approve', 'Approve')}
              tone="accent"
              onClick={() => onReview(proposal.id, 'approve-proposal')}
            />
            <ReviewButton
              actionId={`reject-proposal:${proposal.id}`}
              currentActionId={actionId}
              label={t('homepage.card.reject', 'Reject')}
              onClick={() => onReview(proposal.id, 'reject-proposal')}
            />
            <ReviewButton
              actionId={`archive-proposal:${proposal.id}`}
              currentActionId={actionId}
              label={t('homepage.card.archive', 'Archive')}
              tone="muted"
              onClick={() => onReview(proposal.id, 'archive-proposal')}
            />
          </div>
        </div>
      ))}

      {pendingMemories.slice(0, 2).map((memory) => (
        <div
          key={`memory:${memory.id}`}
          className="rounded-2xl bg-surface px-4 py-3"
          style={itemShellStyle}
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-[10px] uppercase tracking-[0.14em] text-green">{t('homepage.card.memoryCandidate', 'Memory candidate')}</span>
            <span className="text-[10px] uppercase tracking-[0.14em] text-text-muted">{memory.scopeKind}</span>
          </div>
          <div className="mt-2 text-[12px] font-medium text-text">{memory.title}</div>
          <div className="mt-1 line-clamp-2 text-[11px] text-text-secondary leading-relaxed">{memory.summary}</div>
          <div className="mt-3 flex flex-wrap gap-2">
            <ReviewButton
              actionId={`approve-memory:${memory.id}`}
              currentActionId={actionId}
              label={t('homepage.card.approve', 'Approve')}
              tone="accent"
              onClick={() => onReview(memory.id, 'approve-memory')}
            />
            <ReviewButton
              actionId={`reject-memory:${memory.id}`}
              currentActionId={actionId}
              label={t('homepage.card.reject', 'Reject')}
              onClick={() => onReview(memory.id, 'reject-memory')}
            />
          </div>
        </div>
      ))}

      {attentionDreamRuns.slice(0, 2).map((run) => (
        <div
          key={`dream:${run.id}`}
          className="rounded-2xl bg-surface px-4 py-3"
          style={itemShellStyle}
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-[10px] uppercase tracking-[0.14em] text-text-muted">{t('homepage.card.dreamRun', 'Dream run')}</span>
            <span className={run.status === 'failed' ? 'text-[10px] font-semibold uppercase tracking-[0.14em] text-red' : 'text-[10px] font-semibold uppercase tracking-[0.14em] text-accent'}>
              {run.status}
            </span>
          </div>
          <div className="mt-2 text-[12px] font-medium text-text">{run.title}</div>
          {run.error ? <div className="mt-1 line-clamp-2 text-[11px] text-text-secondary leading-relaxed">{run.error}</div> : null}
        </div>
      ))}
    </div>
  )
}
