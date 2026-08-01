import {
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type DragEvent,
  type FormEvent,
  useEffect,
  useMemo,
  useState,
} from 'react'
import type {
  CoordinationBoardPayload,
  CoordinationChiefOfStaffPlanInput,
  CoordinationProject,
  CoordinationProjectInput,
  CoordinationTask,
  CoordinationTaskAssignInput,
  CoordinationTaskColumn,
  CoordinationTaskMoveInput,
} from '@open-cowork/shared'
import { Badge } from './Badge.js'
import { Button } from './Button.js'
import { Dialog } from './Dialog.js'
import { EmptyState } from './EmptyState.js'
import { Menu, type MenuItem } from './Select.js'
import {
  CoworkerAvatar,
  KanbanTaskCard,
  ProjectCard,
  RunTimeline,
  StudioPageHeader,
  StudioStatusDot,
  type KanbanPriority,
  type StudioStatusTone,
  type StudioTone,
} from './StudioPrimitives.js'
import { cn } from './utils.js'

const COLUMNS: Array<{ id: CoordinationTaskColumn, label: string }> = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'planning', label: 'Planning' },
  { id: 'doing', label: 'In progress' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Done' },
]

const RUN_STEPS = [
  { id: 'queued', label: 'Queued' },
  { id: 'running', label: 'Running' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Done' },
]

const TONES: StudioTone[] = ['lead', 'strategist', 'builder', 'reviewer', 'operator', 'neutral']

type CoworkerCatalogStatus = 'loading' | 'ready' | 'partial' | 'error'

export type ProjectsKanbanSurfaceProps = Omit<ComponentPropsWithoutRef<'section'>, 'onError'> & {
  board: CoordinationBoardPayload | null
  loading?: boolean
  error?: string | null
  disabled?: boolean
  disabledReason?: string
  agents?: string[]
  agentCatalogStatus?: CoworkerCatalogStatus
  agentCatalogMessage?: string
  platformLabel?: string
  projectStatusLabel?: (status: CoordinationProject['status']) => string
  onReload?: () => Promise<void> | void
  onReloadAgents?: () => Promise<void> | void
  onCreateProject?: (input: CoordinationProjectInput) => Promise<unknown> | unknown
  onPlanWithCleo?: (
    projectId: string,
    input: Omit<CoordinationChiefOfStaffPlanInput, 'projectId'>,
  ) => Promise<unknown> | unknown
  onMoveTask?: (taskId: string, input: CoordinationTaskMoveInput) => Promise<unknown> | unknown
  onAssignTask?: (taskId: string, input: CoordinationTaskAssignInput) => Promise<unknown> | unknown
  onOpenConversation?: (project: CoordinationProject) => Promise<unknown> | unknown
  onOpenWork?: (task: CoordinationTask) => Promise<unknown> | unknown
  onHandToAgent?: (task: CoordinationTask, agentName: string) => Promise<unknown> | unknown
}

type ProjectStats = {
  total: number
  done: number
  progress: number
  label: string
}

type Notice = {
  tone: 'success' | 'warning' | 'neutral'
  message: string
}

function defaultProjectStatusLabel(status: CoordinationProject['status']) {
  if (status === 'active') return 'Active'
  if (status === 'paused') return 'Paused'
  if (status === 'completed') return 'Completed'
  return 'Archived'
}

function percent(done: number, total: number) {
  if (total <= 0) return 0
  return Math.round((done / total) * 100)
}

function projectStats(tasks: CoordinationTask[]): ProjectStats {
  const done = tasks.filter((task) => task.column === 'done' || task.status === 'completed').length
  const total = tasks.length
  return {
    total,
    done,
    progress: percent(done, total),
    label: `${done}/${total} done`,
  }
}

function text(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function initials(name: string) {
  return name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase() || 'OC'
}

function toneForName(name: string): StudioTone {
  const index = [...name].reduce((sum, char) => sum + char.charCodeAt(0), 0)
  return TONES[index % TONES.length] || 'neutral'
}

function agentLabel(name: string) {
  const normalized = name.trim().toLowerCase()
  if (normalized === 'chief-of-staff' || normalized === 'cleo') return 'Cleo'
  return name
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ') || name
}

function unique(values: Array<string | null | undefined>) {
  return [...new Set(values.map((value) => text(value)).filter(Boolean))]
}

function priority(task: CoordinationTask): KanbanPriority {
  if (task.priority === 'high') return 'high'
  if (task.priority === 'low') return 'low'
  return 'medium'
}

function taskState(task: CoordinationTask): { label: string, tone: StudioStatusTone } {
  if (task.status === 'failed') return { label: 'Failed', tone: 'danger' }
  if (task.status === 'blocked') return { label: 'Blocked', tone: 'warning' }
  if (task.status === 'cancelled') return { label: 'Cancelled', tone: 'warning' }
  if (task.status === 'completed' || task.column === 'done') return { label: 'Completed', tone: 'success' }
  if (task.column === 'review') return { label: 'Ready for review', tone: 'neutral' }
  if (task.status === 'running') return { label: 'Running now', tone: 'accent' }
  if (task.column === 'doing') return { label: 'In progress', tone: 'accent' }
  if (task.column === 'planning') return { label: 'Planning', tone: 'neutral' }
  if (task.assignedSessionId) return { label: 'Linked work', tone: 'neutral' }
  return { label: 'Queued', tone: 'neutral' }
}

function taskRunLabel(task: CoordinationTask) {
  const state = taskState(task)
  if (state.label === 'Queued' || state.label === 'Planning') return null
  return state.label
}

function timelineForTask(task: CoordinationTask) {
  if (task.status === 'failed' || task.status === 'blocked' || task.status === 'cancelled') {
    const state = taskState(task)
    const queued = task.column === 'backlog' || task.column === 'planning'
    return {
      stateLabel: state.label,
      currentStepId: queued ? 'queued' : 'running',
      completedStepIds: queued ? [] : ['queued'],
      live: false,
    }
  }
  if (task.column === 'done' || task.status === 'completed') {
    return {
      stateLabel: task.status === 'completed' ? 'Completed, waiting for acceptance' : 'Completed',
      currentStepId: 'done',
      completedStepIds: ['queued', 'running', 'review'],
      live: false,
    }
  }
  if (task.column === 'review') {
    return {
      stateLabel: 'Ready for review',
      currentStepId: 'review',
      completedStepIds: ['queued', 'running'],
      live: false,
    }
  }
  if (task.status === 'running' || task.column === 'doing') {
    return {
      stateLabel: task.status === 'running' ? 'Running now' : 'In progress',
      currentStepId: 'running',
      completedStepIds: ['queued'],
      live: task.status === 'running',
    }
  }
  if (task.column === 'planning') {
    return {
      stateLabel: 'Planning handoff',
      currentStepId: 'queued',
      completedStepIds: [],
      live: false,
    }
  }
  return {
    stateLabel: task.assignedSessionId ? 'Linked work' : 'Queued',
    currentStepId: 'queued',
    completedStepIds: [],
    live: false,
  }
}

function createdProjectId(value: unknown) {
  if (!value || typeof value !== 'object') return null
  const record = value as { id?: unknown; project?: { id?: unknown } }
  if (typeof record.id === 'string') return record.id
  if (typeof record.project?.id === 'string') return record.project.id
  return null
}

function noticeMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'Project board action failed.'
}

function TeamAvatars({ agents, limit = 4 }: { agents: string[], limit?: number }) {
  const visible = agents.slice(0, limit)
  if (!visible.length) return <span className="studio-team-empty">No team assigned</span>
  return (
    <span className="studio-team-avatars" aria-label={`Team: ${agents.map(agentLabel).join(', ')}`}>
      {visible.map((agent) => (
        <CoworkerAvatar
          key={agent}
          name={agentLabel(agent)}
          initials={initials(agentLabel(agent))}
          tone={toneForName(agent)}
          presence={agent.toLowerCase() === 'cleo' || agent.toLowerCase() === 'chief-of-staff' ? 'working' : 'available'}
          size="sm"
        />
      ))}
      {agents.length > visible.length ? <span className="studio-team-count">+{agents.length - visible.length}</span> : null}
    </span>
  )
}

function ProjectCreateForm({
  agents,
  agentCatalogStatus,
  agentCatalogMessage,
  disabled,
  disabledReason,
  onReloadAgents,
  onSubmit,
  onCancel,
}: {
  agents: string[]
  agentCatalogStatus: CoworkerCatalogStatus
  agentCatalogMessage?: string
  disabled: boolean
  disabledReason?: string
  onReloadAgents?: () => Promise<void> | void
  onSubmit: (input: CoordinationProjectInput) => Promise<boolean>
  onCancel: () => void
}) {
  const [title, setTitle] = useState('')
  const [objective, setObjective] = useState('')
  const [description, setDescription] = useState('')
  const [team, setTeam] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (disabled || submitting) return
    const nextTitle = title.trim()
    const nextObjective = objective.trim() || nextTitle
    if (!nextTitle || !nextObjective) return
    setSubmitting(true)
    try {
      const created = await onSubmit({
        title: nextTitle,
        objective: nextObjective,
        description: description.trim() || null,
        team,
      })
      if (!created) return
      setTitle('')
      setObjective('')
      setDescription('')
      setTeam([])
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="studio-project-create" onSubmit={submit}>
      <div className="studio-project-create__grid">
        <label>
          <span>Project</span>
          <input value={title} onChange={(event) => setTitle(event.currentTarget.value)} disabled={disabled || submitting} placeholder="Launch customer billing review" />
        </label>
        <CoworkerMultiPicker
          legend="Coworkers"
          agents={agents}
          status={agentCatalogStatus}
          statusMessage={agentCatalogMessage}
          selected={team}
          onChange={setTeam}
          disabled={disabled || submitting}
          onRetry={onReloadAgents}
        />
        <label className="span">
          <span>Objective</span>
          <textarea value={objective} onChange={(event) => setObjective(event.currentTarget.value)} disabled={disabled || submitting} placeholder="What outcome should the coworkers produce?" rows={3} />
        </label>
        <label className="span">
          <span>Notes</span>
          <textarea value={description} onChange={(event) => setDescription(event.currentTarget.value)} disabled={disabled || submitting} placeholder="Constraints, deliverables, context, or acceptance notes" rows={3} />
        </label>
      </div>
      <div className="studio-project-create__actions">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={submitting}>Cancel</Button>
        <Button type="submit" size="sm" variant="primary" leftIcon="plus" disabled={disabled || submitting || !title.trim()} disabledReason={disabledReason}>
          Create project
        </Button>
      </div>
    </form>
  )
}

function ProjectPlanForm({
  project,
  agents,
  agentCatalogStatus,
  agentCatalogMessage,
  disabled,
  disabledReason,
  onReloadAgents,
  onPlan,
}: {
  project: CoordinationProject
  agents: string[]
  agentCatalogStatus: CoworkerCatalogStatus
  agentCatalogMessage?: string
  disabled: boolean
  disabledReason?: string
  onReloadAgents?: () => Promise<void> | void
  onPlan: (input: Omit<CoordinationChiefOfStaffPlanInput, 'projectId'>) => Promise<boolean>
}) {
  const [objective, setObjective] = useState(project.objective)
  const [team, setTeam] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    setObjective(project.objective)
    setTeam(project.team.filter((agent) => agents.includes(agent)))
  }, [agents, project.id, project.objective, project.team])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (disabled || submitting) return
    setSubmitting(true)
    try {
      await onPlan({
        objective: objective.trim() || project.objective,
        assigneeAgents: team,
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="studio-plan-form" onSubmit={submit}>
      <label>
        <span>Objective for Cleo</span>
        <textarea value={objective} onChange={(event) => setObjective(event.currentTarget.value)} rows={3} disabled={disabled || submitting} />
      </label>
      <CoworkerMultiPicker
        legend="Coworkers"
        agents={agents}
        status={agentCatalogStatus}
        statusMessage={agentCatalogMessage}
        selected={team}
        onChange={setTeam}
        disabled={disabled || submitting}
        onRetry={onReloadAgents}
      />
      <Button type="submit" size="sm" variant="primary" leftIcon="sparkles" disabled={disabled || submitting} disabledReason={disabledReason}>
        Plan with Cleo
      </Button>
    </form>
  )
}

function CoworkerMultiPicker({
  legend,
  agents,
  status,
  statusMessage,
  selected,
  onChange,
  disabled,
  onRetry,
}: {
  legend: string
  agents: string[]
  status: CoworkerCatalogStatus
  statusMessage?: string
  selected: string[]
  onChange: (agents: string[]) => void
  disabled: boolean
  onRetry?: () => Promise<void> | void
}) {
  return (
    <fieldset className="studio-coworker-picker span">
      <legend>{legend}</legend>
      {status === 'loading' ? <p>Loading coworkers…</p> : null}
      {status === 'partial' ? (
        <div>
          <p>{statusMessage || 'Some coworkers could not be loaded. Available coworkers are still shown.'}</p>
          {onRetry ? <Button type="button" size="sm" variant="secondary" onClick={() => void onRetry()}>Retry coworkers</Button> : null}
        </div>
      ) : null}
      {status === 'error' ? (
        <div>
          <p>{statusMessage || 'Couldn’t load coworkers. Retry the roster before assigning a team.'}</p>
          {onRetry ? <Button type="button" size="sm" variant="secondary" onClick={() => void onRetry()}>Retry coworkers</Button> : null}
        </div>
      ) : null}
      {status === 'ready' && agents.length === 0 ? (
        <p>No coworkers are available. Add one from Team, then return to this project.</p>
      ) : agents.length > 0 ? (
        <div className="studio-stage-chips" role="group" aria-label={legend}>
          {agents.map((agent) => {
            const active = selected.includes(agent)
            return (
              <button
                key={agent}
                type="button"
                aria-pressed={active}
                data-active={active ? 'true' : undefined}
                disabled={disabled}
                onClick={() => onChange(active
                  ? selected.filter((entry) => entry !== agent)
                  : [...selected, agent])}
              >
                {agentLabel(agent)}
              </button>
            )
          })}
        </div>
      ) : null}
    </fieldset>
  )
}

function ProjectHeader({
  project,
  tasks,
  disabled,
  disabledReason,
  onOpenConversation,
  onShowPlan,
}: {
  project: CoordinationProject
  tasks: CoordinationTask[]
  disabled: boolean
  disabledReason?: string
  onOpenConversation: () => void
  onShowPlan: () => void
}) {
  const stats = projectStats(tasks)
  const agents = unique([...project.team, ...tasks.map((task) => task.assigneeAgent)])
  return (
    <div className="studio-project-board-header">
      <div className="studio-project-board-header__copy">
        <Badge tone="accent">Project board</Badge>
        <h2>{project.title}</h2>
        <p>{project.objective}</p>
        <div className="studio-project-board-header__meta">
          <span className="studio-project-progress" aria-label={stats.label}>
            <span className="studio-u-progress-track"><i className="studio-u-progress-fill" style={{ '--studio-progress': `${stats.progress}%` } as CSSProperties} /></span>
            <em>{stats.label}</em>
          </span>
          <TeamAvatars agents={agents} />
        </div>
      </div>
      <div className="studio-project-board-header__actions">
        <Button size="sm" variant="secondary" leftIcon="message-square" onClick={onOpenConversation}>
          Open conversation
        </Button>
        <Button size="sm" variant="primary" leftIcon="sparkles" onClick={onShowPlan} disabled={disabled} disabledReason={disabledReason}>
          Plan with Cleo
        </Button>
      </div>
    </div>
  )
}

function coworkerAvatar(agent: string) {
  return <CoworkerAvatar name={agentLabel(agent)} initials={initials(agentLabel(agent))} tone={toneForName(agent)} size="sm" aria-hidden="true" />
}

/**
 * An avatar pick-menu for selecting a coworker — the design's replacement for a
 * native `<select>`. The trigger shows the current coworker's avatar + name and
 * the menu lists each coworker with their avatar. Built on the shared `Menu`, so
 * it inherits keyboard support, the focus trap, and Escape-to-close.
 */
function CoworkerPickMenu({
  label,
  value,
  agents,
  onChange,
  includeUnassigned = false,
  disabled,
  disabledReason,
}: {
  label: string
  value: string
  agents: string[]
  onChange: (value: string) => void
  includeUnassigned?: boolean
  disabled?: boolean
  disabledReason?: string
}) {
  const items: MenuItem[] = [
    ...(includeUnassigned
      ? [{ id: '', label: 'Unassigned', icon: <CoworkerAvatar name="Unassigned" initials="—" tone="neutral" size="sm" aria-hidden="true" /> }]
      : []),
    ...agents.map((agent) => ({ id: agent, label: agentLabel(agent), icon: coworkerAvatar(agent) })),
  ]
  const current = value ? agentLabel(value) : 'Unassigned'
  return (
    <Menu
      label={label}
      className="studio-pick-menu"
      triggerLabel={(
        <span className="studio-pick-trigger" style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          {value
            ? coworkerAvatar(value)
            : <CoworkerAvatar name="Unassigned" initials="—" tone="neutral" size="sm" aria-hidden="true" />}
          <span>{current}</span>
        </span>
      )}
      items={items}
      onSelect={onChange}
      disabled={disabled}
      disabledReason={disabledReason}
    />
  )
}

function TaskDrawer({
  task,
  agents,
  disabled,
  disabledReason,
  onMove,
  onAssign,
  onOpenWork,
  onHandToAgent,
}: {
  task: CoordinationTask | null
  agents: string[]
  disabled: boolean
  disabledReason?: string
  onMove: (task: CoordinationTask, column: CoordinationTaskColumn) => Promise<void>
  onAssign: (task: CoordinationTask, agent: string | null) => Promise<void>
  onOpenWork: (task: CoordinationTask) => Promise<void>
  onHandToAgent: (task: CoordinationTask, agent: string) => Promise<void>
}) {
  const [handoffAgent, setHandoffAgent] = useState('')

  useEffect(() => {
    if (task?.assigneeAgent) setHandoffAgent(task.assigneeAgent)
    else setHandoffAgent(agents[0] || '')
  }, [agents, task?.assigneeAgent, task?.id])

  if (!task) {
    return (
      <aside className="studio-task-drawer" aria-label="Task detail">
        <EmptyState icon="kanban" title="Select a task" body="Pick a card to inspect its spec, run timeline, assignee, and linked work." />
      </aside>
    )
  }

  const timeline = timelineForTask(task)
  const state = taskState(task)
  const allAgents = unique([task.assigneeAgent, ...agents])
  const selectedAgent = handoffAgent || task.assigneeAgent || allAgents[0] || ''

  return (
    <aside className="studio-task-drawer" aria-label="Task detail">
      <header className="studio-task-drawer__header">
        <div>
          <StudioStatusDot tone={state.tone} label={state.label} />
          <h2>{task.title}</h2>
          {task.description ? <p>{task.description}</p> : null}
        </div>
      </header>
      <section className="studio-task-drawer__section">
        <h3>Spec</h3>
        <p>{task.spec}</p>
      </section>
      <RunTimeline
        stateLabel={timeline.stateLabel}
        live={timeline.live}
        steps={RUN_STEPS}
        currentStepId={timeline.currentStepId}
        completedStepIds={timeline.completedStepIds}
        linkedChat={Boolean(task.assignedSessionId)}
      />
      <section className="studio-task-drawer__section">
        <h3>Assignee</h3>
        <div className="studio-select-row">
          <span>Coworker</span>
          <CoworkerPickMenu
            label="Coworker"
            value={task.assigneeAgent || ''}
            agents={allAgents}
            includeUnassigned
            disabled={disabled}
            disabledReason={disabled ? disabledReason : undefined}
            onChange={(agent) => void onAssign(task, agent || null)}
          />
        </div>
      </section>
      <section className="studio-task-drawer__section">
        <h3>Stage</h3>
        <div className="studio-stage-chips" role="group" aria-label="Task stage">
          {COLUMNS.map((column) => (
            <button
              key={column.id}
              type="button"
              aria-pressed={task.column === column.id}
              data-active={task.column === column.id ? 'true' : undefined}
              disabled={disabled}
              title={disabled ? disabledReason : undefined}
              onClick={() => void onMove(task, column.id)}
            >
              {column.label}
            </button>
          ))}
        </div>
      </section>
      <section className="studio-task-drawer__section">
        <h3>Actions</h3>
        <div className="studio-task-actions">
          <Button size="sm" variant="secondary" leftIcon="external-link" onClick={() => void onOpenWork(task)}>
            Open the work
          </Button>
          <div className="studio-hand-to">
            <span>Hand to</span>
            <CoworkerPickMenu
              label="Hand to"
              value={selectedAgent}
              agents={allAgents}
              disabled={disabled || !allAgents.length}
              disabledReason={disabled ? disabledReason : (!allAgents.length ? 'No coworkers available.' : undefined)}
              onChange={setHandoffAgent}
            />
          </div>
          <Button
            size="sm"
            variant="primary"
            leftIcon="user-round-check"
            disabled={disabled || !selectedAgent}
            disabledReason={disabledReason || (!selectedAgent ? 'Assign a coworker first.' : undefined)}
            onClick={() => void onHandToAgent(task, selectedAgent)}
          >
            Hand to {selectedAgent ? agentLabel(selectedAgent) : 'coworker'}
          </Button>
        </div>
      </section>
    </aside>
  )
}

export function ProjectsKanbanSurface({
  board,
  loading = false,
  error,
  disabled = false,
  disabledReason,
  agents = [],
  agentCatalogStatus = 'ready',
  agentCatalogMessage,
  platformLabel,
  projectStatusLabel = defaultProjectStatusLabel,
  onReload,
  onReloadAgents,
  onCreateProject,
  onPlanWithCleo,
  onMoveTask,
  onAssignTask,
  onOpenConversation,
  onOpenWork,
  onHandToAgent,
  className,
  ...props
}: ProjectsKanbanSurfaceProps) {
  const projects = useMemo(() => board?.projects || [], [board?.projects])
  const tasks = useMemo(() => board?.tasks || [], [board?.tasks])
  const [showArchived, setShowArchived] = useState(false)
  const activeProjects = useMemo(() => projects.filter((project) => project.status !== 'archived'), [projects])
  const archivedProjects = useMemo(() => projects.filter((project) => project.status === 'archived'), [projects])
  const isShowingArchived = showArchived && archivedProjects.length > 0
  const visibleProjects = isShowingArchived ? archivedProjects : activeProjects
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(projects[0]?.id || null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [showPlan, setShowPlan] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)

  useEffect(() => {
    if (showArchived && archivedProjects.length === 0) setShowArchived(false)
  }, [archivedProjects.length, showArchived])

  useEffect(() => {
    if (!visibleProjects.length) {
      setSelectedProjectId(null)
      return
    }
    setSelectedProjectId((current) => current && visibleProjects.some((project) => project.id === current) ? current : visibleProjects[0]?.id || null)
  }, [visibleProjects])

  const selectedProject = visibleProjects.find((project) => project.id === selectedProjectId) || visibleProjects[0] || null
  const projectTasks = useMemo(
    () => (selectedProject ? tasks.filter((task) => task.projectId === selectedProject.id) : []),
    [selectedProject, tasks],
  )

  // The task detail is a slide-in overlay, so it stays closed until a card is
  // opened; only drop a stale selection when its task leaves the active project.
  useEffect(() => {
    setSelectedTaskId((current) => current && projectTasks.some((task) => task.id === current) ? current : null)
  }, [projectTasks])

  const selectedTask = projectTasks.find((task) => task.id === selectedTaskId) || null
  const allAgents = useMemo(() => unique([...agents, ...projects.flatMap((project) => project.team), ...tasks.map((task) => task.assigneeAgent)]), [agents, projects, tasks])
  const byProject = useMemo(() => new Map(projects.map((project) => [project.id, tasks.filter((task) => task.projectId === project.id)])), [projects, tasks])
  const actionDisabledReason = disabled ? disabledReason : undefined

  const act = async (success: string, callback: () => Promise<unknown> | unknown) => {
    try {
      await callback()
      await onReload?.()
      setNotice({ tone: 'success', message: success })
      return true
    } catch (nextError) {
      setNotice({ tone: 'warning', message: noticeMessage(nextError) })
      return false
    }
  }

  const createProject = async (input: CoordinationProjectInput) => {
    const ok = await act('Project created', async () => {
      const created = await onCreateProject?.(input)
      const id = createdProjectId(created)
      if (id) setSelectedProjectId(id)
    })
    if (ok) setShowCreate(false)
    return ok
  }

  const planProject = async (project: CoordinationProject, input: Omit<CoordinationChiefOfStaffPlanInput, 'projectId'>) => {
    const ok = await act('Cleo added specced tasks to the board', async () => {
      await onPlanWithCleo?.(project.id, input)
    })
    if (ok) setShowPlan(false)
    return ok
  }

  const moveTask = async (task: CoordinationTask, column: CoordinationTaskColumn) => {
    if (task.column === column) return
    setSelectedTaskId(task.id)
    await act(`Moved to ${COLUMNS.find((entry) => entry.id === column)?.label || column}`, () => onMoveTask?.(task.id, { column }))
  }

  const assignTask = async (task: CoordinationTask, agent: string | null) => {
    setSelectedTaskId(task.id)
    await act(agent ? `Assigned to ${agentLabel(agent)}` : 'Task unassigned', () => onAssignTask?.(task.id, { assigneeAgent: agent }))
  }

  const handToAgent = async (task: CoordinationTask, agent: string) => {
    setSelectedTaskId(task.id)
    await act(`Handed to ${agentLabel(agent)}`, async () => {
      if (onHandToAgent) {
        await onHandToAgent(task, agent)
        return
      }
      await onAssignTask?.(task.id, { assigneeAgent: agent })
      if (task.column === 'backlog') await onMoveTask?.(task.id, { column: 'planning' })
    })
  }

  const openConversation = async (project: CoordinationProject) => {
    await act('Opening linked conversation', () => {
      if (!onOpenConversation) throw new Error('Opening conversations is not available here.')
      return onOpenConversation(project)
    })
  }

  const openWork = async (task: CoordinationTask) => {
    await act('Opening linked work', () => {
      if (!onOpenWork) throw new Error('Opening task work is not available here.')
      return onOpenWork(task)
    })
  }

  const dragStart = (event: DragEvent<HTMLElement>, task: CoordinationTask) => {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', task.id)
    setDraggedTaskId(task.id)
  }

  const dropTask = (event: DragEvent<HTMLElement>, column: CoordinationTaskColumn) => {
    event.preventDefault()
    const taskId = event.dataTransfer.getData('text/plain') || draggedTaskId
    setDraggedTaskId(null)
    const task = projectTasks.find((candidate) => candidate.id === taskId)
    if (task) void moveTask(task, column)
  }

  const renderTaskCard = (task: CoordinationTask) => {
    const runLabel = taskRunLabel(task)
    return (
      <button
        key={task.id}
        className="studio-kanban-task-button"
        type="button"
        draggable={!disabled}
        data-selected={selectedTaskId === task.id ? 'true' : undefined}
        onClick={() => setSelectedTaskId(task.id)}
        onDragStart={(event) => dragStart(event, task)}
        onDragEnd={() => setDraggedTaskId(null)}
      >
        <KanbanTaskCard
          task={{
            id: task.id,
            title: task.title,
            description: task.description || task.spec,
            priority: priority(task),
            assignee: task.assigneeAgent ? {
              name: agentLabel(task.assigneeAgent),
              initials: initials(agentLabel(task.assigneeAgent)),
              tone: toneForName(task.assigneeAgent),
              presence: task.status === 'running' ? { status: 'working', pulse: true } : 'available',
            } : undefined,
            run: runLabel ? { label: runLabel, live: task.status === 'running' } : undefined,
            meta: task.artifactRefs?.length ? `${task.artifactRefs.length} artifact(s)` : undefined,
          }}
          dragging={draggedTaskId === task.id}
        />
      </button>
    )
  }

  const boardColumns = selectedProject ? COLUMNS.map((column) => ({
    ...column,
    tasks: projectTasks.filter((task) => task.column === column.id),
  })) : []

  return (
    <section {...props} className={cn('studio-projects-surface', className)} data-platform={platformLabel || undefined}>
      <StudioPageHeader
        eyebrow={platformLabel}
        title="Projects"
        description="Turn objectives into coworker tasks, track progress, and return to linked chats when work is ready."
        actions={[
          { id: 'reload', children: 'Refresh', leftIcon: 'rotate-ccw', onClick: () => void onReload?.(), disabled: loading },
          { id: 'new', children: 'New project', leftIcon: 'plus', variant: 'primary', onClick: () => setShowCreate(true), disabled, disabledReason: actionDisabledReason },
        ]}
      />
      {error ? <p className="studio-project-notice" data-tone="warning">{error}</p> : null}
      {notice ? <p className="studio-project-notice" data-tone={notice.tone}>{notice.message}</p> : null}
      {archivedProjects.length > 0 ? (
        <div className="studio-stage-chips" role="group" aria-label="Project views">
          <button type="button" aria-pressed={!showArchived} data-active={!showArchived ? 'true' : undefined} onClick={() => setShowArchived(false)}>
            Active ({activeProjects.length})
          </button>
          <button type="button" aria-pressed={showArchived} data-active={showArchived ? 'true' : undefined} onClick={() => setShowArchived(true)}>
            Archived ({archivedProjects.length})
          </button>
        </div>
      ) : null}
      {showCreate ? (
        <ProjectCreateForm
          agents={agents}
          agentCatalogStatus={agentCatalogStatus}
          agentCatalogMessage={agentCatalogMessage}
          disabled={disabled || !onCreateProject}
          disabledReason={actionDisabledReason || (!onCreateProject ? 'Project creation is unavailable.' : undefined)}
          onReloadAgents={onReloadAgents}
          onSubmit={createProject}
          onCancel={() => setShowCreate(false)}
        />
      ) : null}
      {loading && !board ? (
        <EmptyState icon="loader-circle" title="Loading projects" body="Loading objectives, tasks, coworkers, and linked chats." />
      ) : error && !board ? (
        <EmptyState icon="kanban" title="Couldn’t load projects" body="Refresh to try loading the board again. Your saved projects have not been changed." />
      ) : !visibleProjects.length ? (
        <EmptyState
          icon="kanban"
          title={isShowingArchived ? 'No archived projects' : 'No projects yet'}
          body={isShowingArchived
            ? 'Projects you archive will stay available here for reference.'
            : 'Create a project, define its objective, then plan the first set of coworker tasks.'}
        />
      ) : (
        <div className="studio-projects-layout">
          <aside className="studio-projects-list" aria-label="Projects list">
            {visibleProjects.map((project) => {
              const projectTasksForCard = byProject.get(project.id) || []
              const stats = projectStats(projectTasksForCard)
              const cardAgents = unique([...project.team, ...projectTasksForCard.map((task) => task.assigneeAgent)])
              return (
                <ProjectCard
                  key={project.id}
                  title={project.title}
                  description={project.objective}
                  progress={stats.progress}
                  progressLabel={stats.label}
                  meta={<TeamAvatars agents={cardAgents} />}
                  status={{ label: projectStatusLabel(project.status), tone: project.status === 'completed' ? 'success' : project.status === 'paused' ? 'warning' : 'accent' }}
                  role="button"
                  tabIndex={0}
                  aria-pressed={selectedProject?.id === project.id}
                  data-selected={selectedProject?.id === project.id ? 'true' : undefined}
                  onClick={() => {
                    setSelectedProjectId(project.id)
                    setShowPlan(false)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      setSelectedProjectId(project.id)
                      setShowPlan(false)
                    }
                  }}
                />
              )
            })}
          </aside>
          <div className="studio-project-board">
            {selectedProject ? (
              <>
                <ProjectHeader
                  project={selectedProject}
                  tasks={projectTasks}
                  disabled={disabled || !onPlanWithCleo}
                  disabledReason={actionDisabledReason || (!onPlanWithCleo ? 'Cleo planning is unavailable.' : undefined)}
                  onOpenConversation={() => void openConversation(selectedProject)}
                  onShowPlan={() => setShowPlan((current) => !current)}
                />
                {showPlan ? (
                  <ProjectPlanForm
                    project={selectedProject}
                    agents={agents}
                    agentCatalogStatus={agentCatalogStatus}
                    agentCatalogMessage={agentCatalogMessage}
                    disabled={disabled || !onPlanWithCleo}
                    disabledReason={actionDisabledReason || (!onPlanWithCleo ? 'Cleo planning is unavailable.' : undefined)}
                    onReloadAgents={onReloadAgents}
                    onPlan={(input) => planProject(selectedProject, input)}
                  />
                ) : null}
                <div className="studio-project-board__main">
                  <section className="studio-kanban-board" aria-label={`${selectedProject.title} task board`}>
                    {boardColumns.map((column) => (
                      // Drag-and-drop drop target: HTML has no native "drop zone"
                      // element, so the column section observes dragover/drop. Task
                      // cards carry the interactive/keyboard semantics.
                      // (no-static-element-interactions is suppressed for this file in eslint.a11y.config.mjs.)
                      <section
                        key={column.id}
                        className="studio-kanban-column"
                        data-column={column.id}
                        onDragOver={(event) => {
                          event.preventDefault()
                          event.dataTransfer.dropEffect = 'move'
                        }}
                        onDrop={(event) => dropTask(event, column.id)}
                      >
                        <header className="studio-kanban-column__head">
                          <h3>{column.label}</h3>
                          <span>{column.tasks.length}</span>
                        </header>
                        <div className="studio-kanban-column__body">
                          {column.tasks.length ? column.tasks.map(renderTaskCard) : <p className="studio-kanban-column__empty">No tasks</p>}
                        </div>
                      </section>
                    ))}
                  </section>
                </div>
              </>
            ) : null}
          </div>
        </div>
      )}
      {selectedTask ? (
        <Dialog title="Task detail" variant="drawer" side="right" onClose={() => setSelectedTaskId(null)}>
          <TaskDrawer
            task={selectedTask}
            agents={allAgents}
            disabled={disabled}
            disabledReason={actionDisabledReason}
            onMove={moveTask}
            onAssign={assignTask}
            onOpenWork={openWork}
            onHandToAgent={handToAgent}
          />
        </Dialog>
      ) : null}
    </section>
  )
}
