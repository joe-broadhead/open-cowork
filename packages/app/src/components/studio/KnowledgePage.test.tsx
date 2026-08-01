import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KnowledgeSnapshotPayload } from '@open-cowork/shared'
import { KnowledgePage } from './KnowledgePage'
import { installRendererTestCoworkApi } from '../../test/setup'
import { useSessionStore } from '../../stores/session'
import { LOCAL_WORKSPACE_ID } from '../../stores/session-workspace-keys'

const featureValueTelemetry = vi.hoisted(() => ({
  activate: vi.fn(),
  discover: vi.fn(),
}))

vi.mock('../../helpers/feature-value-telemetry', () => ({
  recordFeatureValueActivation: featureValueTelemetry.activate,
  recordFeatureValueDiscovery: featureValueTelemetry.discover,
}))

function installViewport(initialWidth: number) {
  let width = initialWidth
  const listeners = new Map<string, Set<() => void>>()
  const matches = (query: string) => {
    const maxWidth = /max-width:\s*(\d+)px/.exec(query)?.[1]
    return maxWidth ? width <= Number(maxWidth) : false
  }

  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      get matches() { return matches(query) },
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: (_type: string, listener: () => void) => {
        const queryListeners = listeners.get(query) || new Set<() => void>()
        queryListeners.add(listener)
        listeners.set(query, queryListeners)
      },
      removeEventListener: (_type: string, listener: () => void) => {
        listeners.get(query)?.delete(listener)
      },
      dispatchEvent: vi.fn(),
    })),
  })

  return {
    setWidth(nextWidth: number) {
      width = nextWidth
      listeners.forEach((queryListeners) => queryListeners.forEach((listener) => listener()))
    },
  }
}

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

function localStarterSnapshot(overrides: Partial<KnowledgeSnapshotPayload> = {}): KnowledgeSnapshotPayload {
  return {
    spaces: [{
      id: 'space:local:company-os',
      name: 'Company OS',
      icon: 'book-open',
      hue: 'azure',
      visibility: 'company',
      role: 'Maintainer',
    }],
    pages: [{
      id: 'page:local:operating-model',
      spaceId: 'space:local:company-os',
      title: 'Operating model',
      updatedBy: 'Open Cowork',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 1,
      revision: 'ffed82865231a17c4aee4da9dba33e731491806b1afcc0a513772e53000f7ec6',
      links: [],
      body: [
        { id: 'scope', type: 'callout', text: 'Knowledge captures accepted project decisions, task outcomes, and artifact context after human review.' },
        { id: 'workflow-heading', type: 'h', text: 'Review workflow' },
        { id: 'workflow-body', type: 'p', text: 'Coworkers and humans can propose updates. Maintainers review proposals before a page version is published.' },
        { id: 'workflow-list', type: 'list', items: ['Capture context from a conversation', 'Review the proposal diff stats', 'Accept to publish a new audited version'] },
      ],
    }],
    proposals: [],
    graph: {
      nodes: [
        { id: 'root', kind: 'root', label: 'Company OS' },
        { id: 'space:local:company-os', kind: 'space', label: 'Company OS', spaceId: 'space:local:company-os' },
        { id: 'page:local:operating-model', kind: 'page', label: 'Operating model', spaceId: 'space:local:company-os' },
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
    vi.clearAllMocks()
    installViewport(1440)
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
    await user.click(screen.getByRole('radio', { name: 'Graph' }))
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
    vi.clearAllMocks()
    installViewport(1440)
    useSessionStore.setState({ activeWorkspaceId: LOCAL_WORKSPACE_ID })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows the viewer access capabilities for the selected Space', async () => {
    installKnowledgeApi()
    render(<KnowledgePage />)

    await screen.findByRole('heading', { level: 1, name: 'Getting started' })
    expect(screen.getByText('Shared team knowledge')).toBeInTheDocument()
    expect(screen.queryByText(/\bwiki\b/i)).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Your access' })).toBeInTheDocument()
    // A Maintainer can read, propose, and review — all three capability chips render.
    expect(screen.getByText('Read')).toBeInTheDocument()
    expect(screen.getByText('Propose')).toBeInTheDocument()
    expect(screen.getByText('Review')).toBeInTheDocument()
  })

  it('shows first-run guidance instead of the full workbench for an exact untouched local starter', async () => {
    const user = userEvent.setup()
    installKnowledgeApi(localStarterSnapshot())
    render(<KnowledgePage />)

    expect(await screen.findByRole('heading', { name: 'Start your knowledge base' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Create a Space' }))
    expect(screen.getByRole('dialog', { name: 'New Space' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
    expect(screen.queryByRole('heading', { name: 'Review queue' })).not.toBeInTheDocument()
  })

  it('never hides a modified starter page behind first-run guidance', async () => {
    const starter = localStarterSnapshot()
    installKnowledgeApi(localStarterSnapshot({
      pages: [{ ...starter.pages[0]!, revision: 'user-content-revision' }],
    }))
    render(<KnowledgePage />)

    expect(await screen.findByRole('heading', { level: 1, name: 'Operating model' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Start your knowledge base' })).not.toBeInTheDocument()
  })
})

describe('KnowledgePage responsive rails', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    installViewport(1440)
    useSessionStore.setState({ activeWorkspaceId: LOCAL_WORKSPACE_ID })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses accessible drawers at 800px and returns focus to each opener', async () => {
    const user = userEvent.setup()
    installViewport(800)
    installKnowledgeApi()

    render(<KnowledgePage />)

    await screen.findByRole('heading', { level: 1, name: 'Getting started' })
    expect(document.querySelector('[data-knowledge-layout="compact"]')).toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: 'Knowledge Spaces' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Review queue' })).not.toBeInTheDocument()

    const spacesOpener = screen.getByRole('button', { name: 'Open Spaces' })
    await user.click(spacesOpener)
    const spacesDialog = screen.getByRole('dialog', { name: 'Spaces' })
    expect(within(spacesDialog).getByRole('complementary', { name: 'Knowledge Spaces' })).toBeInTheDocument()
    await user.click(within(spacesDialog).getByRole('button', { name: 'Close dialog' }))
    await waitFor(() => expect(document.activeElement).toBe(spacesOpener))

    const detailsOpener = screen.getByRole('button', { name: 'Open Review & details' })
    await user.click(detailsOpener)
    const detailsDialog = screen.getByRole('dialog', { name: 'Review & page details' })
    expect(within(detailsDialog).getByRole('heading', { name: 'Review queue' })).toBeInTheDocument()
    expect(within(detailsDialog).getByRole('heading', { name: 'Your access' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(document.activeElement).toBe(detailsOpener))
  })

  it('keeps Spaces inline and moves review details to a drawer at 1024px', async () => {
    const user = userEvent.setup()
    installViewport(1024)
    installKnowledgeApi()

    render(<KnowledgePage />)

    await screen.findByRole('heading', { level: 1, name: 'Getting started' })
    expect(document.querySelector('[data-knowledge-layout="balanced"]')).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Knowledge Spaces' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open Spaces' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Review queue' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Open Review & details' }))
    const detailsDialog = screen.getByRole('dialog', { name: 'Review & page details' })
    expect(within(detailsDialog).getByRole('heading', { name: 'Review queue' })).toBeInTheDocument()
  })

  it('shows both supporting rails inline at 1440px', async () => {
    installViewport(1440)
    installKnowledgeApi()

    render(<KnowledgePage />)

    await screen.findByRole('heading', { level: 1, name: 'Getting started' })
    expect(document.querySelector('[data-knowledge-layout="wide"]')).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Knowledge Spaces' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Review queue' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Your access' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Open (Spaces|Review)/ })).not.toBeInTheDocument()
  })

  it('preserves the selected page while rails change presentation', async () => {
    const user = userEvent.setup()
    const viewport = installViewport(1440)
    const initial = snapshot()
    const secondPage = {
      ...initial.pages[0]!,
      id: 'page-2',
      title: 'Benefits',
      revision: 'rev-2',
    }
    installKnowledgeApi(snapshot({ pages: [...initial.pages, secondPage] }))

    render(<KnowledgePage />)

    await screen.findByRole('heading', { level: 1, name: 'Getting started' })
    await user.click(screen.getByRole('button', { name: 'Benefits' }))
    expect(screen.getByRole('heading', { level: 1, name: 'Benefits' })).toBeInTheDocument()

    act(() => viewport.setWidth(800))
    await waitFor(() => expect(document.querySelector('[data-knowledge-layout="compact"]')).toBeInTheDocument())
    expect(screen.getByRole('heading', { level: 1, name: 'Benefits' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open Spaces' }))
    expect(screen.getByRole('dialog', { name: 'Spaces' })).toBeInTheDocument()

    act(() => viewport.setWidth(1024))
    await waitFor(() => expect(document.querySelector('[data-knowledge-layout="balanced"]')).toBeInTheDocument())
    expect(screen.queryByRole('dialog', { name: 'Spaces' })).not.toBeInTheDocument()
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Knowledge content' }))
    expect(screen.getByRole('heading', { level: 1, name: 'Benefits' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Benefits' })).toHaveAttribute('data-active', 'true')

    act(() => viewport.setWidth(1440))
    await waitFor(() => expect(document.querySelector('[data-knowledge-layout="wide"]')).toBeInTheDocument())
    expect(screen.getByRole('heading', { level: 1, name: 'Benefits' })).toBeInTheDocument()
  })

  it.each([
    [800, 'compact'],
    [1024, 'balanced'],
    [1440, 'wide'],
  ] as const)('keeps the empty first-run state bounded at %ipx', async (width, mode) => {
    installViewport(width)
    installKnowledgeApi(snapshot({ spaces: [], pages: [], proposals: [], graph: { nodes: [], edges: [] } }))

    render(<KnowledgePage />)

    expect(await screen.findByRole('heading', { name: 'Start your knowledge base' })).toBeInTheDocument()
    const viewport = document.querySelector(`[data-knowledge-viewport="${mode}"]`)
    expect(viewport).toBeInTheDocument()
    expect(viewport).toHaveClass('overflow-x-hidden')
  })
})

describe('KnowledgePage value activation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    installViewport(1440)
    useSessionStore.setState({ activeWorkspaceId: LOCAL_WORKSPACE_ID })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('records value only after a proposal is accepted successfully', async () => {
    const user = userEvent.setup()
    const api = installKnowledgeApi()
    render(<KnowledgePage />)

    await screen.findByRole('heading', { level: 1, name: 'Getting started' })
    await user.click(screen.getByRole('button', { name: 'Accept' }))

    await waitFor(() => expect(api.knowledge.acceptProposal).toHaveBeenCalledTimes(1))
    expect(featureValueTelemetry.activate).toHaveBeenCalledTimes(1)
    expect(featureValueTelemetry.activate).toHaveBeenCalledWith('knowledge')
  })

  it('does not record value when the mutation fails', async () => {
    const user = userEvent.setup()
    const api = installKnowledgeApi()
    vi.mocked(api.knowledge.acceptProposal).mockRejectedValueOnce(new Error('Publish failed'))
    render(<KnowledgePage />)

    await screen.findByRole('heading', { level: 1, name: 'Getting started' })
    await user.click(screen.getByRole('button', { name: 'Accept' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Publish failed')
    expect(featureValueTelemetry.activate).not.toHaveBeenCalled()
  })
})

describe('KnowledgePage value discovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    installViewport(1440)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not record discovery for the Desktop Cloud handoff state', async () => {
    useSessionStore.setState({ activeWorkspaceId: 'cloud:test' })
    const api = installKnowledgeApi()

    render(<KnowledgePage />)

    expect(await screen.findByText('Switch to Local for desktop Knowledge')).toBeInTheDocument()
    expect(api.knowledge.snapshot).not.toHaveBeenCalled()
    expect(featureValueTelemetry.discover).not.toHaveBeenCalledWith('knowledge')
  })
})
