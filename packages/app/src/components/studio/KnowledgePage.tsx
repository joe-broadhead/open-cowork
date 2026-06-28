import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  KnowledgePage as KnowledgePageRecord,
  KnowledgePageBlock as KnowledgePageBlockRecord,
  KnowledgePageLink,
  KnowledgePageVersion,
  KnowledgeProposal,
  KnowledgeSnapshotPayload,
  KnowledgeSpace,
} from '@open-cowork/shared'
import type { KnowledgeSpaceVisibility } from '@open-cowork/shared'
import { KNOWLEDGE_VISIBILITIES, knowledgeRoleCanPropose, knowledgeRoleCanReview, knowledgeVisibilityLabel } from '@open-cowork/shared'
import { useSessionStore } from '../../stores/session'
import { LOCAL_WORKSPACE_ID } from '../../stores/session-workspace-keys'
import { t } from '../../helpers/i18n'
import { RestrictedState } from '../RestrictedState'
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Icon,
  type IconName,
  Input,
  KnowledgeGraph,
  SegmentedControl,
  Select,
  Skeleton,
  StudioPageHeader,
  WikiPage,
  WikiProposeEditDialog,
  type WikiProposeEditSubmit,
  WikiSpaceRail,
  type WikiPageBlock,
  type WikiSpace,
} from '../ui'

const EMPTY_SNAPSHOT: KnowledgeSnapshotPayload = {
  spaces: [],
  pages: [],
  proposals: [],
  graph: { nodes: [], edges: [] },
}

function formatDate(value: string | null | undefined) {
  if (!value) return t('knowledge.unknownDate', 'Unknown')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function visibilityLabel(space: KnowledgeSpace) {
  if (space.visibility === 'company') return t('knowledge.visibility.company', knowledgeVisibilityLabel('company'))
  if (space.visibility === 'team') return t('knowledge.visibility.team', knowledgeVisibilityLabel('team'))
  return t('knowledge.visibility.private', knowledgeVisibilityLabel('private'))
}

function linkIcon(kind: KnowledgePageLink['kind']): IconName {
  if (kind === 'artifact') return 'file'
  if (kind === 'task') return 'list-checks'
  return 'message-square'
}

function blockToWiki(block: KnowledgePageBlockRecord, index: number): WikiPageBlock {
  const id = block.id || `block-${index + 1}`
  if (block.type === 'h') return { id, type: 'heading', text: block.text }
  if (block.type === 'p') return { id, type: 'paragraph', text: block.text }
  if (block.type === 'callout') return { id, type: 'callout', text: block.text, icon: 'info' }
  return { id, type: 'list', items: block.items }
}

function wikiSpaces(spaces: KnowledgeSpace[], pages: KnowledgePageRecord[]): WikiSpace[] {
  return spaces.map((space) => ({
    id: space.id,
    name: space.name,
    icon: space.icon === 'book-open' ? 'book-open' : undefined,
    visibility: knowledgeVisibilityLabel(space.visibility),
    role: space.role,
    pages: pages
      .filter((page) => page.spaceId === space.id)
      .map((page) => ({ id: page.id, title: page.title })),
  }))
}

function pageSpace(snapshot: KnowledgeSnapshotPayload, page: KnowledgePageRecord | null) {
  return page ? snapshot.spaces.find((space) => space.id === page.spaceId) || null : null
}

function proposalSpace(snapshot: KnowledgeSnapshotPayload, proposal: KnowledgeProposal) {
  return snapshot.spaces.find((space) => space.id === proposal.spaceId) || null
}

function firstReadablePage(snapshot: KnowledgeSnapshotPayload) {
  return snapshot.pages[0] || null
}

// A single capability pill. Lit (accent) when the viewer's Space role grants it,
// dimmed when it doesn't — so "what can I do here" reads at a glance instead of
// the old "Maintainer: read + propose + review" string concat.
function AccessChip({ icon, label, granted }: { icon: IconName; label: string; granted: boolean }) {
  return (
    <Badge tone={granted ? 'accent' : 'muted'} className={granted ? undefined : 'opacity-60'}>
      <span className="inline-flex items-center gap-1.5">
        <Icon name={icon} size={16} aria-hidden />
        {label}
      </span>
    </Badge>
  )
}

function AccessPanel({ space, canPropose, canReview }: {
  space: KnowledgeSpace | null
  canPropose: boolean
  canReview: boolean
}) {
  return (
    <Card padding="md">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-display text-role-card-title font-bold text-text">{t('knowledge.access.title', 'Your access')}</h2>
        {space ? <Badge tone="neutral">{space.role}</Badge> : null}
      </div>
      {space ? (
        <>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <AccessChip icon="book-open" label={t('knowledge.access.read', 'Read')} granted />
            <AccessChip icon="file-diff" label={t('knowledge.access.propose', 'Propose')} granted={canPropose} />
            <AccessChip icon="shield-check" label={t('knowledge.access.review', 'Review')} granted={canReview} />
          </div>
          <p className="mt-3 text-2xs leading-relaxed text-text-muted">
            {canReview
              ? t('knowledge.access.reviewHint', 'You can propose edits and publish or decline proposals in this Space.')
              : canPropose
                ? t('knowledge.access.proposeHint', 'You can propose edits; a maintainer reviews and publishes them.')
                : t('knowledge.access.readHint', 'You can read this Space. Ask a maintainer for propose access.')}
          </p>
        </>
      ) : (
        <p className="mt-3 text-2xs leading-relaxed text-text-muted">
          {t('knowledge.access.noSelection', 'Open a page to see what you can do in its Space.')}
        </p>
      )}
    </Card>
  )
}

// First-run guidance: when a workspace has no Spaces yet, teach the
// capture -> review -> publish model instead of showing an empty 3-column scaffold.
function KnowledgeFirstRun({ onNewSpace }: { onNewSpace: () => void }) {
  const steps: Array<{ icon: IconName; title: string; body: string }> = [
    { icon: 'message-square', title: t('knowledge.firstRun.captureTitle', 'Capture'), body: t('knowledge.firstRun.captureBody', 'Coworkers turn useful chat outcomes into draft pages.') },
    { icon: 'file-diff', title: t('knowledge.firstRun.reviewTitle', 'Review'), body: t('knowledge.firstRun.reviewBody', 'You accept or decline each proposed edit before it lands.') },
    { icon: 'book-open', title: t('knowledge.firstRun.publishTitle', 'Publish'), body: t('knowledge.firstRun.publishBody', 'Accepted edits become versioned pages, grouped into Spaces.') },
  ]
  return (
    <Card padding="lg" className="mx-auto w-full max-w-[640px]">
      <div className="flex flex-col items-center text-center">
        <span className="grid h-12 w-12 place-items-center rounded-2xl border border-border-subtle bg-surface text-accent">
          <Icon name="sparkles" size={24} aria-hidden />
        </span>
        <h2 className="mt-4 font-display text-role-card-title font-bold text-text">{t('knowledge.firstRun.title', 'Start your knowledge base')}</h2>
        <p className="mt-2 max-w-[460px] text-xs leading-relaxed text-text-muted">
          {t('knowledge.firstRun.body', 'Spaces hold pages your team can trust. Here is how knowledge gets in and stays current:')}
        </p>
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        {steps.map((step, index) => (
          <div key={step.title} className="rounded-xl border border-border-subtle bg-elevated p-3">
            <div className="flex items-center gap-2">
              <span className="grid h-7 w-7 place-items-center rounded-lg border border-border-subtle bg-surface text-text-secondary">
                <Icon name={step.icon} size={16} aria-hidden />
              </span>
              <span className="text-2xs uppercase tracking-[0.08em] text-text-muted">{t('knowledge.firstRun.step', 'Step')} {index + 1}</span>
            </div>
            <h3 className="mt-2 text-sm font-semibold text-text">{step.title}</h3>
            <p className="mt-1 text-2xs leading-relaxed text-text-muted">{step.body}</p>
          </div>
        ))}
      </div>
      <div className="mt-5 flex justify-center">
        <Button variant="primary" leftIcon="plus" onClick={onNewSpace}>
          {t('knowledge.firstRun.action', 'Create your first Space')}
        </Button>
      </div>
    </Card>
  )
}

function KnowledgeGraphPanel({
  snapshot,
  selectedPageId,
  onSelectPage,
}: {
  snapshot: KnowledgeSnapshotPayload
  selectedPageId: string | null
  onSelectPage: (pageId: string) => void
}) {
  return (
    <Card padding="md" className="flex h-full min-h-[520px] flex-col">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-role-card-title font-bold text-text">{t('knowledge.graph.title', 'Knowledge graph')}</h2>
          <p className="mt-1 text-xs text-text-muted">
            {t('knowledge.graph.subtitle', 'Every page, clustered by Space. Hover to trace links; click a page to open it.')}
          </p>
        </div>
        <Badge tone="accent">{snapshot.graph.nodes.length} {t('knowledge.graph.nodes', 'nodes')}</Badge>
      </div>
      <KnowledgeGraph graph={snapshot.graph} selectedPageId={selectedPageId} onSelectPage={onSelectPage} />
    </Card>
  )
}

function ReviewQueue({
  snapshot,
  busyProposalId,
  onAccept,
  onDecline,
}: {
  snapshot: KnowledgeSnapshotPayload
  busyProposalId: string | null
  onAccept: (proposal: KnowledgeProposal) => void
  onDecline: (proposal: KnowledgeProposal) => void
}) {
  if (!snapshot.proposals.length) {
    return (
      <Card padding="md">
        <EmptyState
          icon="check"
          title={t('knowledge.review.emptyTitle', 'Nothing to review')}
          body={t('knowledge.review.emptyBody', 'Captured conversation notes and coworker proposals appear here before they become published knowledge.')}
        />
      </Card>
    )
  }

  return (
    <Card padding="md">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-display text-role-card-title font-bold text-text">{t('knowledge.review.title', 'Review queue')}</h2>
        <Badge tone="warning">{snapshot.proposals.length}</Badge>
      </div>
      <div className="space-y-3">
        {snapshot.proposals.map((proposal) => {
          const space = proposalSpace(snapshot, proposal)
          const canReview = Boolean(space && knowledgeRoleCanReview(space.role))
          const busy = busyProposalId === proposal.id
          return (
            <Card key={proposal.id} variant="flat" padding="sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold text-text">{proposal.pageTitle}</h3>
                  <p className="mt-1 text-xs text-text-muted">{proposal.summary}</p>
                </div>
                <span className="font-mono text-xs font-semibold whitespace-nowrap">
                  <span className="text-green">+{proposal.add}</span>
                  <span className="text-text-muted"> / </span>
                  <span className="text-red">-{proposal.del}</span>
                </span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-2xs text-text-muted">
                <span>{space?.name || t('knowledge.review.unknownSpace', 'Unknown space')}</span>
                <span>{t('knowledge.review.byAuthor', 'by')} {proposal.by}</span>
                <span>{formatDate(proposal.when)}</span>
              </div>
              <div className="mt-3 flex justify-end gap-2">
                <Button size="sm" variant="ghost" disabled={busy || !canReview} onClick={() => onDecline(proposal)}>
                  {t('knowledge.review.decline', 'Decline')}
                </Button>
                <Button size="sm" variant="primary" disabled={busy || !canReview} onClick={() => onAccept(proposal)}>
                  {t('knowledge.review.accept', 'Accept')}
                </Button>
              </div>
            </Card>
          )
        })}
      </div>
    </Card>
  )
}

function VersionHistory({ versions, currentVersion, canRestore, busyVersionId, onRestore }: {
  versions: KnowledgePageVersion[]
  currentVersion: number
  canRestore: boolean
  busyVersionId: string | null
  onRestore: (version: KnowledgePageVersion) => void
}) {
  return (
    <Card padding="md">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-display text-role-card-title font-bold text-text">{t('knowledge.history.title', 'Page history')}</h2>
        <Badge tone="neutral">{versions.length}</Badge>
      </div>
      <div className="studio-version-timeline">
        {versions.map((version, index) => {
          const isCurrent = version.version === currentVersion
          return (
            <div key={`${version.id}:${version.version}`} className="studio-version-row">
              <div className="studio-version-rail" aria-hidden="true">
                <span className={`studio-version-dot${isCurrent ? ' is-current' : ''}`} />
                {index < versions.length - 1 ? <span className="studio-version-connector" /> : null}
              </div>
              <div className="studio-version-body text-xs">
                <div className="flex items-center justify-between gap-2">
                  <strong className="text-text">v{version.version}</strong>
                  <span className="text-text-muted">{formatDate(version.updatedAt)}</span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-2 text-text-muted">
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <span className="truncate">{version.updatedBy}</span>
                    {version.proposalId ? <Badge tone="muted">{t('knowledge.history.fromProposal', 'from proposal')}</Badge> : null}
                  </span>
                  {isCurrent ? (
                    <Badge tone="accent">{t('knowledge.history.current', 'Current')}</Badge>
                  ) : canRestore ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      leftIcon="rotate-ccw"
                      disabled={Boolean(busyVersionId)}
                      onClick={() => onRestore(version)}
                    >
                      {busyVersionId === version.versionId ? t('knowledge.history.restoring', 'Restoring') : t('knowledge.history.restore', 'Restore')}
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          )
        })}
        {!versions.length && <p className="text-xs text-text-muted">{t('knowledge.history.empty', 'No versions found for this page.')}</p>}
      </div>
    </Card>
  )
}

function NewSpaceDialog({ busy, error, onSubmit, onClose }: {
  busy: boolean
  error: string | null
  onSubmit: (input: { name: string; visibility: KnowledgeSpaceVisibility }) => void
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [visibility, setVisibility] = useState<KnowledgeSpaceVisibility>('company')
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
            {busy ? t('knowledge.newSpace.creating', 'Creating') : t('knowledge.newSpace.create', 'Create')}
          </Button>
        </>
      )}
    >
      <div className="studio-wiki-propose">
        <p className="studio-wiki-propose__hint">
          {t('knowledge.newSpace.hint', 'Spaces group related pages and set who can read, propose, and review them.')}
        </p>
        <label className="studio-wiki-propose__field">
          <span>{t('knowledge.newSpace.nameLabel', 'Name')}</span>
          <Input
            value={name}
            placeholder={t('knowledge.newSpace.namePlaceholder', 'e.g. Onboarding')}
            disabled={busy}
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
            disabled={busy}
            onChange={(value) => setVisibility(value as KnowledgeSpaceVisibility)}
          />
        </label>
        {error ? <p role="alert" className="studio-wiki-propose__error">{error}</p> : null}
      </div>
    </Dialog>
  )
}

export function KnowledgePage() {
  const activeWorkspaceId = useSessionStore((state) => state.activeWorkspaceId)
  const activeWorkspaceIsLocal = activeWorkspaceId === LOCAL_WORKSPACE_ID
  const [snapshot, setSnapshot] = useState<KnowledgeSnapshotPayload>(EMPTY_SNAPSHOT)
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null)
  const [versions, setVersions] = useState<KnowledgePageVersion[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyProposalId, setBusyProposalId] = useState<string | null>(null)
  const [busyVersionId, setBusyVersionId] = useState<string | null>(null)
  const [proposeOpen, setProposeOpen] = useState(false)
  const [proposeBusy, setProposeBusy] = useState(false)
  const [proposeError, setProposeError] = useState<string | null>(null)
  const [newSpaceOpen, setNewSpaceOpen] = useState(false)
  const [newSpaceBusy, setNewSpaceBusy] = useState(false)
  const [newSpaceError, setNewSpaceError] = useState<string | null>(null)
  const [view, setView] = useState<'pages' | 'graph'>('pages')
  const [pageQuery, setPageQuery] = useState('')
  const reviewQueueRef = useRef<HTMLDivElement | null>(null)
  const [pendingReviewReveal, setPendingReviewReveal] = useState(false)

  // The review-queue panel only renders in the pages view, so the rail shortcut
  // switches back to pages (if needed) and arms a reveal. Coming from graph view
  // the panel is unmounted, so scrolling from within the click handler would race
  // the commit; instead we flag the reveal and let the effect below scroll once
  // the pages view (and the ref) is mounted.
  const revealReviewQueue = useCallback(() => {
    setView('pages')
    setPendingReviewReveal(true)
  }, [])

  // Scroll to the review queue only after the pages view has committed and the
  // ref is attached. Keying on `view` re-runs this when switching back from graph
  // so the first click reliably lands on the queue.
  useEffect(() => {
    if (!pendingReviewReveal) return
    if (view !== 'pages') return
    const node = reviewQueueRef.current
    if (!node) return
    node.scrollIntoView({ block: 'start', behavior: 'smooth' })
    setPendingReviewReveal(false)
  }, [pendingReviewReveal, view])

  const loadSnapshot = useCallback(async () => {
    setLoading(true)
    setError(null)
    if (!activeWorkspaceIsLocal) {
      setSnapshot(EMPTY_SNAPSHOT)
      setSelectedPageId(null)
      setLoading(false)
      return
    }
    try {
      const next = await window.coworkApi.knowledge.snapshot({ workspaceId: activeWorkspaceId })
      setSnapshot(next)
      setSelectedPageId((current) => current && next.pages.some((page) => page.id === current)
        ? current
        : firstReadablePage(next)?.id || null)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
      setSnapshot(EMPTY_SNAPSHOT)
      setSelectedPageId(null)
    } finally {
      setLoading(false)
    }
  }, [activeWorkspaceId, activeWorkspaceIsLocal])

  useEffect(() => {
    void loadSnapshot()
    const unsubscribe = window.coworkApi.on.knowledgeUpdated(() => {
      void loadSnapshot()
    })
    return unsubscribe
  }, [loadSnapshot])

  const selectedPage = useMemo(
    () => snapshot.pages.find((page) => page.id === selectedPageId) || firstReadablePage(snapshot),
    [snapshot, selectedPageId],
  )
  const selectedSpace = pageSpace(snapshot, selectedPage)
  const spacesForRail = useMemo(() => wikiSpaces(snapshot.spaces, snapshot.pages), [snapshot])
  const totalPages = snapshot.pages.length
  const filteredSpacesForRail = useMemo(() => {
    const query = pageQuery.trim().toLowerCase()
    if (!query) return spacesForRail
    return spacesForRail
      .map((space) => ({ ...space, pages: space.pages.filter((page) => page.title.toLowerCase().includes(query)) }))
      .filter((space) => space.pages.length > 0)
  }, [spacesForRail, pageQuery])
  const selectedPageId2 = selectedPage?.id

  const loadHistory = useCallback(async () => {
    if (!selectedPageId2) {
      setVersions([])
      return
    }
    try {
      const history = await window.coworkApi.knowledge.history(selectedPageId2, { workspaceId: activeWorkspaceId })
      setVersions(history)
    } catch {
      setVersions([])
    }
  }, [activeWorkspaceId, selectedPageId2])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  const acceptProposal = useCallback(async (proposal: KnowledgeProposal) => {
    setBusyProposalId(proposal.id)
    setError(null)
    try {
      const result = await window.coworkApi.knowledge.acceptProposal(proposal.id, {
        workspaceId: activeWorkspaceId,
      })
      setSelectedPageId(result.page.id)
      await loadSnapshot()
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError))
    } finally {
      setBusyProposalId(null)
    }
  }, [activeWorkspaceId, loadSnapshot])

  const declineProposal = useCallback(async (proposal: KnowledgeProposal) => {
    setBusyProposalId(proposal.id)
    setError(null)
    try {
      await window.coworkApi.knowledge.declineProposal(proposal.id, {
        workspaceId: activeWorkspaceId,
      })
      await loadSnapshot()
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError))
    } finally {
      setBusyProposalId(null)
    }
  }, [activeWorkspaceId, loadSnapshot])

  const restoreVersion = useCallback(async (version: KnowledgePageVersion) => {
    setBusyVersionId(version.versionId)
    setError(null)
    try {
      await window.coworkApi.knowledge.restoreVersion(version.pageId, version.versionId, {
        workspaceId: activeWorkspaceId,
      })
      await Promise.all([loadSnapshot(), loadHistory()])
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError))
    } finally {
      setBusyVersionId(null)
    }
  }, [activeWorkspaceId, loadSnapshot, loadHistory])

  const submitProposal = useCallback(async ({ summary, body }: WikiProposeEditSubmit) => {
    if (!selectedPage || !selectedSpace) return
    setProposeBusy(true)
    setProposeError(null)
    try {
      await window.coworkApi.knowledge.propose({
        workspaceId: activeWorkspaceId,
        spaceId: selectedSpace.id,
        pageId: selectedPage.id,
        pageTitle: selectedPage.title,
        summary,
        links: selectedPage.links,
        body,
      })
      setProposeOpen(false)
      await loadSnapshot()
    } catch (proposeException) {
      setProposeError(proposeException instanceof Error ? proposeException.message : String(proposeException))
    } finally {
      setProposeBusy(false)
    }
  }, [activeWorkspaceId, loadSnapshot, selectedPage, selectedSpace])

  const createSpace = useCallback(async ({ name, visibility }: { name: string; visibility: KnowledgeSpaceVisibility }) => {
    setNewSpaceBusy(true)
    setNewSpaceError(null)
    try {
      const space = await window.coworkApi.knowledge.createSpace({
        workspaceId: activeWorkspaceId,
        name,
        visibility,
      })
      const next = await window.coworkApi.knowledge.snapshot({ workspaceId: activeWorkspaceId })
      setSnapshot(next)
      // Select the new Space by opening its first page when it has one. A brand-new
      // Space starts empty, so selection falls back to the current readable page.
      const firstPageOfSpace = next.pages.find((page) => page.spaceId === space.id)
      if (firstPageOfSpace) setSelectedPageId(firstPageOfSpace.id)
      setNewSpaceOpen(false)
    } catch (createError) {
      setNewSpaceError(createError instanceof Error ? createError.message : String(createError))
    } finally {
      setNewSpaceBusy(false)
    }
  }, [activeWorkspaceId])

  const canPropose = selectedSpace ? knowledgeRoleCanPropose(selectedSpace.role) : false
  const canReview = selectedSpace ? knowledgeRoleCanReview(selectedSpace.role) : false

  if (!activeWorkspaceIsLocal) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto bg-base text-text">
        <div className="mx-auto flex w-full max-w-[960px] flex-col gap-5 px-6 py-6">
          <StudioPageHeader
            eyebrow={t('knowledge.eyebrow', 'Company OS')}
            title={t('knowledge.title', 'Knowledge')}
            description={t('knowledge.localOnlyDescription', 'Desktop Knowledge is stored in the Local workspace. Cloud workspaces expose Knowledge through Cloud Web.')}
          />
          <RestrictedState
            title={t('knowledge.localOnlyTitle', 'Switch to Local for desktop Knowledge')}
            body={t('knowledge.localOnlyBody', 'This desktop Knowledge surface writes to the local versioned Knowledge store. Open Cloud Web to review or capture Knowledge for a Cloud workspace.')}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-base text-text">
      <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-5 px-6 py-6">
        <StudioPageHeader
          eyebrow={t('knowledge.eyebrow', 'Shared wiki')}
          title={t('knowledge.title', 'Knowledge')}
          description={t('knowledge.description', 'A shared wiki your coworkers help keep current. Pages live in Spaces; edits are proposed, reviewed, then published — and every version is saved.')}
          actions={[{
            id: 'reload',
            children: loading ? t('knowledge.loading', 'Loading') : t('knowledge.reload', 'Reload'),
            onClick: () => void loadSnapshot(),
            disabled: loading,
            leftIcon: 'rotate-ccw',
            variant: 'ghost',
          }]}
        />

        {error ? (
          <div role="alert" className="rounded-lg border border-red/30 bg-red/10 px-3 py-2 text-xs text-red">
            {error}
          </div>
        ) : null}

        {loading && snapshot.spaces.length === 0 ? (
          <div className="grid min-h-[480px] grid-cols-[260px_minmax(0,1fr)] gap-4">
            <div className="flex flex-col gap-2">
              <Skeleton className="h-9 w-full rounded-lg" />
              <Skeleton className="h-44 w-full rounded-lg" />
            </div>
            <Skeleton className="h-[480px] w-full rounded-lg" />
          </div>
        ) : !error && snapshot.spaces.length === 0 ? (
          <KnowledgeFirstRun onNewSpace={() => { setNewSpaceError(null); setNewSpaceOpen(true) }} />
        ) : (
        <div className={`grid min-h-[720px] gap-4 ${view === 'graph' ? 'grid-cols-[260px_minmax(0,1fr)]' : 'grid-cols-[260px_minmax(0,1fr)_330px]'}`}>
          <div className="flex min-h-0 flex-col gap-3">
            <Button
              variant="secondary"
              size="sm"
              leftIcon="plus"
              fullWidth
              onClick={() => { setNewSpaceError(null); setNewSpaceOpen(true) }}
            >
              {t('knowledge.newSpace.action', 'New Space')}
            </Button>
            {totalPages > 6 ? (
              <Input
                leftIcon="search"
                value={pageQuery}
                placeholder={t('knowledge.search.placeholder', 'Find a page')}
                aria-label={t('knowledge.search.label', 'Find a page')}
                onChange={(event) => setPageQuery(event.target.value)}
              />
            ) : null}
            <WikiSpaceRail
            spaces={filteredSpacesForRail}
            activePageId={selectedPage?.id}
            viewToggle={(
              <SegmentedControl
                label={t('knowledge.view.label', 'Knowledge view')}
                value={view}
                onChange={(next) => setView(next === 'graph' ? 'graph' : 'pages')}
                options={[
                  { value: 'pages', label: t('knowledge.view.pages', 'Pages') },
                  { value: 'graph', label: t('knowledge.view.graph', 'Graph') },
                ]}
              />
            )}
            reviewAction={(
              <button
                type="button"
                onClick={revealReviewQueue}
                aria-label={t('knowledge.review.railLabel', 'Review queue')}
                className="flex w-full items-center justify-between rounded-lg border border-border-subtle bg-elevated px-3 py-2 text-xs text-text-secondary hover:bg-surface-hover hover:text-text"
              >
                <span className="inline-flex items-center gap-2"><Icon name="circle-help" size={16} /> {t('knowledge.review.railLabel', 'Review queue')}</span>
                <Badge tone={snapshot.proposals.length ? 'warning' : 'neutral'}>{snapshot.proposals.length}</Badge>
              </button>
            )}
            onSelectPage={(_, page) => setSelectedPageId(page.id)}
            />
            {pageQuery.trim() && filteredSpacesForRail.length === 0 ? (
              <p className="px-1 text-2xs text-text-muted">{t('knowledge.search.noMatch', 'No pages match your search.')}</p>
            ) : null}
          </div>

          <div className="min-w-0 space-y-4">
            {view === 'graph' ? (
              <KnowledgeGraphPanel
                snapshot={snapshot}
                selectedPageId={selectedPage?.id || null}
                onSelectPage={(id) => { setSelectedPageId(id); setView('pages') }}
              />
            ) : selectedPage ? (
              <WikiPage
                breadcrumbs={[selectedSpace?.name || t('knowledge.breadcrumbRoot', 'Knowledge'), visibilityLabel(selectedSpace || snapshot.spaces[0] || {
                  id: '',
                  name: '',
                  visibility: 'company',
                  role: 'Reader',
                })]}
                title={selectedPage.title}
                actions={canPropose ? (
                  <Button size="sm" variant="secondary" leftIcon="file-diff" onClick={() => { setProposeError(null); setProposeOpen(true) }}>
                    {t('knowledge.propose.action', 'Propose edit')}
                  </Button>
                ) : undefined}
                meta={(
                  <div className="flex flex-wrap gap-2 text-xs text-text-muted">
                    <Badge tone="neutral">v{selectedPage.version}</Badge>
                    <span>{t('knowledge.page.updatedBy', 'Updated by')} {selectedPage.updatedBy}</span>
                    <span>{formatDate(selectedPage.updatedAt)}</span>
                    {selectedSpace ? <span>{selectedSpace.role}</span> : null}
                  </div>
                )}
                blocks={selectedPage.body.map(blockToWiki)}
                links={selectedPage.links.map((link, index) => ({
                  id: `${link.kind}:${link.targetId || link.label}:${index}`,
                  label: link.label,
                  icon: linkIcon(link.kind),
                }))}
              />
            ) : (
              <Card padding="lg">
                <EmptyState
                  icon="book-open"
                  title={t('knowledge.emptyTitle', 'No readable pages')}
                  body={t('knowledge.emptyBody', 'Create or accept a proposal in a Space you can read to publish the first page.')}
                />
              </Card>
            )}
          </div>

          {view !== 'graph' && (
          <div className="space-y-4">
            <div ref={reviewQueueRef}>
              <ReviewQueue
                snapshot={snapshot}
                busyProposalId={busyProposalId}
                onAccept={(proposal) => void acceptProposal(proposal)}
                onDecline={(proposal) => void declineProposal(proposal)}
              />
            </div>
            <VersionHistory
              versions={versions}
              currentVersion={selectedPage?.version || 0}
              canRestore={canReview}
              busyVersionId={busyVersionId}
              onRestore={(version) => void restoreVersion(version)}
            />
            <AccessPanel space={selectedSpace} canPropose={canPropose} canReview={canReview} />
          </div>
          )}
        </div>
        )}
      </div>
      {proposeOpen && selectedPage && selectedSpace ? (
        <WikiProposeEditDialog
          pageTitle={selectedPage.title}
          spaceName={selectedSpace.name}
          blocks={selectedPage.body}
          busy={proposeBusy}
          error={proposeError}
          onSubmit={(input) => void submitProposal(input)}
          onClose={() => setProposeOpen(false)}
        />
      ) : null}
      {newSpaceOpen ? (
        <NewSpaceDialog
          busy={newSpaceBusy}
          error={newSpaceError}
          onSubmit={(input) => void createSpace(input)}
          onClose={() => setNewSpaceOpen(false)}
        />
      ) : null}
    </div>
  )
}
