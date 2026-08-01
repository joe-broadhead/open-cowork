import { useMemo, useState } from 'react'
import {
  KNOWLEDGE_VISIBILITIES,
  knowledgeVisibilityLabel,
  type KnowledgeSpaceVisibility,
} from '@open-cowork/shared'
import { Button, Dialog, Input, Select } from '@open-cowork/ui'
import { t } from '../../helpers/i18n'

export function KnowledgeNewSpaceDialog({ busy, error, initialName = '', initialVisibility = 'company', resuming = false, onSubmit, onClose }: {
  busy: boolean
  error: string | null
  initialName?: string
  initialVisibility?: KnowledgeSpaceVisibility
  resuming?: boolean
  onSubmit: (input: { name: string; visibility: KnowledgeSpaceVisibility }) => void
  onClose: () => void
}) {
  const [name, setName] = useState(initialName)
  const [visibility, setVisibility] = useState<KnowledgeSpaceVisibility>(initialVisibility)
  const trimmedName = name.trim()
  const canSubmit = Boolean(trimmedName) && !busy
  const visibilityOptions = useMemo(
    () => KNOWLEDGE_VISIBILITIES.map((value) => ({ value, label: knowledgeVisibilityLabel(value) })),
    [],
  )

  return (
    <Dialog
      title={t('knowledge.newSpace.title', 'New Space')}
      size="sm"
      onClose={onClose}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('knowledge.newSpace.cancel', 'Cancel')}
          </Button>
          <Button
            variant="primary"
            leftIcon="plus"
            disabled={!canSubmit}
            disabledReason={!trimmedName ? t('knowledge.newSpace.needName', 'Add a name') : undefined}
            onClick={() => onSubmit({ name: trimmedName, visibility })}
          >
            {busy
              ? t('knowledge.newSpace.creating', 'Creating')
              : resuming
                ? t('knowledge.newSpace.finish', 'Finish')
                : t('knowledge.newSpace.create', 'Create')}
          </Button>
        </>
      )}
    >
      <div className="studio-wiki-propose">
        <p className="studio-wiki-propose__hint">
          {resuming
            ? t('knowledge.newSpace.resumeHint', 'Finish publishing the Overview page for this Space before starting another one.')
            : t('knowledge.newSpace.hint', 'Spaces group related pages and set who can read, propose, and review them.')}
        </p>
        <label className="studio-wiki-propose__field">
          <span>{t('knowledge.newSpace.nameLabel', 'Name')}</span>
          <Input
            value={name}
            placeholder={t('knowledge.newSpace.namePlaceholder', 'e.g. Onboarding')}
            disabled={busy || resuming}
            autoFocus
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="studio-wiki-propose__field">
          <span>{t('knowledge.newSpace.visibilityLabel', 'Visibility')}</span>
          <Select
            label={t('knowledge.newSpace.visibilityLabel', 'Visibility')}
            value={visibility}
            options={visibilityOptions}
            disabled={busy || resuming}
            onChange={(value) => setVisibility(value as KnowledgeSpaceVisibility)}
          />
        </label>
        {error ? <p role="alert" className="studio-wiki-propose__error">{error}</p> : null}
      </div>
    </Dialog>
  )
}
