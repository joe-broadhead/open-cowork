import { useEffect, useMemo, useState } from 'react'
import type { ImprovementCandidateDiff, ImprovementProposal, ImprovementProposalDraft } from '@open-cowork/shared'
import { t } from '../helpers/i18n'

interface ProposalEditorState {
  title: string
  summary: string
  memoryTitle: string
  memorySummary: string
  memoryBody: string
}

interface PulseImprovementProposalEditorProps {
  proposal: ImprovementProposal
  actionId: string | null
  editing: boolean
  editDisabled: boolean
  onEditingChange: (editing: boolean) => void
  onUpdate: (id: string, draft: ImprovementProposalDraft) => Promise<boolean>
}

function payloadText(diff: ImprovementCandidateDiff | null, key: string) {
  if (!diff) return ''
  const value = diff.payload[key]
  return typeof value === 'string' ? value : ''
}

function editableMemoryDiffIndex(proposal: ImprovementProposal) {
  return proposal.candidateDiffs.findIndex((diff) => (
    diff.targetType === 'memory' && diff.operation !== 'delete'
  ))
}

function editorStateFromProposal(proposal: ImprovementProposal): ProposalEditorState {
  const diff = proposal.candidateDiffs[editableMemoryDiffIndex(proposal)] || null
  return {
    title: proposal.title,
    summary: proposal.summary,
    memoryTitle: payloadText(diff, 'title') || proposal.title,
    memorySummary: payloadText(diff, 'summary') || diff?.summary || proposal.summary,
    memoryBody: payloadText(diff, 'body'),
  }
}

function buildDraft(proposal: ImprovementProposal, state: ProposalEditorState): ImprovementProposalDraft {
  const memoryDiffIndex = editableMemoryDiffIndex(proposal)
  const candidateDiffs = proposal.candidateDiffs.map((diff, index) => {
    if (index !== memoryDiffIndex) return diff
    return {
      ...diff,
      summary: state.memorySummary.trim() || diff.summary,
      afterHash: null,
      payload: {
        ...diff.payload,
        title: state.memoryTitle.trim(),
        summary: state.memorySummary.trim(),
        body: state.memoryBody,
      },
    }
  })
  return {
    targetType: proposal.targetType,
    targetId: proposal.targetId,
    title: state.title.trim(),
    summary: state.summary.trim(),
    evidence: proposal.evidence,
    candidateDiffs,
  }
}

function hasChanges(proposal: ImprovementProposal, state: ProposalEditorState) {
  const original = editorStateFromProposal(proposal)
  return original.title !== state.title
    || original.summary !== state.summary
    || original.memoryTitle !== state.memoryTitle
    || original.memorySummary !== state.memorySummary
    || original.memoryBody !== state.memoryBody
}

export function PulseImprovementProposalEditor({
  proposal,
  actionId,
  editing,
  editDisabled,
  onEditingChange,
  onUpdate,
}: PulseImprovementProposalEditorProps) {
  const [state, setState] = useState<ProposalEditorState>(() => editorStateFromProposal(proposal))
  const memoryDiffIndex = useMemo(() => editableMemoryDiffIndex(proposal), [proposal])
  const hasEditableMemoryDiff = memoryDiffIndex >= 0
  const isSaving = actionId === `update-proposal:${proposal.id}`
  const isBusy = actionId !== null
  const canSave = state.title.trim().length > 0
    && state.summary.trim().length > 0
    && (!hasEditableMemoryDiff || (
      state.memoryTitle.trim().length > 0
      && state.memorySummary.trim().length > 0
      && state.memoryBody.trim().length > 0
    ))
    && hasChanges(proposal, state)
    && !isBusy

  useEffect(() => {
    if (!editing) setState(editorStateFromProposal(proposal))
  }, [editing, proposal])

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => onEditingChange(true)}
        disabled={editDisabled}
        className="rounded-full border border-border-subtle px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-secondary hover:border-border-strong disabled:opacity-50"
      >
        {t('homepage.card.editProposal', 'Edit')}
      </button>
    )
  }

  async function save() {
    if (!canSave) return
    const saved = await onUpdate(proposal.id, buildDraft(proposal, state))
    if (saved) onEditingChange(false)
  }

  return (
    <form
      className="mt-3 rounded-2xl border border-border-subtle bg-bg px-3 py-3"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <div className="grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
        <label className="block">
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">{t('homepage.card.proposalTitle', 'Proposal title')}</span>
          <input
            value={state.title}
            onChange={(event) => setState((current) => ({ ...current, title: event.target.value }))}
            disabled={isBusy}
            className="mt-1 w-full rounded-xl border border-border-subtle bg-surface px-3 py-2 text-[12px] text-text outline-none focus:border-accent disabled:opacity-60"
          />
        </label>
        <label className="block">
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">{t('homepage.card.proposalSummary', 'Proposal summary')}</span>
          <textarea
            value={state.summary}
            onChange={(event) => setState((current) => ({ ...current, summary: event.target.value }))}
            disabled={isBusy}
            rows={3}
            className="mt-1 w-full resize-y rounded-xl border border-border-subtle bg-surface px-3 py-2 text-[12px] text-text outline-none focus:border-accent disabled:opacity-60"
          />
        </label>
      </div>
      {hasEditableMemoryDiff ? (
        <div className="mt-3 space-y-3 rounded-2xl bg-surface px-3 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-green">
            {t('homepage.card.memoryDraft', 'Candidate memory draft')}
          </div>
          <div className="grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">{t('homepage.card.memoryTitle', 'Memory title')}</span>
              <input
                value={state.memoryTitle}
                onChange={(event) => setState((current) => ({ ...current, memoryTitle: event.target.value }))}
                disabled={isBusy}
                className="mt-1 w-full rounded-xl border border-border-subtle bg-bg px-3 py-2 text-[12px] text-text outline-none focus:border-accent disabled:opacity-60"
              />
            </label>
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">{t('homepage.card.memorySummary', 'Memory summary')}</span>
              <input
                value={state.memorySummary}
                onChange={(event) => setState((current) => ({ ...current, memorySummary: event.target.value }))}
                disabled={isBusy}
                className="mt-1 w-full rounded-xl border border-border-subtle bg-bg px-3 py-2 text-[12px] text-text outline-none focus:border-accent disabled:opacity-60"
              />
            </label>
          </div>
          <label className="block">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">{t('homepage.card.memoryBody', 'Memory body')}</span>
            <textarea
              value={state.memoryBody}
              onChange={(event) => setState((current) => ({ ...current, memoryBody: event.target.value }))}
              disabled={isBusy}
              rows={5}
              className="mt-1 w-full resize-y rounded-xl border border-border-subtle bg-bg px-3 py-2 text-[12px] text-text outline-none focus:border-accent disabled:opacity-60"
            />
          </label>
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={!canSave}
          aria-busy={isSaving}
          className="rounded-full border border-border-subtle px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-accent hover:border-accent disabled:opacity-50"
        >
          {t('homepage.card.saveProposal', 'Save')}
        </button>
        <button
          type="button"
          onClick={() => {
            setState(editorStateFromProposal(proposal))
            onEditingChange(false)
          }}
          disabled={isBusy}
          className="rounded-full border border-border-subtle px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted hover:border-border-strong disabled:opacity-50"
        >
          {t('homepage.card.cancelEdit', 'Cancel')}
        </button>
      </div>
    </form>
  )
}
