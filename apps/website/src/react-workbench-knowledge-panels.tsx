import { useState } from 'react'
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Icon,
  Input,
  Select,
  type IconName,
} from '@open-cowork/ui'
import type {
  KnowledgePageVersion,
  KnowledgeProposal,
  KnowledgeSnapshotPayload,
  KnowledgeSpace,
  KnowledgeSpaceVisibility,
} from '@open-cowork/shared'
import { knowledgeRoleCanReview } from '@open-cowork/shared'
import {
  KNOWLEDGE_DEFAULT_VISIBILITY,
  KNOWLEDGE_VISIBILITY_OPTIONS,
} from './react-workbench-knowledge-state.ts'

export function formatKnowledgeDate(value: string | null | undefined) {
  if (!value) return 'Unknown'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

// A single capability pill. Lit (accent) when the viewer's access grants it, dimmed
// when it doesn't — so "what can I do here" reads at a glance instead of the old
// "Space role - read + propose + review" string concat.
function AccessChip({ icon, label, granted }: { icon: IconName; label: string; granted: boolean }) {
  return (
    <Badge tone={granted ? 'accent' : 'muted'} className={granted ? undefined : 'opacity-60'}>
      <span className="knowledge-access-chip">
        <Icon name={icon} size={16} aria-hidden />
        {label}
      </span>
    </Badge>
  )
}

// "Your access" panel. Read is granted for any Space the viewer can see; Propose follows
// the per-Space role; Review reflects the cloud's owner/admin authority *and* the Space's
// Maintainer role, matching the actual accept/restore gate.
export function KnowledgeAccessPanel({ space, canPropose, canReview }: {
  space: KnowledgeSpace | null
  canPropose: boolean
  canReview: boolean
}) {
  return (
    <Card padding="md">
      <div className="knowledge-panel-heading">
        <strong>Your access</strong>
        {space ? <Badge tone="neutral">{space.role}</Badge> : null}
      </div>
      {space ? (
        <>
          <div className="knowledge-access-chips">
            <AccessChip icon="book-open" label="Read" granted />
            <AccessChip icon="file-diff" label="Propose" granted={canPropose} />
            <AccessChip icon="shield-check" label="Review" granted={canReview} />
          </div>
          <p className="knowledge-access-hint">
            {canReview
              ? 'You can propose edits and publish or decline proposals in this Space.'
              : canPropose
                ? 'You can propose edits; a maintainer reviews and publishes them.'
                : 'You can read this Space. Ask a maintainer for propose access.'}
          </p>
        </>
      ) : (
        <p className="knowledge-access-hint">Open a page to see what you can do in its Space.</p>
      )}
    </Card>
  )
}

// First-run guidance: when a workspace has no Spaces yet, teach the
// capture -> review -> publish model instead of showing an empty scaffold.
export function KnowledgeFirstRun({ onNewSpace, canCreate }: { onNewSpace: () => void; canCreate: boolean }) {
  const steps: Array<{ icon: IconName; title: string; body: string }> = [
    { icon: 'message-square', title: 'Capture', body: 'Coworkers turn useful chat outcomes into draft pages.' },
    { icon: 'file-diff', title: 'Review', body: 'You accept or decline each proposed edit before it lands.' },
    { icon: 'book-open', title: 'Publish', body: 'Accepted edits become versioned pages, grouped into Spaces.' },
  ]
  return (
    <Card padding="lg" className="knowledge-first-run">
      <div className="knowledge-first-run__intro">
        <span className="knowledge-first-run__badge">
          <Icon name="sparkles" size={24} aria-hidden />
        </span>
        <h2>Start your knowledge base</h2>
        <p>Spaces hold pages your team can trust. Here is how knowledge gets in and stays current:</p>
      </div>
      <div className="knowledge-first-run__steps">
        {steps.map((step, index) => (
          <div key={step.title} className="knowledge-first-run__step">
            <div className="knowledge-first-run__step-head">
              <span className="knowledge-first-run__step-icon">
                <Icon name={step.icon} size={16} aria-hidden />
              </span>
              <span className="knowledge-first-run__step-label">Step {index + 1}</span>
            </div>
            <h3>{step.title}</h3>
            <p>{step.body}</p>
          </div>
        ))}
      </div>
      <div className="knowledge-first-run__action">
        <Button
          variant="primary"
          leftIcon="plus"
          onClick={onNewSpace}
          disabled={!canCreate}
          disabledReason={canCreate ? undefined : 'You need admin access to create a space.'}
        >
          Create your first Space
        </Button>
      </div>
    </Card>
  )
}

// Version timeline (vN - author - date, current marked, restore for the cloud's owner/admin
// reviewers) — ports the desktop history surface, reusing the shared .studio-version-* classes.
export function KnowledgeVersionHistory({ versions, currentVersion, canRestore, busyVersionId, onRestore }: {
  versions: KnowledgePageVersion[]
  currentVersion: number
  canRestore: boolean
  busyVersionId: string | null
  onRestore: (version: KnowledgePageVersion) => void
}) {
  return (
    <Card padding="md">
      <div className="knowledge-panel-heading"><strong>Version history</strong><Badge tone="neutral">{versions.length}</Badge></div>
      <div className="studio-version-timeline">
        {versions.map((version, index) => {
          const isCurrent = version.version === currentVersion
          return (
            <div key={`${version.id}:${version.version}`} className="studio-version-row">
              <div className="studio-version-rail" aria-hidden="true">
                <span className={`studio-version-dot${isCurrent ? ' is-current' : ''}`} />
                {index < versions.length - 1 ? <span className="studio-version-connector" /> : null}
              </div>
              <div className="studio-version-body">
                <div className="knowledge-history-row__top">
                  <strong>v{version.version}</strong>
                  <small>{formatKnowledgeDate(version.updatedAt)}</small>
                </div>
                <div className="knowledge-history-row__meta">
                  <span className="knowledge-history-row__author">
                    <span>{version.updatedBy}</span>
                    {version.proposalId ? <Badge tone="muted">from proposal</Badge> : null}
                  </span>
                  {isCurrent ? (
                    <Badge tone="accent">Current</Badge>
                  ) : canRestore ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      leftIcon="rotate-ccw"
                      disabled={Boolean(busyVersionId)}
                      onClick={() => onRestore(version)}
                    >
                      {busyVersionId === version.versionId ? 'Restoring' : 'Restore'}
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          )
        })}
        {!versions.length ? <p className="empty">No versions loaded.</p> : null}
      </div>
    </Card>
  )
}

export function KnowledgeNewSpaceDialog({
  busy,
  error,
  onCreate,
  onClose,
}: {
  busy: boolean
  error: string | null
  onCreate: (input: { name: string; visibility: KnowledgeSpaceVisibility }) => void
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [visibility, setVisibility] = useState<KnowledgeSpaceVisibility>(KNOWLEDGE_DEFAULT_VISIBILITY)
  const trimmed = name.trim()
  const canCreate = Boolean(trimmed) && !busy

  return (
    <Dialog
      title="New Space"
      size="sm"
      onClose={onClose}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            variant="primary"
            leftIcon="plus"
            disabled={!canCreate}
            disabledReason={!trimmed ? 'Add a name' : undefined}
            onClick={() => onCreate({ name: trimmed, visibility })}
          >
            {busy ? 'Creating' : 'Create'}
          </Button>
        </>
      )}
    >
      <div className="studio-wiki-propose">
        <p className="studio-wiki-propose__hint">
          A Space groups related pages. You become its Maintainer and can publish the first page from a proposal.
        </p>
        <label className="studio-wiki-propose__field">
          <span>Name</span>
          <Input
            value={name}
            placeholder="e.g. Engineering, Onboarding"
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="studio-wiki-propose__field">
          <span>Visibility</span>
          <Select
            label="Space visibility"
            value={visibility}
            options={KNOWLEDGE_VISIBILITY_OPTIONS}
            disabled={busy}
            onChange={(next) => setVisibility(next as KnowledgeSpaceVisibility)}
          />
        </label>
        {error ? <p role="alert" className="studio-wiki-propose__error">{error}</p> : null}
      </div>
    </Dialog>
  )
}

export function KnowledgeReviewQueue({
  snapshot,
  canReviewKnowledge,
  busyProposalId,
  onAccept,
  onDecline,
}: {
  snapshot: KnowledgeSnapshotPayload
  canReviewKnowledge: boolean
  busyProposalId: string | null
  onAccept: (proposal: KnowledgeProposal) => void
  onDecline: (proposal: KnowledgeProposal) => void
}) {
  if (!snapshot.proposals.length) {
    return (
      <Card padding="md">
        <EmptyState
          icon="check"
          title="Nothing to review"
          body="Captured Cloud chat context and coworker proposals appear here before they become published knowledge."
        />
      </Card>
    )
  }

  return (
    <Card padding="md">
      <div className="knowledge-panel-heading"><strong>Review queue</strong><Badge tone="warning">{snapshot.proposals.length}</Badge></div>
      <div className="knowledge-review-list">
        {snapshot.proposals.map((proposal) => {
          const space = snapshot.spaces.find((candidate) => candidate.id === proposal.spaceId)
          const canReview = canReviewKnowledge && Boolean(space && knowledgeRoleCanReview(space.role))
          const busy = busyProposalId === proposal.id
          return (
            <Card key={proposal.id} variant="flat" padding="sm">
              <div className="knowledge-proposal-card__head">
                <strong>{proposal.pageTitle}</strong>
                <span className="knowledge-diff-stat">
                  <span className="knowledge-diff-stat__add">+{proposal.add}</span>
                  <span className="knowledge-diff-stat__sep"> / </span>
                  <span className="knowledge-diff-stat__del">-{proposal.del}</span>
                </span>
              </div>
              <p>{proposal.summary}</p>
              <small>{space?.name || 'Unknown space'} - {proposal.by} - {formatKnowledgeDate(proposal.when)}</small>
              <div className="knowledge-proposal-card__actions">
                <Button size="sm" variant="ghost" disabled={busy || !canReview} onClick={() => onDecline(proposal)}>Decline</Button>
                <Button size="sm" variant="primary" disabled={busy || !canReview} onClick={() => onAccept(proposal)}>Accept</Button>
              </div>
            </Card>
          )
        })}
        {!canReviewKnowledge ? <p className="empty">Knowledge review requires an owner/admin Cloud role.</p> : null}
      </div>
    </Card>
  )
}
