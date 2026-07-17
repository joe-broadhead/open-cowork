import { useRef, useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import {
  Badge,
  Button,
  Card,
  Dialog,
  ActionCluster,
  AgentCapabilityProfileView,
  ConversationLaneCard,
  CoworkerAvatar,
  DeliverableCard,
  DiffView,
  EmptyState,
  Icon,
  IconButton,
  Input,
  Kbd,
  KanbanBoard,
  Menu,
  PermissionEditorRow,
  SegmentedControl,
  Select,
  Skeleton,
  StudioShell,
  RunTimeline,
  Textarea,
  Tooltip,
  TraitSlider,
  WorkbenchLayout,
} from '@open-cowork/ui'
import { PrimitiveGallery } from './PrimitiveGallery'

describe('Icon', () => {
  it('renders decorative Lucide icons by default', () => {
    const { container } = render(<Icon name="search" />)
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })
})

describe('Button and IconButton', () => {
  it('covers loading and disabled reason states', () => {
    render(
      <div>
        <p id="run-context">Requires workspace access.</p>
        <Button loading>Save</Button>
        <Button aria-describedby="run-context" disabledReason="Workspace policy blocks this.">Run</Button>
        <IconButton icon="search" label="Search threads" badge="2" />
      </div>,
    )

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Run' }).getAttribute('aria-describedby')).toContain('run-context')
    expect(screen.getByText('Workspace policy blocks this.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Search threads' })).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
  })
})

describe('Input and Textarea', () => {
  it('supports clearable inputs, errors, and disabled reasons', async () => {
    const user = userEvent.setup()
    const onClear = vi.fn()
    render(
      <div>
        <Input aria-label="Search" clearable value="threads" onClear={onClear} onChange={vi.fn()} error="Too broad." />
        <Input aria-label="Locked" disabledReason="Managed by policy." />
      </div>,
    )

    expect(screen.getByLabelText('Search')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('Too broad.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Clear' }))
    expect(onClear).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('Locked')).toBeDisabled()
    expect(screen.getByText('Managed by policy.')).toBeInTheDocument()
  })

  it('tracks clearable uncontrolled input state', async () => {
    const user = userEvent.setup()
    render(<Input aria-label="Filter" clearable />)

    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('Filter'), 'agents')

    await user.click(screen.getByRole('button', { name: 'Clear' }))
    expect(screen.getByLabelText('Filter')).toHaveValue('')
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument()
  })

  it('renders textarea with error and disabled state semantics', () => {
    render(<Textarea aria-label="Instructions" maxHeight="md" error="Required." disabledReason="Read-only workspace." />)

    expect(screen.getByLabelText('Instructions')).toBeDisabled()
    expect(screen.getByLabelText('Instructions')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('Instructions').style.getPropertyValue('--ui-textarea-max-height')).toBe('calc(var(--space-12) * 3)')
    expect(screen.getByText('Required.')).toBeInTheDocument()
    expect(screen.getByText('Read-only workspace.')).toBeInTheDocument()
  })
})

describe('Select and Menu', () => {
  it('selects options with roving keyboard focus', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <Select
        label="Mode"
        value="plan"
        onChange={onChange}
        options={[
          { value: 'plan', label: 'Plan' },
          { value: 'build', label: 'Build' },
        ]}
      />,
    )

    await user.click(screen.getByRole('button', { name: /Plan/ }))
    expect(screen.getByRole('listbox', { name: 'Mode' })).toBeInTheDocument()
    await user.keyboard('{ArrowDown}{Enter}')

    expect(onChange).toHaveBeenCalledWith('build')
  })

  it('runs menu actions from the keyboard and exposes menu roles', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(
      <Menu
        label="Thread actions"
        items={[
          { id: 'copy', label: 'Copy link' },
          { id: 'fork', label: 'Fork thread' },
        ]}
        onSelect={onSelect}
      />,
    )

    await user.click(screen.getByRole('button', { name: /Thread actions/ }))
    expect(screen.getByRole('menu', { name: 'Thread actions' })).toBeInTheDocument()
    await user.keyboard('{ArrowDown}{Enter}')

    expect(onSelect).toHaveBeenCalledWith('fork')
  })

  it('closes Select and Menu with Escape and renders disabled reasons', async () => {
    const user = userEvent.setup()
    render(
      <div>
        <Select
          label="Locked mode"
          value="plan"
          onChange={vi.fn()}
          disabledReason="Mode is managed."
          options={[{ value: 'plan', label: 'Plan' }]}
        />
        <Menu
          label="Locked actions"
          disabledReason="Actions are managed."
          items={[{ id: 'copy', label: 'Copy link' }]}
          onSelect={vi.fn()}
        />
        <Select
          label="Closable mode"
          value="plan"
          onChange={vi.fn()}
          options={[{ value: 'plan', label: 'Plan' }]}
        />
        <Menu
          label="Closable actions"
          items={[{ id: 'copy', label: 'Copy link' }]}
          onSelect={vi.fn()}
        />
      </div>,
    )

    expect(screen.getByRole('button', { name: /Locked mode/ })).toBeDisabled()
    expect(screen.getByText('Mode is managed.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Locked actions' })).toBeDisabled()
    expect(screen.getByText('Actions are managed.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Closable mode/ }))
    expect(screen.getByRole('listbox', { name: 'Closable mode' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox', { name: 'Closable mode' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Closable actions/ }))
    expect(screen.getByRole('menu', { name: 'Closable actions' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu', { name: 'Closable actions' })).not.toBeInTheDocument()
  })

  it('focuses an enabled Select option when the selected value is disabled', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <Select
        label="Mode"
        value="review"
        onChange={onChange}
        options={[
          { value: 'review', label: 'Review', disabled: true, disabledReason: 'Unavailable.' },
          { value: 'plan', label: 'Plan' },
        ]}
      />,
    )

    await user.click(screen.getByRole('button', { name: /Review/ }))
    expect(screen.getByRole('option', { name: 'Plan' })).toHaveFocus()
    await user.keyboard('{Enter}')

    expect(onChange).toHaveBeenCalledWith('plan')
  })

  it('renders empty popovers as disabled described states', () => {
    render(
      <div>
        <Select label="Empty mode" value="" onChange={vi.fn()} options={[]} />
        <Menu label="Empty actions" items={[]} onSelect={vi.fn()} />
      </div>,
    )

    expect(screen.getByRole('button', { name: /Empty mode/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Empty actions' })).toBeDisabled()
    expect(screen.getByText('No options available.')).toBeInTheDocument()
    expect(screen.getByText('No actions available.')).toBeInTheDocument()
  })
})

describe('Dialog', () => {
  it('renders a modal dialog and closes with Escape', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <Dialog title="Confirm" onClose={onClose}>
        <Button>Keep working</Button>
      </Dialog>,
    )

    expect(screen.getByRole('dialog', { name: 'Confirm' })).toHaveAttribute('aria-modal', 'true')
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('renders a drawer variant with the same accessible dialog contract', () => {
    const { container } = render(
      <Dialog title="Task drawer" variant="drawer" onClose={vi.fn()}>
        <p>Drawer details</p>
      </Dialog>,
    )

    expect(screen.getByRole('dialog', { name: 'Task drawer' })).toHaveClass('ui-dialog--drawer')
    expect(container.querySelector('.ui-dialog-backdrop--drawer')).toBeInTheDocument()
  })

  it('restores focus and closes with Cmd/Ctrl+W', async () => {
    const user = userEvent.setup()

    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <Button onClick={() => setOpen(true)}>Open dialog</Button>
          {open ? (
            <Dialog title="Review" onClose={() => setOpen(false)}>
              <Button>Inside dialog</Button>
            </Dialog>
          ) : null}
        </>
      )
    }

    render(<Harness />)

    const opener = screen.getByRole('button', { name: 'Open dialog' })
    await user.click(opener)
    expect(screen.getByRole('dialog', { name: 'Review' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveFocus()

    fireEvent.keyDown(document, { key: 'w', metaKey: true })
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Review' })).not.toBeInTheDocument()
    })
    expect(opener).toHaveFocus()
  })

  it('restores focus to an explicit stable trigger when the opener unmounts', async () => {
    const user = userEvent.setup()

    function Harness() {
      const [open, setOpen] = useState(false)
      const stableTriggerRef = useRef<HTMLButtonElement>(null)
      return (
        <>
          <Button ref={stableTriggerRef}>New chat</Button>
          {open ? (
            <Dialog title="Cloud project" onClose={() => setOpen(false)} returnFocusRef={stableTriggerRef}>
              <Button>Inside dialog</Button>
            </Dialog>
          ) : (
            <Button onClick={() => setOpen(true)}>Open project</Button>
          )}
        </>
      )
    }

    render(<Harness />)

    await user.click(screen.getByRole('button', { name: 'Open project' }))
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog', { name: 'Cloud project' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New chat' })).toHaveFocus()
  })
})

describe('Card', () => {
  it('supports keyboard activation when interactive', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(<Card interactive onClick={onClick}>Interactive card</Card>)

    const card = screen.getByRole('button', { name: 'Interactive card' })
    card.focus()
    await user.keyboard('{Enter}')

    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('renders tile and hover-lift variants', () => {
    const { container } = render(<Card variant="tile" hover="lift" tile={<Icon name="kanban" />}>Board card</Card>)

    expect(screen.getByText('Board card')).toBeInTheDocument()
    expect(container.querySelector('.ui-card__tile')).toBeInTheDocument()
    expect(container.querySelector('.ui-card--hover-lift')).toBeInTheDocument()
  })
})

describe('Card, Badge, Tooltip, Kbd, EmptyState, Skeleton', () => {
  it('renders static primitives with accessible semantics', async () => {
    vi.useFakeTimers()
    render(
      <div>
        <Card>Static card</Card>
        <Badge tone="success">Ready</Badge>
        <Tooltip content="Tooltip details" delay={10}>
          <button type="button">Hover target</button>
        </Tooltip>
        <Kbd>Cmd</Kbd>
        <EmptyState icon="blocks" title="Nothing here" body="Create something to continue." action={<Button>Create</Button>} />
        <Skeleton variant="card" data-testid="skeleton" />
      </div>,
    )

    expect(screen.getByText('Static card')).toBeInTheDocument()
    expect(screen.getByText('Ready')).toBeInTheDocument()
    fireEvent.focus(screen.getByRole('button', { name: 'Hover target' }))
    act(() => {
      vi.advanceTimersByTime(10)
    })
    expect(screen.getByRole('tooltip')).toHaveTextContent('Tooltip details')
    expect(screen.getByRole('button', { name: 'Hover target' }).getAttribute('aria-describedby')).toBe(screen.getByRole('tooltip').id)
    expect(screen.getByText('Cmd').tagName).toBe('KBD')
    expect(screen.getByText('Nothing here')).toBeInTheDocument()
    expect(screen.getByTestId('skeleton')).toHaveAttribute('aria-hidden', 'true')
    vi.useRealTimers()
  })
})

describe('Workbench IA primitives', () => {
  it('renders the shared layout, action cluster, and diff review surface', async () => {
    const user = userEvent.setup()
    const onReview = vi.fn()
    const { container } = render(
      <WorkbenchLayout
        leftLabel="Threads"
        mainLabel="Conversation"
        reviewLabel="Review"
        leftPane={<div>Thread list</div>}
        mainPane={<div>Active conversation</div>}
        reviewPane={(
          <DiffView
            title="Review"
            subtitle="1 file changed"
            files={[{ id: 'file-1', path: 'src/app.ts', status: 'modified', additions: 3, deletions: 1 }]}
          />
        )}
        actionCluster={<ActionCluster label="Thread actions" items={[{ id: 'review', label: 'Review', icon: 'file-diff', onAction: onReview }]} />}
      />,
    )

    expect(container.querySelector('[data-workbench-layout="true"]')).toBeInTheDocument()
    expect(container.querySelector('[data-workbench-pane="threads"]')).toHaveTextContent('Thread list')
    expect(container.querySelector('[data-workbench-pane="conversation"]')).toHaveTextContent('Active conversation')
    expect(container.querySelector('[data-workbench-pane="review"]')).toHaveTextContent('src/app.ts')
    expect(screen.getByRole('toolbar', { name: 'Thread actions' })).toBeInTheDocument()
    expect(container.querySelector('[data-diff-view="true"]')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Review' }))
    expect(onReview).toHaveBeenCalledTimes(1)
  })

  it('focus-manages the review pane as a narrow drawer', async () => {
    const user = userEvent.setup()
    const originalMatchMedia = window.matchMedia
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query === '(max-width: 920px)',
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })

    function DrawerHarness() {
      const [open, setOpen] = useState(false)
      return (
        <div>
          <button type="button" onClick={() => setOpen(true)}>Open review</button>
          <WorkbenchLayout
            mainLabel="Conversation"
            reviewLabel="Review drawer"
            mainPane={<div>Active conversation</div>}
            reviewOpen={open}
            reviewPane={(
              <div>
                <button type="button">First action</button>
                <button type="button" onClick={() => setOpen(false)}>Close drawer</button>
              </div>
            )}
          />
        </div>
      )
    }

    try {
      render(<DrawerHarness />)
      const opener = screen.getByRole('button', { name: 'Open review' })
      await user.click(opener)
      const drawer = screen.getByRole('complementary', { name: 'Review drawer' })
      await waitFor(() => expect(document.activeElement).toBe(drawer))

      const firstAction = screen.getByRole('button', { name: 'First action' })
      const closeAction = screen.getByRole('button', { name: 'Close drawer' })
      firstAction.focus()
      fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
      expect(document.activeElement).toBe(closeAction)

      fireEvent.keyDown(document, { key: 'Tab' })
      expect(document.activeElement).toBe(firstAction)

      await user.click(closeAction)
      await waitFor(() => expect(document.activeElement).toBe(opener))
    } finally {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: originalMatchMedia,
      })
    }
  })
})

describe('Studio primitives', () => {
  const navSections = [
    {
      id: 'workspace',
      label: 'Workspace',
      items: [
        { id: 'chat', label: 'Chat' },
        { id: 'agents', label: 'Coworkers' },
      ],
    },
  ]

  it('keeps StudioShell navigation app-owned without rendering inert buttons', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()

    const { container, rerender } = render(
      <StudioShell brand={{ name: 'Open Cowork' }} navSections={navSections} activeItemId="chat" header={<div>Studio status</div>}>
        <p>Studio body</p>
      </StudioShell>,
    )

    expect(screen.queryByRole('button', { name: 'Coworkers' })).not.toBeInTheDocument()
    expect(screen.getByText('Coworkers').closest('.studio-nav__item')).toBeInTheDocument()
    expect(container.querySelector('main')).not.toBeInTheDocument()
    expect(container.querySelector('.studio-shell__topbar')?.tagName).toBe('DIV')

    rerender(
      <StudioShell brand={{ name: 'Open Cowork' }} navSections={navSections} activeItemId="chat" onNavigate={onNavigate}>
        <p>Studio body</p>
      </StudioShell>,
    )

    await user.click(screen.getByRole('button', { name: 'Coworkers' }))
    expect(onNavigate).toHaveBeenCalledWith(navSections[0]!.items[1])
  })

  it('renders presence, conversation lanes, kanban cards, and run timeline states', () => {
    const { container } = render(
      <div>
        <CoworkerAvatar name="Jordan Lee" tone="lead" presence={{ status: 'working', label: 'Running' }} />
        <ConversationLaneCard
          title="Auth review"
          coworker={{ name: 'Maya', role: 'Reviewer', tone: 'reviewer' }}
          status="live"
          activities={[{ id: 'read', verb: 'Reading', object: 'runtime.ts', icon: 'book-open' }]}
          handoff="Ready"
        />
        <KanbanBoard
          columns={[
            {
              id: 'queued',
              title: 'Queued',
              tasks: [{ id: 'task-1', title: 'Add shared primitive', priority: 'urgent', run: { label: 'running', live: true } }],
            },
            { id: 'empty', title: 'Done', tasks: [] },
          ]}
        />
        <RunTimeline
          stateLabel="Running"
          live
          currentStepId="running"
          completedStepIds={['queued']}
          sessionId="ses_test"
          steps={[
            { id: 'queued', label: 'Queued' },
            { id: 'running', label: 'Running' },
          ]}
        />
      </div>,
    )

    expect(screen.getByLabelText('Running')).toHaveClass('studio-presence-dot')
    expect(screen.getByText('Reading')).toBeInTheDocument()
    expect(screen.getByText('Add shared primitive')).toBeInTheDocument()
    expect(screen.getByText('ses_test')).toBeInTheDocument()
    expect(container.querySelector('.studio-run-pill--live')).toBeInTheDocument()
  })

  it('preserves uncontrolled conversation lane disclosure across parent renders', () => {
    const { container, rerender } = render(
      <ConversationLaneCard
        title="Auth review"
        coworker={{ name: 'Maya', role: 'Reviewer', tone: 'reviewer' }}
        status="live"
        activities={[{ id: 'read', verb: 'Reading', object: 'runtime.ts' }]}
      />,
    )
    const lane = container.querySelector('details') as HTMLDetailsElement
    expect(lane.open).toBe(true)

    act(() => {
      lane.open = false
      fireEvent(lane, new Event('toggle'))
    })

    rerender(
      <ConversationLaneCard
        title="Auth review"
        coworker={{ name: 'Maya', role: 'Reviewer', tone: 'reviewer' }}
        status="live"
        activities={[
          { id: 'read', verb: 'Reading', object: 'runtime.ts' },
          { id: 'test', verb: 'Testing', object: 'primitives' },
        ]}
      />,
    )

    expect((container.querySelector('details') as HTMLDetailsElement).open).toBe(false)
  })

  it('scopes Kanban column heading ids per board instance', () => {
    const columns = [{ id: 'done', title: 'Done', tasks: [] }]
    render(
      <div>
        <KanbanBoard columns={columns} />
        <KanbanBoard columns={columns} />
      </div>,
    )

    const headingIds = screen.getAllByRole('heading', { name: 'Done' }).map((heading) => heading.id)
    expect(new Set(headingIds).size).toBe(2)
  })

  it('supports permission editor controls and deliverable preview states', async () => {
    const user = userEvent.setup()
    const onPolicyChange = vi.fn()
    function PermissionHarness() {
      const [rules, setRules] = useState(['scripts/**/*.mjs'])
      return (
        <PermissionEditorRow
          toolName="Bash"
          policy="ask"
          onPolicyChange={onPolicyChange}
          rules={rules}
          onRuleChange={(index, value) => setRules((current) => current.map((rule, ruleIndex) => ruleIndex === index ? value : rule))}
        />
      )
    }

    render(
      <div>
        <PermissionHarness />
        <DeliverableCard
          title="Evidence bundle"
          preview={<span>Preview markdown</span>}
          capturedLabel="Captured"
          captureAction={{ id: 'capture', children: 'Capture preview' }}
        />
      </div>,
    )

    await user.click(screen.getByRole('button', { name: 'deny' }))
    expect(onPolicyChange).toHaveBeenCalledWith('deny')
    expect(screen.getByRole('button', { name: 'ask' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'deny' })).toHaveAttribute('aria-pressed', 'false')
    const ruleInput = screen.getByDisplayValue('scripts/**/*.mjs')
    await user.type(ruleInput, 'x')
    expect(ruleInput).toHaveFocus()
    expect(ruleInput).toHaveValue('scripts/**/*.mjsx')
    expect(screen.getByText('Preview markdown')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Capture preview' })).not.toHaveAttribute('id', 'capture')
    expect(screen.getByText('Captured')).toBeInTheDocument()
  })

  it('respects TraitSlider min and max values while normalizing visual progress', () => {
    const onValueChange = vi.fn()
    render(<TraitSlider label="Autonomy" value={125} min={50} max={150} onValueChange={onValueChange} />)

    const slider = screen.getByLabelText(/Autonomy/)
    expect(slider).toHaveValue('125')
    expect(slider).toHaveAttribute('min', '50')
    expect(slider).toHaveAttribute('max', '150')
    expect(slider.style.getPropertyValue('--studio-progress')).toBe('75%')
    expect(screen.getByText('125')).toBeInTheDocument()

    fireEvent.change(slider, { target: { value: '150' } })
    expect(onValueChange).toHaveBeenCalledWith(150)
  })
})

describe('SegmentedControl', () => {
  it('uses radio roles and keyboard selection', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <SegmentedControl
        label="Agent mode"
        value="plan"
        onChange={onChange}
        options={[
          { value: 'plan', label: 'Plan' },
          { value: 'build', label: 'Build' },
        ]}
      />,
    )

    const plan = screen.getByRole('radio', { name: 'Plan' })
    expect(plan).toHaveAttribute('aria-checked', 'true')
    plan.focus()
    await user.keyboard('{ArrowRight}{Enter}')

    expect(screen.getByRole('radiogroup', { name: 'Agent mode' })).toBeInTheDocument()
    expect(onChange).toHaveBeenCalledWith('build')
  })

  it('renders an empty segmented control without invalid option state', () => {
    render(<SegmentedControl label="Empty segments" value="" onChange={vi.fn()} options={[]} />)

    expect(screen.getByRole('radiogroup', { name: 'Empty segments' })).toBeInTheDocument()
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    expect(screen.getByText('No segments available.')).toBeInTheDocument()
  })
})

describe('AgentCapabilityProfileView', () => {
  it('renders the deterministic profile score, radar, and legend', () => {
    render(
      <AgentCapabilityProfileView
        profile={{
          score: 56,
          label: 'Broad',
          axes: [
            { id: 'reach', label: 'Reach', value: 3, weight: 0.24, raw: '3 tools', description: 'External surfaces.' },
            { id: 'skills', label: 'Skills', value: 2, weight: 0.24, raw: '2 skills', description: 'Methods.' },
            { id: 'context', label: 'Context', value: 3, weight: 0.20, raw: '200K ctx', description: 'Window.' },
            { id: 'autonomy', label: 'Autonomy', value: 2.2727, weight: 0.16, raw: '30 steps', description: 'Runway.' },
            { id: 'precision', label: 'Precision', value: 4, weight: 0.16, raw: 'temp 0.20', description: 'Determinism.' },
          ],
        }}
      />,
    )

    expect(screen.getByLabelText('Agent capability profile: 56 out of 100, Broad')).toBeInTheDocument()
    expect(screen.getByText('Capability profile')).toBeInTheDocument()
    expect(screen.getByText('200K ctx')).toBeInTheDocument()
  })
})

describe('PrimitiveGallery', () => {
  it('renders the primitive review matrix', () => {
    render(<PrimitiveGallery />)

    expect(screen.getByRole('heading', { name: 'UI primitives' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Buttons' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Studio Production Primitives' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Icon Buttons' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Select And Menu' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Badges, Tooltip, Kbd, Skeleton, Toast' })).toBeInTheDocument()
    expect(screen.getByText('primary sm')).toBeInTheDocument()
    expect(screen.getByText('danger lg')).toBeInTheDocument()
    expect(screen.getByText('Card sm')).toBeInTheDocument()
    expect(screen.getByText('Card lg')).toBeInTheDocument()
    expect(screen.getByText('Inspect auth edge cases')).toBeInTheDocument()
    expect(screen.getByText('Test evidence bundle')).toBeInTheDocument()
    expect(screen.getAllByText('Runtime boundary').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Loading settings' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Toast' })).toBeInTheDocument()
    expect(screen.getByText('Mode selection is managed by policy.')).toBeInTheDocument()
  })

  it('has no axe accessibility violations across the shared primitive set', async () => {
    const { container } = render(<PrimitiveGallery />)
    // The gallery exercises every shared primitive (buttons, inputs, selects,
    // cards, dialogs, badges, the Studio production surfaces) in one tree, so
    // this locks their structural a11y (roles, names, contrast) for both apps,
    // which single-source these components from @open-cowork/ui.
    // `heading-order` is a page-structure rule about the synthetic demo gallery's
    // own heading flow (a card title rendered as <h3> is context-appropriate for
    // a real surface) — not a defect in the shared components, so it's scoped out
    // here. Component-level a11y (roles, accessible names, color-contrast) is enforced.
    const result = await axe(container, {
      rules: {
        'color-contrast': { enabled: true },
        'heading-order': { enabled: false },
      },
    })
    expect(result.violations).toEqual([])
  })
})
