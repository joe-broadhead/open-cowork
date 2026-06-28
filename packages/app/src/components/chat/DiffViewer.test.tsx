import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionFileDiff } from '@open-cowork/shared'
import { installRendererTestCoworkApi } from '../../test/setup'
import { DiffViewer } from './DiffViewer'

const multiHunkPatch = [
  '@@ -1,3 +1,3 @@',
  ' context one',
  '-const value = 1',
  '+const value = 2',
  ' context two',
  '@@ -12,2 +12,2 @@',
  ' context later',
  '-old later',
  '+new later',
].join('\n')

const diffs: SessionFileDiff[] = [
  {
    file: 'src/app.ts',
    status: 'modified',
    additions: 2,
    deletions: 2,
    patch: multiHunkPatch,
  },
  {
    file: 'assets/logo.png',
    status: 'added',
    additions: 0,
    deletions: 0,
    patch: '',
  },
]

function installDiffApi(options: {
  diffResult?: SessionFileDiff[]
  diffRejects?: boolean
  snippetRejects?: boolean
} = {}) {
  return installRendererTestCoworkApi({
    session: {
      diff: vi.fn(async () => {
        if (options.diffRejects) throw new Error('diff unavailable')
        return options.diffResult ?? diffs
      }),
      fileSnippet: vi.fn(async () => {
        if (options.snippetRejects) throw new Error('snippet unavailable')
        return ['hidden line four', 'hidden line five']
      }),
    },
  })
}

function expectExactTextContent(text: string) {
  expect(screen.getAllByText((_, element) => element?.textContent === text)[0]).toBeInTheDocument()
}

beforeEach(() => {
  vi.clearAllMocks()
  installDiffApi()
})

describe('DiffViewer', () => {
  it('loads message-scoped diffs, toggles files, and switches between unified and split views', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const api = installDiffApi()

    render(<DiffViewer sessionId="session-1" messageId="message-1" onClose={onClose} />)

    expect(screen.getByRole('dialog', { name: 'Changes from this message' })).toBeInTheDocument()
    expect(document.querySelector('[data-diff-view="true"]')).toBeInTheDocument()
    expect(screen.getByText('Loading changes...')).toBeInTheDocument()

    await screen.findByText('2 file(s) changed')
    expect(api.session.diff).toHaveBeenCalledWith('session-1', 'message-1')

    await user.click(screen.getByText('src/app.ts'))
    expect(screen.getByText('@@ -1,3 +1,3 @@')).toBeInTheDocument()
    expectExactTextContent('const value = 1')
    expectExactTextContent('const value = 2')
    expectExactTextContent('+2')
    expectExactTextContent('−2')

    await user.click(screen.getByRole('button', { name: 'Split' }))
    expect(screen.getByRole('button', { name: 'Split' })).toHaveStyle({ background: 'var(--color-surface-active)' })
    expect(screen.getAllByText('context one')).toHaveLength(2)

    await user.click(screen.getByText('assets/logo.png'))
    expect(screen.getByText('No textual diff available (binary file, rename, or whitespace-only change).')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Close changes' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('expands collapsed hunk gaps through the bounded file snippet IPC', async () => {
    const user = userEvent.setup()
    const api = installDiffApi()

    render(<DiffViewer sessionId="session-2" onClose={vi.fn()} />)

    await screen.findByText('src/app.ts')
    await user.click(screen.getByText('src/app.ts'))

    await user.click(screen.getByRole('button', { name: 'Show 8 unchanged line(s)' }))

    await waitFor(() => {
      expect(api.session.fileSnippet).toHaveBeenCalledWith({
        sessionId: 'session-2',
        filePath: 'src/app.ts',
        startLine: 4,
        endLine: 11,
      })
    })
    expect(screen.getByText('hidden line four')).toBeInTheDocument()
    expect(screen.getByText('hidden line five')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Collapse' }))
    expect(screen.queryByText('hidden line four')).not.toBeInTheDocument()
  })

  it('surfaces empty and failed diff loads without crashing the dialog', async () => {
    const { rerender } = render(<DiffViewer sessionId="empty-session" onClose={vi.fn()} />)

    installDiffApi({ diffResult: [] })
    rerender(<DiffViewer sessionId="empty-session-2" onClose={vi.fn()} />)
    expect(await screen.findByText('No file changes in this session')).toBeInTheDocument()

    installDiffApi({ diffRejects: true })
    rerender(<DiffViewer sessionId="failed-session" onClose={vi.fn()} />)
    expect(await screen.findByText('No file changes in this session')).toBeInTheDocument()
  })

  it('labels synthetic fallback diffs as estimated', async () => {
    installDiffApi({
      diffResult: [{
        file: 'generated/report.md',
        status: 'added',
        additions: 2,
        deletions: 0,
        patch: '@@ -0,0 +1,2 @@\n+# Report\n+Hello',
        source: 'synthetic',
        synthetic: true,
      }],
    })

    render(<DiffViewer sessionId="session-synthetic" onClose={vi.fn()} />)

    expect(await screen.findByText('estimated')).toBeInTheDocument()
    expect(screen.getByTitle('Estimated from projected tool output; not an authoritative OpenCode snapshot diff')).toBeInTheDocument()
  })

  it('shows snippet failures inline so collapsed context can be retried', async () => {
    const user = userEvent.setup()
    installDiffApi({ snippetRejects: true })

    render(<DiffViewer sessionId="session-3" onClose={vi.fn()} />)

    await screen.findByText('src/app.ts')
    await user.click(screen.getByText('src/app.ts'))
    await user.click(screen.getByRole('button', { name: 'Show 8 unchanged line(s)' }))

    expect(await screen.findByRole('button', { name: 'Could not load: snippet unavailable' })).toBeInTheDocument()
  })
})
