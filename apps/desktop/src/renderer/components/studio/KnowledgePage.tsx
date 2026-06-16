import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  KnowledgePage as KnowledgePageRecord,
  KnowledgePageBlock as KnowledgePageBlockRecord,
  KnowledgePageLink,
  KnowledgePageVersion,
  KnowledgeProposal,
  KnowledgeSnapshotPayload,
  KnowledgeSpace,
} from '@open-cowork/shared'
import { knowledgeRoleCanPropose, knowledgeRoleCanReview, knowledgeVisibilityLabel } from '@open-cowork/shared'
import { useSessionStore } from '../../stores/session'
import { LOCAL_WORKSPACE_ID } from '../../stores/session-workspace-keys'
import { t } from '../../helpers/i18n'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Icon,
  type IconName,
  KnowledgeGraph,
  SegmentedControl,
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

function canReviewAny(snapshot: KnowledgeSnapshotPayload) {
  return snapshot.spaces.some((space) => knowledgeRoleCanReview(space.role))
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
    <Card padding="md" className="flex min-h-[520px] flex-col">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-text">{t('knowledge.graph.title', 'Knowledge graph')}</h2>
          <p className="mt-1 text-[12px] text-text-muted">
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
        <h2 className="text-sm font-semibold text-text">{t('knowledge.review.title', 'Review queue')}</h2>
        <Badge tone="warning">{snapshot.proposals.length}</Badge>
      </div>
      <div className="space-y-3">
        {snapshot.proposals.map((proposal) => {
          const space = proposalSpace(snapshot, proposal)
          const canReview = Boolean(space && knowledgeRoleCanReview(space.role))
          const busy = busyProposalId === proposal.id
          return (
            <article key={proposal.id} className="rounded-lg border border-border-subtle bg-surface px-3 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-[13px] font-semibold text-text">{proposal.pageTitle}</h3>
                  <p className="mt-1 text-[12px] text-text-muted">{proposal.summary}</p>
                </div>
                <Badge tone="neutral">+{proposal.add} / -{proposal.del}</Badge>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
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
            </article>
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
        <h2 className="text-sm font-semibold text-text">{t('knowledge.history.title', 'Version history')}</h2>
        <Badge tone="neutral">{versions.length}</Badge>
      </div>
      <div className="space-y-2">
        {versions.map((version) => {
          const isCurrent = version.version === currentVersion
          return (
            <div key={`${version.id}:${version.version}`} className="rounded-md border border-border-subtle bg-surface px-3 py-2 text-[12px]">
              <div className="flex items-center justify-between gap-2">
                <strong className="text-text">v{version.version}</strong>
                <span className="text-text-muted">{formatDate(version.updatedAt)}</span>
              </div>
              <div className="mt-1 flex items-center justify-between gap-2 text-text-muted">
                <span className="truncate">{version.updatedBy}{version.proposalId ? ` - ${version.proposalId}` : ''}</span>
                {isCurrent ? (
                  <Badge tone="neutral">{t('knowledge.history.current', 'Current')}</Badge>
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
          )
        })}
        {!versions.length && <p className="text-[12px] text-text-muted">{t('knowledge.history.empty', 'No versions found for this page.')}</p>}
      </div>
    </Card>
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
  const [view, setView] = useState<'pages' | 'graph'>('pages')

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
        reviewedBy: 'you',
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
        reviewedBy: 'you',
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
        reviewedBy: 'you',
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
          <Card padding="lg">
            <EmptyState
              icon="book-open"
              title={t('knowledge.localOnlyTitle', 'Switch to Local for desktop Knowledge')}
              body={t('knowledge.localOnlyBody', 'This desktop Knowledge surface writes to the local versioned Knowledge store. Open Cloud Web to review or capture Knowledge for a Cloud workspace.')}
            />
          </Card>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-base text-text">
      <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-5 px-6 py-6">
        <StudioPageHeader
          eyebrow={t('knowledge.eyebrow', 'Company OS')}
          title={t('knowledge.title', 'Knowledge')}
          description={t('knowledge.description', 'Versioned Spaces, reviewable proposals, backlinks, and graph context for accepted work.')}
          actions={[{
            id: 'reload',
            children: loading ? t('knowledge.loading', 'Loading') : t('knowledge.reload', 'Reload'),
            onClick: () => void loadSnapshot(),
            disabled: loading,
            leftIcon: 'rotate-ccw',
          }]}
        />

        {error ? (
          <div role="alert" className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-100">
            {error}
          </div>
        ) : null}

        <div className="grid min-h-[720px] grid-cols-[260px_minmax(0,1fr)_330px] gap-4">
          <WikiSpaceRail
            spaces={spacesForRail}
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
                className="flex w-full items-center justify-between rounded-lg border border-border-subtle bg-elevated px-3 py-2 text-[12px] text-text-secondary hover:bg-surface-hover hover:text-text"
              >
                <span className="inline-flex items-center gap-2"><Icon name="circle-help" size={16} /> {t('knowledge.review.railLabel', 'Review queue')}</span>
                <Badge tone={snapshot.proposals.length ? 'warning' : 'neutral'}>{snapshot.proposals.length}</Badge>
              </button>
            )}
            onSelectPage={(_, page) => setSelectedPageId(page.id)}
          />

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
                  <div className="flex flex-wrap gap-2 text-[12px] text-text-muted">
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

          <div className="space-y-4">
            <ReviewQueue
              snapshot={snapshot}
              busyProposalId={busyProposalId}
              onAccept={(proposal) => void acceptProposal(proposal)}
              onDecline={(proposal) => void declineProposal(proposal)}
            />
            <VersionHistory
              versions={versions}
              currentVersion={selectedPage?.version || 0}
              canRestore={canReview}
              busyVersionId={busyVersionId}
              onRestore={(version) => void restoreVersion(version)}
            />
            <Card padding="md">
              <div className="flex items-start gap-3">
                <span className="grid h-9 w-9 place-items-center rounded-lg border border-border-subtle bg-surface text-text-secondary">
                  <Icon name="shield-check" size={16} />
                </span>
                <div>
                  <h2 className="text-sm font-semibold text-text">{t('knowledge.permissions.title', 'Space permissions')}</h2>
                  <p className="mt-1 text-[12px] text-text-muted">
                    {selectedSpace
                      ? `${selectedSpace.role}: read ${knowledgeRoleCanPropose(selectedSpace.role) ? '+ propose' : ''} ${knowledgeRoleCanReview(selectedSpace.role) ? '+ review' : ''}`
                      : t('knowledge.permissions.noSelection', 'Select a page to inspect Space role gates.')}
                  </p>
                  <p className="mt-2 text-[11px] text-text-muted">
                    {canReviewAny(snapshot)
                      ? t('knowledge.permissions.canReview', 'Maintainers can accept or decline pending proposals.')
                      : t('knowledge.permissions.noMaintainer', 'This workspace has no visible Maintainer Space.')}
                    {canPropose ? t('knowledge.permissions.canPropose', ' You can capture conversation context into this Space.') : ''}
                  </p>
                </div>
              </div>
            </Card>
          </div>
        </div>
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
    </div>
  )
}
