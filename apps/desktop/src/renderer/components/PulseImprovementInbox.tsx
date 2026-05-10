import { useEffect, useState } from 'react'
import {
  improvementProposalApprovalBlockReason,
  type ImprovementProposalDraft,
  type ImprovementReviewQueue,
} from '@open-cowork/shared'
import { t } from '../helpers/i18n'
import { DreamRunInspection, MemoryInspection, ProposalInspection } from './PulseImprovementInspection'
import { PulseImprovementProposalEditor } from './PulseImprovementProposalEditor'

export type PulseImprovementReviewAction =
  | 'approve-memory'
  | 'reject-memory'
  | 'approve-proposal'
  | 'reject-proposal'
  | 'archive-proposal'
  | 'cancel-dream'
  | 'archive-dream'

interface PulseImprovementInboxProps {
  inbox: ImprovementReviewQueue | null
  actionId: string | null
  onReview: (id: string, action: PulseImprovementReviewAction) => void
  onUpdateProposal: (id: string, draft: ImprovementProposalDraft) => Promise<boolean>
}

const itemShellStyle = { boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-text) 4%, transparent)' }

function ReviewButton({
  actionId,
  currentActionId,
  label,
  tone = 'neutral',
  disabled = false,
  title,
  onClick,
}: {
  actionId: string
  currentActionId: string | null
  label: string
  tone?: 'accent' | 'muted' | 'neutral'
  disabled?: boolean
  title?: string
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
      disabled={disabled || currentActionId !== null}
      aria-busy={isCurrentAction}
      title={title}
      className={`rounded-full border border-border-subtle px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] disabled:opacity-50 ${toneClass}`}
    >
      {label}
    </button>
  )
}

export function PulseImprovementInbox({ inbox, actionId, onReview, onUpdateProposal }: PulseImprovementInboxProps) {
  const [editingProposalId, setEditingProposalId] = useState<string | null>(null)
  const pendingMemories = inbox?.memory || []
  const pendingProposals = inbox?.proposals || []
  const visibleProposals = pendingProposals.slice(0, 3)
  const attentionDreamRuns = inbox?.dreamRuns || []

  useEffect(() => {
    if (editingProposalId && !pendingProposals.slice(0, 3).some((proposal) => proposal.id === editingProposalId)) {
      setEditingProposalId(null)
    }
  }, [editingProposalId, pendingProposals])

  if (!inbox || (pendingMemories.length === 0 && pendingProposals.length === 0 && attentionDreamRuns.length === 0)) return null

  return (
    <div className="mt-4 space-y-3">
      {visibleProposals.map((proposal) => {
        const approvalBlockReason = improvementProposalApprovalBlockReason(proposal)
        const canApproveProposal = approvalBlockReason === null
        const approvalUnavailableMessage = approvalBlockReason === 'agent-scope'
          ? t(
              'homepage.card.agentProposalApprovalUnavailable',
              'Project-scoped agent proposals need an explicit project grant before approval. Reject, archive, or leave it queued for now.',
            )
          : approvalBlockReason === 'skill-scope'
          ? t(
              'homepage.card.skillProposalApprovalUnavailable',
              'Project-scoped skill proposals need an explicit project grant before approval. Reject, archive, or leave it queued for now.',
            )
          : t(
              'homepage.card.proposalApprovalUnavailable',
              'Approval for this proposal type is waiting for a typed persistence path. Reject, archive, or leave it queued for now.',
            )
        return (
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
            {!canApproveProposal ? (
              <div className="mt-2 rounded-xl border border-border-subtle bg-surface-elevated px-3 py-2 text-[11px] leading-relaxed text-text-muted">
                {approvalUnavailableMessage}
              </div>
            ) : null}
            <ProposalInspection proposal={proposal} />
            <PulseImprovementProposalEditor
              proposal={proposal}
              actionId={actionId}
              editing={editingProposalId === proposal.id}
              editDisabled={actionId !== null || (editingProposalId !== null && editingProposalId !== proposal.id)}
              onEditingChange={(editing) => setEditingProposalId(editing ? proposal.id : null)}
              onUpdate={onUpdateProposal}
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <ReviewButton
                actionId={`approve-proposal:${proposal.id}`}
                currentActionId={actionId}
                label={t('homepage.card.approve', 'Approve')}
                tone="accent"
                disabled={editingProposalId !== null || !canApproveProposal}
                title={!canApproveProposal ? approvalUnavailableMessage : undefined}
                onClick={() => onReview(proposal.id, 'approve-proposal')}
              />
              <ReviewButton
                actionId={`reject-proposal:${proposal.id}`}
                currentActionId={actionId}
                label={t('homepage.card.reject', 'Reject')}
                disabled={editingProposalId !== null}
                onClick={() => onReview(proposal.id, 'reject-proposal')}
              />
              <ReviewButton
                actionId={`archive-proposal:${proposal.id}`}
                currentActionId={actionId}
                label={t('homepage.card.archive', 'Archive')}
                tone="muted"
                disabled={editingProposalId !== null}
                onClick={() => onReview(proposal.id, 'archive-proposal')}
              />
            </div>
          </div>
        )
      })}

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
          <MemoryInspection memory={memory} />
          <div className="mt-3 flex flex-wrap gap-2">
            <ReviewButton
              actionId={`approve-memory:${memory.id}`}
              currentActionId={actionId}
              label={t('homepage.card.approve', 'Approve')}
              tone="accent"
              disabled={editingProposalId !== null}
              onClick={() => onReview(memory.id, 'approve-memory')}
            />
            <ReviewButton
              actionId={`reject-memory:${memory.id}`}
              currentActionId={actionId}
              label={t('homepage.card.reject', 'Reject')}
              disabled={editingProposalId !== null}
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
          <DreamRunInspection run={run} />
          <div className="mt-3 flex flex-wrap gap-2">
            {run.status === 'running' ? (
              <ReviewButton
                actionId={`cancel-dream:${run.id}`}
                currentActionId={actionId}
                label={t('homepage.card.cancel', 'Cancel')}
                disabled={editingProposalId !== null}
                onClick={() => onReview(run.id, 'cancel-dream')}
              />
            ) : null}
            {run.status === 'failed' || run.status === 'cancelled' ? (
              <ReviewButton
                actionId={`archive-dream:${run.id}`}
                currentActionId={actionId}
                label={t('homepage.card.archive', 'Archive')}
                tone="muted"
                disabled={editingProposalId !== null}
                onClick={() => onReview(run.id, 'archive-dream')}
              />
            ) : null}
          </div>
        </div>
      ))}
    </div>
  )
}
