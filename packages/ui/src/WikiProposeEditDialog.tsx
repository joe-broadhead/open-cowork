import { useMemo, useState } from 'react'
import {
  knowledgeDraftToBlocks,
  knowledgePageBlocksToDraft,
  type KnowledgeBlockDraft,
  type KnowledgePageBlock,
} from '@open-cowork/shared'
import { Dialog } from './Dialog.js'
import { Button } from './Button.js'
import { Input, Textarea } from './Input.js'

const BLOCK_LABELS: Record<KnowledgeBlockDraft['type'], string> = {
  h: 'Heading',
  p: 'Paragraph',
  callout: 'Callout',
  list: 'List (one item per line)',
}

export type WikiProposeEditSubmit = {
  summary: string
  body: KnowledgePageBlock[]
}

export type WikiProposeEditDialogProps = {
  pageTitle: string
  spaceName: string
  blocks: KnowledgePageBlock[]
  busy?: boolean
  error?: string | null
  onSubmit: (input: WikiProposeEditSubmit) => void
  onClose: () => void
}

/**
 * The "Propose edit" composer: a drawer that flattens the current page body into
 * editable text fields (one per block, preserving type), collects a change
 * summary, and submits a non-empty, structure-preserving proposal. Shared by the
 * desktop renderer and Cloud Web so both surfaces propose edits identically; the
 * caller supplies the submit handler (local IPC vs. Cloud API).
 */
export function WikiProposeEditDialog({
  pageTitle,
  spaceName,
  blocks,
  busy = false,
  error = null,
  onSubmit,
  onClose,
}: WikiProposeEditDialogProps) {
  const [summary, setSummary] = useState('')
  const [drafts, setDrafts] = useState<KnowledgeBlockDraft[]>(() => knowledgePageBlocksToDraft(blocks))

  const body = useMemo(() => knowledgeDraftToBlocks(drafts), [drafts])
  const canSubmit = Boolean(summary.trim()) && body.length > 0 && !busy

  const updateDraft = (id: string, text: string) => {
    setDrafts((current) => current.map((draft) => (draft.id === id ? { ...draft, text } : draft)))
  }

  return (
    <Dialog
      title={`Propose edit — ${pageTitle}`}
      variant="drawer"
      size="lg"
      onClose={onClose}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            variant="primary"
            leftIcon="file-diff"
            disabled={!canSubmit}
            disabledReason={!summary.trim() ? 'Add a summary' : body.length === 0 ? 'Add some content' : undefined}
            onClick={() => onSubmit({ summary: summary.trim(), body })}
          >
            {busy ? 'Submitting' : 'Submit proposal'}
          </Button>
        </>
      )}
    >
      <div className="studio-wiki-propose">
        <p className="studio-wiki-propose__hint">
          Edits go to {spaceName} as a proposal for a Maintainer to review before a new version is published.
        </p>
        <label className="studio-wiki-propose__field">
          <span>Summary</span>
          <Input
            value={summary}
            placeholder="Describe what this edit changes"
            disabled={busy}
            onChange={(event) => setSummary(event.target.value)}
          />
        </label>
        {drafts.map((draft) => (
          <label key={draft.id} className="studio-wiki-propose__field">
            <span>{BLOCK_LABELS[draft.type]}</span>
            <Textarea
              value={draft.text}
              autoGrow
              maxHeight="md"
              disabled={busy}
              onChange={(event) => updateDraft(draft.id, event.target.value)}
            />
          </label>
        ))}
        {error ? <p role="alert" className="studio-wiki-propose__error">{error}</p> : null}
      </div>
    </Dialog>
  )
}
