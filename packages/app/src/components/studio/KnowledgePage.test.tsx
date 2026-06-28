import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KnowledgeSnapshotPayload } from '@open-cowork/shared'
import { KnowledgePage } from './KnowledgePage'
import { installRendererTestCoworkApi } from '../../test/setup'
import { useSessionStore } from '../../stores/session'
import { LOCAL_WORKSPACE_ID } from '../../stores/session-workspace-keys'

function snapshot(overrides: Partial<KnowledgeSnapshotPayload> = {}): KnowledgeSnapshotPayload {
  const space = {
    id: 'space-1',
    name: 'Onboarding',
    visibility: 'company' as const,
    role: 'Maintainer' as const,
  }
  const page = {
    id: 'page-1',
    spaceId: 'space-1',
    title: 'Getting started',
    updatedBy: 'Ada',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    revision: 'rev-1',
    links: [],
    body: [{ id: 'b1', type: 'p' as const, text: 'Welcome aboard.' }],
  }
  return {
    spaces: [space],
    pages: [page],
    proposals: [{
      id: 'proposal-1',
      pageId: 'page-1',
      pageTitle: 'Getting started',
      spaceId: 'space-1',
      by: 'Grace',
      when: '2026-01-02T00:00:00.000Z',
      summary: 'Clarify the setup steps.',
      add: 4,
      del: 1,
      status: 'pending' as const,
      links: [],
      body: [{ id: 'b2', type: 'p' as const, text: 'Updated copy.' }],
    }],
    graph: {
      nodes: [
        { id: 'root', kind: 'root', label: 'Knowledge' },
        { id: 'space-1', kind: 'space', label: 'Onboarding' },
        { id: 'page-1', kind: 'page', label: 'Getting started', spaceId: 'space-1' },
      ],
      edges: [],
    },
    ...overrides,
  }
}

function installKnowledgeApi(payload = snapshot()) {
  return installRendererTestCoworkApi({
    knowledge: {
      snapshot: vi.fn(async () => payload),
      history: vi.fn(async () => []),
      acceptProposal: vi.fn(async () => ({ page: payload.pages[0] })),
      declineProposal: vi.fn(async () => undefined),
      restoreVersion: vi.fn(async () => undefined),
      propose: vi.fn(async () => undefined),
      createSpace: vi.fn(async () => payload.spaces[0]),
    },
    on: {
      knowledgeUpdated: vi.fn(() => () => undefined),
    },
  })
}

describe('KnowledgePage review-queue reveal', () => {
  beforeEach(() => {
    useSessionStore.setState({ activeWorkspaceId: LOCAL_WORKSPACE_ID })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reveals and scrolls to the review queue on the first click, even from graph view', async () => {
    const user = userEvent.setup()
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => undefined)
    // Reproduce the real-machine race where the animation frame fires before
    // React commits the pages view: run rAF callbacks synchronously, so a reveal
    // that scrolls from inside the click handler would see an unmounted (null)
    // ref. A reveal that scrolls from a commit-keyed effect still lands.
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0)
      return 0
    })
    installKnowledgeApi()

    render(<KnowledgePage />)

    // Wait for the snapshot to load, then switch into graph view so the review
    // queue panel (and its scroll target ref) is unmounted.
    await screen.findByRole('heading', { level: 1, name: 'Getting started' })
    await user.click(screen.getByRole('tab', { name: 'Graph' }))
    await screen.findByText('Knowledge graph')
    expect(screen.queryByRole('heading', { name: 'Review queue' })).not.toBeInTheDocument()
    scrollIntoView.mockClear()

    // First click on the rail shortcut switches back to pages and scrolls to the
    // freshly mounted review queue — no dead first click.
    await user.click(screen.getByRole('button', { name: 'Review queue' }))

    await screen.findByRole('heading', { name: 'Review queue' })
    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' })
    })
  })

  it('scrolls to the review queue when already in pages view', async () => {
    const user = userEvent.setup()
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => undefined)
    installKnowledgeApi()

    render(<KnowledgePage />)

    await screen.findByRole('heading', { level: 1, name: 'Getting started' })
    // Already in pages view, so the review queue is mounted from the start.
    expect(screen.getByRole('heading', { name: 'Review queue' })).toBeInTheDocument()
    scrollIntoView.mockClear()

    await user.click(screen.getByRole('button', { name: 'Review queue' }))

    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' })
    })
  })
})

describe('KnowledgePage clarity redesign', () => {
  beforeEach(() => {
    useSessionStore.setState({ activeWorkspaceId: LOCAL_WORKSPACE_ID })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows the viewer access capabilities for the selected Space', async () => {
    installKnowledgeApi()
    render(<KnowledgePage />)

    await screen.findByRole('heading', { level: 1, name: 'Getting started' })
    expect(screen.getByRole('heading', { name: 'Your access' })).toBeInTheDocument()
    // A Maintainer can read, propose, and review — all three capability chips render.
    expect(screen.getByText('Read')).toBeInTheDocument()
    expect(screen.getByText('Propose')).toBeInTheDocument()
    expect(screen.getByText('Review')).toBeInTheDocument()
  })

  it('shows first-run guidance instead of the empty 3-column scaffold when there are no Spaces', async () => {
    installKnowledgeApi(snapshot({ spaces: [], pages: [], proposals: [], graph: { nodes: [], edges: [] } }))
    render(<KnowledgePage />)

    expect(await screen.findByRole('heading', { name: 'Start your knowledge base' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create your first Space' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Review queue' })).not.toBeInTheDocument()
  })
})
