import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppApi } from '@open-cowork/ui/app-api'
import {
  Badge,
  Button,
  EmptyState,
  KnowledgeGraph,
  SegmentedControl,
  WikiPage,
  WikiProposeEditDialog,
  type WikiProposeEditSubmit,
  WikiSpaceRail,
  type IconName,
  type WikiPageBlock,
  type WikiSpace,
} from '@open-cowork/ui'
import type {
  KnowledgePage,
  KnowledgePageBlock,
  KnowledgePageLink,
  KnowledgePageVersion,
  KnowledgeProposal,
  KnowledgeSnapshotPayload,
  KnowledgeSpace,
} from '@open-cowork/shared'
import { knowledgeRoleCanPropose, knowledgeRoleCanReview, knowledgeVisibilityLabel } from '@open-cowork/shared'
import type { CloudWebClientBootstrap } from './client-contract.ts'
import { canManageCloudKnowledge, knowledgeCaptureSpace } from './react-workbench-knowledge-state.ts'
import type { CloudWebThreadView } from './thread-workbench.ts'

const EMPTY_SNAPSHOT: KnowledgeSnapshotPayload = {
  spaces: [],
  pages: [],
  proposals: [],
  graph: { nodes: [], edges: [] },
  limit: 100,
  truncated: false,
}

function usePortalTarget(id: string) {
  const [target, setTarget] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const element = document.getElementById(id)
    if (element) element.replaceChildren()
    setTarget(element)
  }, [id])
  return target
}

function formatDate(value: string | null | undefined) {
  if (!value) return 'Unknown'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function linkIcon(kind: KnowledgePageLink['kind']): IconName {
  if (kind === 'artifact') return 'file'
  if (kind === 'task') return 'list-checks'
  return 'message-square'
}

function toWikiBlock(block: KnowledgePageBlock, index: number): WikiPageBlock {
  const id = block.id || `block-${index + 1}`
  if (block.type === 'h') return { id, type: 'heading', text: block.text }
  if (block.type === 'p') return { id, type: 'paragraph', text: block.text }
  if (block.type === 'callout') return { id, type: 'callout', text: block.text, icon: 'info' }
  return { id, type: 'list', items: block.items }
}

function toWikiSpaces(spaces: KnowledgeSpace[], pages: KnowledgePage[]): WikiSpace[] {
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

function firstPage(snapshot: KnowledgeSnapshotPayload) {
  return snapshot.pages[0] || null
}

function pageSpace(snapshot: KnowledgeSnapshotPayload, page: KnowledgePage | null) {
  return page ? snapshot.spaces.find((space) => space.id === page.spaceId) || null : null
}

function currentThreadTitle(selectedView: CloudWebThreadView | null) {
  return selectedView?.session?.title || selectedView?.session?.sessionId || 'Current Cloud chat'
}

function currentThreadId(selectedView: CloudWebThreadView | null) {
  return selectedView?.session?.sessionId || null
}

function KnowledgeReviewQueue({
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
      <EmptyState
        icon="check"
        title="Nothing to review"
        body="Captured Cloud chat context and coworker proposals appear here before they become published knowledge."
      />
    )
  }

  return (
    <div className="knowledge-review-list">
      <div className="knowledge-panel-heading"><strong>Review queue</strong><Badge tone="warning">{snapshot.proposals.length}</Badge></div>
      {snapshot.proposals.map((proposal) => {
        const space = snapshot.spaces.find((candidate) => candidate.id === proposal.spaceId)
        const canReview = canReviewKnowledge && Boolean(space && knowledgeRoleCanReview(space.role))
        const busy = busyProposalId === proposal.id
        return (
          <article key={proposal.id} className="knowledge-proposal-card">
            <div className="knowledge-proposal-card__head">
              <strong>{proposal.pageTitle}</strong>
              <Badge tone="neutral">+{proposal.add} / -{proposal.del}</Badge>
            </div>
            <p>{proposal.summary}</p>
            <small>{space?.name || 'Unknown space'} - {proposal.by} - {formatDate(proposal.when)}</small>
            <div className="knowledge-proposal-card__actions">
              <Button size="sm" variant="ghost" disabled={busy || !canReview} onClick={() => onDecline(proposal)}>Decline</Button>
              <Button size="sm" variant="primary" disabled={busy || !canReview} onClick={() => onAccept(proposal)}>Accept</Button>
            </div>
          </article>
        )
      })}
      {!canReviewKnowledge ? <p className="empty">Knowledge review requires an owner/admin Cloud role.</p> : null}
    </div>
  )
}

export function CloudKnowledgeSurfacePortals({
  selectedView,
  bootstrap,
  workspace,
}: {
  selectedView: CloudWebThreadView | null
  bootstrap: CloudWebClientBootstrap
  workspace: unknown
}) {
  const api = useAppApi()
  const [snapshot, setSnapshot] = useState<KnowledgeSnapshotPayload>(EMPTY_SNAPSHOT)
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null)
  const [history, setHistory] = useState<KnowledgePageVersion[]>([])
  const [busyProposalId, setBusyProposalId] = useState<string | null>(null)
  const [busyVersionId, setBusyVersionId] = useState<string | null>(null)
  const [proposeOpen, setProposeOpen] = useState(false)
  const [proposeBusy, setProposeBusy] = useState(false)
  const [proposeError, setProposeError] = useState<string | null>(null)
  const [view, setView] = useState<'pages' | 'graph'>('pages')
  const [error, setError] = useState<string | null>(null)
  const targets = {
    rail: usePortalTarget('knowledge-space-rail'),
    reader: usePortalTarget('knowledge-reader'),
    review: usePortalTarget('knowledge-review-queue'),
    history: usePortalTarget('knowledge-version-history'),
    graph: usePortalTarget('knowledge-graph'),
  }

  const loadSnapshot = useCallback(async () => {
    setError(null)
    try {
      const next = await api.knowledge.snapshot() as KnowledgeSnapshotPayload
      setSnapshot(next)
      setSelectedPageId((current) => current && next.pages.some((page) => page.id === current)
        ? current
        : firstPage(next)?.id || null)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
      setSnapshot(EMPTY_SNAPSHOT)
      setSelectedPageId(null)
    }
  }, [api])

  useEffect(() => {
    void loadSnapshot()
  }, [loadSnapshot])

  const selectedPage = useMemo(
    () => snapshot.pages.find((page) => page.id === selectedPageId) || firstPage(snapshot),
    [snapshot, selectedPageId],
  )
  const selectedSpace = pageSpace(snapshot, selectedPage)
  const railSpaces = useMemo(() => toWikiSpaces(snapshot.spaces, snapshot.pages), [snapshot])
  const canReviewKnowledge = useMemo(() => canManageCloudKnowledge(bootstrap.role, workspace), [bootstrap.role, workspace])

  const selectedHistoryPageId = selectedPage?.id

  const loadHistory = useCallback(async () => {
    if (!selectedHistoryPageId) {
      setHistory([])
      return
    }
    try {
      const payload = await api.knowledge.history(selectedHistoryPageId)
      setHistory(Array.isArray(payload) ? payload as KnowledgePageVersion[] : [])
    } catch {
      setHistory([])
    }
  }, [api, selectedHistoryPageId])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  const acceptProposal = useCallback(async (proposal: KnowledgeProposal) => {
    setBusyProposalId(proposal.id)
    setError(null)
    try {
      const result = await api.knowledge.acceptProposal(proposal.id, { reviewedBy: 'you' }) as { page?: KnowledgePageVersion }
      if (result.page?.id) setSelectedPageId(result.page.id)
      await loadSnapshot()
    } catch (reviewError) {
      const message = errorMessage(reviewError)
      await loadSnapshot()
      setError(message)
    } finally {
      setBusyProposalId(null)
    }
  }, [api, loadSnapshot])

  const declineProposal = useCallback(async (proposal: KnowledgeProposal) => {
    setBusyProposalId(proposal.id)
    setError(null)
    try {
      await api.knowledge.declineProposal(proposal.id, { reviewedBy: 'you' })
      await loadSnapshot()
    } catch (reviewError) {
      const message = errorMessage(reviewError)
      await loadSnapshot()
      setError(message)
    } finally {
      setBusyProposalId(null)
    }
  }, [api, loadSnapshot])

  const restoreVersion = useCallback(async (version: KnowledgePageVersion) => {
    setBusyVersionId(version.versionId)
    setError(null)
    try {
      await api.knowledge.restoreVersion(version.pageId, version.versionId, { reviewedBy: 'you' })
      await Promise.all([loadSnapshot(), loadHistory()])
    } catch (restoreError) {
      const message = errorMessage(restoreError)
      await Promise.all([loadSnapshot(), loadHistory()])
      setError(message)
    } finally {
      setBusyVersionId(null)
    }
  }, [api, loadSnapshot, loadHistory])

  const canProposeEdit = canReviewKnowledge && Boolean(selectedSpace && knowledgeRoleCanPropose(selectedSpace.role))

  const submitProposal = useCallback(async ({ summary, body }: WikiProposeEditSubmit) => {
    if (!selectedPage || !selectedSpace) return
    setProposeBusy(true)
    setProposeError(null)
    try {
      await api.knowledge.propose({
        spaceId: selectedSpace.id,
        pageId: selectedPage.id,
        pageTitle: selectedPage.title,
        by: 'you',
        summary,
        links: selectedPage.links,
        body,
      })
      setProposeOpen(false)
      await loadSnapshot()
    } catch (proposeException) {
      setProposeError(errorMessage(proposeException))
    } finally {
      setProposeBusy(false)
    }
  }, [api, loadSnapshot, selectedPage, selectedSpace])

  const captureCurrentThread = useCallback(async () => {
    if (!canReviewKnowledge) {
      setError('Knowledge capture requires an owner/admin Cloud role.')
      return
    }
    const space = knowledgeCaptureSpace(snapshot.spaces)
    if (!space) {
      setError('No writable Knowledge Space is available for capture.')
      return
    }
    const threadTitle = currentThreadTitle(selectedView)
    const threadId = currentThreadId(selectedView)
    try {
      await api.knowledge.propose({
        spaceId: space.id,
        pageTitle: `Conversation: ${threadTitle}`,
        by: 'you',
        summary: `Capture Cloud chat context from "${threadTitle}" for Knowledge review.`,
        add: 3,
        del: 0,
        links: threadId ? [{ kind: 'thread', label: threadTitle, targetId: threadId }] : [],
        body: [
          { id: 'capture-summary', type: 'callout', text: 'Captured from Cloud Web. Review before publishing this as durable knowledge.' },
          { id: 'capture-context', type: 'h', text: 'Conversation context' },
          { id: 'capture-body', type: 'p', text: `Source chat: ${threadTitle}` },
        ],
      })
      await loadSnapshot()
    } catch (captureError) {
      setError(captureError instanceof Error ? captureError.message : 'Unable to capture this conversation to Knowledge.')
    }
  }, [api, canReviewKnowledge, loadSnapshot, selectedView, snapshot.spaces])

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (!target) return
      if (target.closest('#refresh-knowledge')) {
        event.preventDefault()
        void loadSnapshot()
      }
      if (target.closest('#knowledge-capture-shortcut, #chat-capture-knowledge, [data-action-id="capture-knowledge"]')) {
        event.preventDefault()
        void captureCurrentThread()
      }
    }
    document.addEventListener('click', handler, true)
    return () => document.removeEventListener('click', handler, true)
  }, [captureCurrentThread, loadSnapshot])

  return (
    <>
      {targets.rail ? createPortal((
        <WikiSpaceRail
          spaces={railSpaces}
          activePageId={selectedPage?.id}
          viewToggle={(
            <SegmentedControl
              label="Knowledge view"
              value={view}
              onChange={(next) => setView(next === 'graph' ? 'graph' : 'pages')}
              options={[
                { value: 'pages', label: 'Pages' },
                { value: 'graph', label: 'Graph' },
              ]}
            />
          )}
          reviewAction={<Badge tone={snapshot.proposals.length ? 'warning' : 'neutral'}>{snapshot.proposals.length} pending</Badge>}
          onSelectPage={(_, page) => setSelectedPageId(page.id)}
        />
      ), targets.rail) : null}

      {targets.reader ? createPortal(view === 'graph' ? (
        <KnowledgeGraph
          graph={snapshot.graph}
          selectedPageId={selectedPage?.id || null}
          onSelectPage={(id) => { setSelectedPageId(id); setView('pages') }}
        />
      ) : selectedPage ? (
        <WikiPage
          breadcrumbs={[selectedSpace?.name || 'Knowledge', knowledgeVisibilityLabel(selectedSpace?.visibility)]}
          title={selectedPage.title}
          actions={canProposeEdit ? (
            <Button size="sm" variant="secondary" leftIcon="file-diff" onClick={() => { setProposeError(null); setProposeOpen(true) }}>Propose edit</Button>
          ) : undefined}
          meta={<span>v{selectedPage.version} - {selectedPage.updatedBy} - {formatDate(selectedPage.updatedAt)}</span>}
          blocks={selectedPage.body.map(toWikiBlock)}
          links={selectedPage.links.map((link, index) => ({
            id: `${link.kind}:${link.targetId || link.label}:${index}`,
            label: link.label,
            icon: linkIcon(link.kind),
          }))}
        />
      ) : (
        <EmptyState icon="book-open" title="No readable pages" body={error || 'Knowledge pages appear after a proposal is accepted.'} />
      ), targets.reader) : null}

      {targets.review ? createPortal((
        <KnowledgeReviewQueue
          snapshot={snapshot}
          canReviewKnowledge={canReviewKnowledge}
          busyProposalId={busyProposalId}
          onAccept={(proposal) => void acceptProposal(proposal)}
          onDecline={(proposal) => void declineProposal(proposal)}
        />
      ), targets.review) : null}

      {targets.history ? createPortal((
        <div className="knowledge-history-list">
          <div className="knowledge-panel-heading"><strong>Version history</strong><Badge tone="neutral">{history.length}</Badge></div>
          {history.map((version) => {
            const isCurrent = version.version === (selectedPage?.version || 0)
            return (
              <div key={`${version.id}:${version.version}`} className="knowledge-history-row">
                <strong>v{version.version}</strong>
                <span>{version.updatedBy}</span>
                <small>{formatDate(version.updatedAt)}</small>
                {isCurrent ? (
                  <Badge tone="neutral">Current</Badge>
                ) : canReviewKnowledge ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    leftIcon="rotate-ccw"
                    disabled={Boolean(busyVersionId)}
                    onClick={() => void restoreVersion(version)}
                  >
                    {busyVersionId === version.versionId ? 'Restoring' : 'Restore'}
                  </Button>
                ) : null}
              </div>
            )
          })}
          {!history.length ? <p className="empty">No versions loaded.</p> : null}
        </div>
      ), targets.history) : null}

      {targets.graph ? createPortal((
        <div className="knowledge-graph-card">
          <div className="knowledge-panel-heading"><strong>Graph</strong><Badge tone="accent">{snapshot.graph.nodes.length} nodes</Badge></div>
          {view === 'graph'
            ? <p className="empty">Graph is open in the main view.</p>
            : <KnowledgeGraph graph={snapshot.graph} selectedPageId={selectedPage?.id || null} onSelectPage={setSelectedPageId} />}
        </div>
      ), targets.graph) : null}

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
    </>
  )
}
