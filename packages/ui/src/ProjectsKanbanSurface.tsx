import {
  type ChangeEvent,
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
import { EmptyState } from './EmptyState.js'
import {
  CoworkerAvatar,
  KanbanTaskCard,
  ProjectCard,
  RunTimeline,
  StudioPageHeader,
  type KanbanPriority,
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

export type ProjectsKanbanSurfaceProps = Omit<ComponentPropsWithoutRef<'section'>, 'onError'> & {
  board: CoordinationBoardPayload | null
  loading?: boolean
  error?: string | null
  disabled?: boolean
  disabledReason?: string
  agents?: string[]
  platformLabel?: string
  onReload?: () => Promise<void> | void
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
  return name
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ') || name
}

function csv(value: string) {
  return value.split(',').map((entry) => entry.trim()).filter(Boolean)
}

function unique(values: Array<string | null | undefined>) {
  return [...new Set(values.map((value) => text(value)).filter(Boolean))]
}

function priority(task: CoordinationTask): KanbanPriority {
  if (task.priority === 'high') return 'high'
  if (task.priority === 'low') return 'low'
  return 'medium'
}

function taskRunLabel(task: CoordinationTask) {
  if (task.status === 'running') return 'running'
  if (task.assignedSessionId) return 'linked'
  if (task.status === 'completed' || task.column === 'done') return 'done'
  if (task.column === 'review') return 'review'
  return null
}

function timelineForTask(task: CoordinationTask) {
  if (task.column === 'done' || task.status === 'completed') {
    return {
      stateLabel: task.status === 'completed' ? 'Completed, waiting for acceptance' : 'Done',
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
  if (task.status === 'blocked' || task.status === 'failed') {
    return {
      stateLabel: task.status === 'blocked' ? 'Blocked' : 'Failed',
      currentStepId: 'running',
      completedStepIds: ['queued'],
      live: false,
    }
  }
  return {
    stateLabel: 'Queued',
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
          initials={initials(agent)}
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
  disabled,
  disabledReason,
  onSubmit,
  onCancel,
}: {
  disabled: boolean
  disabledReason?: string
  onSubmit: (input: CoordinationProjectInput) => Promise<boolean>
  onCancel: () => void
}) {
  const [title, setTitle] = useState('')
  const [objective, setObjective] = useState('')
  const [description, setDescription] = useState('')
  const [team, setTeam] = useState('cleo')
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
        team: csv(team),
      })
      if (!created) return
      setTitle('')
      setObjective('')
      setDescription('')
      setTeam('cleo')
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
        <label>
          <span>Team</span>
          <input value={team} onChange={(event) => setTeam(event.currentTarget.value)} disabled={disabled || submitting} placeholder="cleo, engineer, reviewer" />
        </label>
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
  disabled,
  disabledReason,
  onPlan,
}: {
  project: CoordinationProject
  agents: string[]
  disabled: boolean
  disabledReason?: string
  onPlan: (input: Omit<CoordinationChiefOfStaffPlanInput, 'projectId'>) => Promise<boolean>
}) {
  const [objective, setObjective] = useState(project.objective)
  const [team, setTeam] = useState(project.team.join(', ') || agents.join(', '))
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    setObjective(project.objective)
    setTeam(project.team.join(', ') || agents.join(', '))
  }, [agents, project.id, project.objective, project.team])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (disabled || submitting) return
    setSubmitting(true)
    try {
      await onPlan({
        objective: objective.trim() || project.objective,
        assigneeAgents: csv(team),
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
      <label>
        <span>Coworkers</span>
        <input value={team} onChange={(event) => setTeam(event.currentTarget.value)} disabled={disabled || submitting} />
      </label>
      <Button type="submit" size="sm" variant="primary" leftIcon="sparkles" disabled={disabled || submitting} disabledReason={disabledReason}>
        Plan with Cleo
      </Button>
    </form>
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
            <span><i style={{ '--studio-progress': `${stats.progress}%` } as CSSProperties} /></span>
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
  const allAgents = unique([task.assigneeAgent, ...agents])
  const selectedAgent = handoffAgent || task.assigneeAgent || allAgents[0] || ''

  const assign = async (event: ChangeEvent<HTMLSelectElement>) => {
    await onAssign(task, event.currentTarget.value || null)
  }

  return (
    <aside className="studio-task-drawer" aria-label="Task detail">
      <header className="studio-task-drawer__header">
        <div>
          <Badge tone={task.status === 'running' ? 'accent' : task.column === 'done' ? 'success' : 'neutral'}>{task.status}</Badge>
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
        sessionId={task.assignedSessionId || undefined}
      />
      <section className="studio-task-drawer__section">
        <h3>Assignee</h3>
        <label className="studio-select-row">
          <span>Coworker</span>
          <select value={task.assigneeAgent || ''} onChange={(event) => void assign(event)} disabled={disabled} title={disabled ? disabledReason : undefined}>
            <option value="">Unassigned</option>
            {allAgents.map((agent) => <option key={agent} value={agent}>{agentLabel(agent)}</option>)}
          </select>
        </label>
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
          <label className="studio-hand-to">
            <span>Hand to</span>
            <select value={selectedAgent} onChange={(event) => setHandoffAgent(event.currentTarget.value)} disabled={disabled || !allAgents.length} title={disabled ? disabledReason : undefined}>
              {allAgents.length ? allAgents.map((agent) => <option key={agent} value={agent}>{agentLabel(agent)}</option>) : <option value="">No coworkers</option>}
            </select>
          </label>
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
  platformLabel,
  onReload,
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
  const projects = board?.projects || []
  const tasks = board?.tasks || []
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(projects[0]?.id || null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [showPlan, setShowPlan] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)

  useEffect(() => {
    if (!projects.length) {
      setSelectedProjectId(null)
      return
    }
    setSelectedProjectId((current) => current && projects.some((project) => project.id === current) ? current : projects[0]?.id || null)
  }, [projects])

  const selectedProject = projects.find((project) => project.id === selectedProjectId) || projects[0] || null
  const projectTasks = selectedProject ? tasks.filter((task) => task.projectId === selectedProject.id) : []

  useEffect(() => {
    setSelectedTaskId((current) => current && projectTasks.some((task) => task.id === current) ? current : projectTasks[0]?.id || null)
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
              initials: initials(task.assigneeAgent),
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

  if (loading && !board) {
    return (
      <section {...props} className={cn('studio-projects-surface', className)}>
        <EmptyState icon="loader-circle" title="Loading projects" body="Hydrating project objectives, task state, and linked OpenCode work." />
      </section>
    )
  }

  return (
    <section {...props} className={cn('studio-projects-surface', className)} data-platform={platformLabel || undefined}>
      <StudioPageHeader
        eyebrow={platformLabel}
        title="Projects"
        description="Turn objectives into planned coworker work, track progress, and open the linked OpenCode sessions when execution exists."
        actions={[
          { id: 'reload', children: 'Refresh', leftIcon: 'rotate-ccw', onClick: () => void onReload?.(), disabled: loading },
          { id: 'new', children: 'New project', leftIcon: 'plus', variant: 'primary', onClick: () => setShowCreate(true), disabled, disabledReason: actionDisabledReason },
        ]}
      />
      {error ? <p className="studio-project-notice" data-tone="warning">{error}</p> : null}
      {notice ? <p className="studio-project-notice" data-tone={notice.tone}>{notice.message}</p> : null}
      {showCreate ? (
        <ProjectCreateForm
          disabled={disabled || !onCreateProject}
          disabledReason={actionDisabledReason || (!onCreateProject ? 'Project creation is unavailable.' : undefined)}
          onSubmit={createProject}
          onCancel={() => setShowCreate(false)}
        />
      ) : null}
      {!projects.length ? (
        <EmptyState
          icon="kanban"
          title="No projects yet"
          body="Create a project, define the objective, then ask Cleo to plan the first set of tasks."
          action={onCreateProject ? (
            <Button size="sm" variant="primary" leftIcon="plus" onClick={() => setShowCreate(true)} disabled={disabled} disabledReason={actionDisabledReason}>
              New project
            </Button>
          ) : undefined}
        />
      ) : (
        <div className="studio-projects-layout">
          <aside className="studio-projects-list" aria-label="Projects list">
            {projects.map((project) => {
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
                  status={{ label: project.status, tone: project.status === 'completed' ? 'success' : project.status === 'paused' ? 'warning' : 'accent' }}
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
                    agents={allAgents}
                    disabled={disabled || !onPlanWithCleo}
                    disabledReason={actionDisabledReason || (!onPlanWithCleo ? 'Cleo planning is unavailable.' : undefined)}
                    onPlan={(input) => planProject(selectedProject, input)}
                  />
                ) : null}
                <div className="studio-project-board__main">
                  <section className="studio-kanban-board" aria-label={`${selectedProject.title} task board`}>
                    {boardColumns.map((column) => (
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
                </div>
              </>
            ) : null}
          </div>
        </div>
      )}
    </section>
  )
}
