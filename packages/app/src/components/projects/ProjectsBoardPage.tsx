import { useCallback, useEffect, useRef, useState } from 'react'
import { ProjectsKanbanSurface } from '@open-cowork/ui'
import type { CoordinationBoardPayload, CoordinationProject, CoordinationTask } from '@open-cowork/shared'
import { toast } from '../ui/Toaster'
import { t } from '../../helpers/i18n'
import { recordFeatureValueActivation, recordFeatureValueDiscovery } from '../../helpers/feature-value-telemetry'
import { isDesktopRuntime } from '../../runtime-env'
import { supportAllows, supportEntry, useActiveWorkspaceSupport } from '../../stores/workspace-support'
import { RestrictedState } from '../RestrictedState'

type ProjectsBoardPageProps = {
  onOpenThread: (sessionId: string) => void
  featureValueDiscoveryEnabled?: boolean
}

function describeError(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'Projects board failed to load.'
}

function projectStatusLabel(status: CoordinationProject['status']) {
  if (status === 'active') return t('projects.status.active', 'Active')
  if (status === 'paused') return t('projects.status.paused', 'Paused')
  if (status === 'completed') return t('projects.status.completed', 'Completed')
  return t('projects.status.archived', 'Archived')
}

async function requireProjectMutation<T>(action: () => Promise<T>): Promise<T> {
  const result = await action()
  if (result === null || result === undefined) {
    throw new Error(t('projects.board.noMutation', 'The project action did not change anything. Refresh and try again.'))
  }
  return result
}

async function recordProjectMutation<T>(action: () => Promise<T>): Promise<T> {
  const result = await requireProjectMutation(action)
  recordFeatureValueActivation('projects')
  return result
}

export function ProjectsBoardPage({
  onOpenThread,
  featureValueDiscoveryEnabled = true,
}: ProjectsBoardPageProps) {
  const workspaceSupport = useActiveWorkspaceSupport()
  // Board maps to coordination.projects (+ tasks). No synthetic board support key.
  const coordinationEntry = supportEntry(workspaceSupport.support, 'coordination.projects')
    || supportEntry(workspaceSupport.support, 'coordination.tasks')
  const coordinationDeferred = Boolean(
    coordinationEntry
    && (coordinationEntry.status === 'deferred' || coordinationEntry.status === 'not_supported' || coordinationEntry.status === 'blocked_by_policy'),
  )
  // The Electron coordination IPC is Local-only. Cloud Web uses the same
  // component with its own workspace-scoped HTTP adapter and must remain usable.
  const coordinationLocalOnly = isDesktopRuntime() && !workspaceSupport.isLocal
  const coordinationRestricted = coordinationLocalOnly || coordinationDeferred
  const coordinationReason = coordinationEntry?.verdict?.reason
    || t('projects.board.deferredReason', 'The desktop Projects board requires an active Local workspace with coordination enabled.')
  const [boardState, setBoardState] = useState<{
    workspaceId: string | null
    payload: CoordinationBoardPayload | null
  }>({ workspaceId: null, payload: null })
  const [agentState, setAgentState] = useState<{
    workspaceId: string | null
    agents: string[]
    status: 'loading' | 'ready' | 'partial' | 'error'
  }>({ workspaceId: null, agents: [], status: 'loading' })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const loadSequenceRef = useRef(0)
  const agentLoadSequenceRef = useRef(0)
  const board = boardState.workspaceId === workspaceSupport.workspaceId ? boardState.payload : null
  const agents = agentState.workspaceId === workspaceSupport.workspaceId ? agentState.agents : []
  const agentCatalogStatus = agentState.workspaceId === workspaceSupport.workspaceId
    ? agentState.status
    : 'loading'
  const boardLoading = loading || boardState.workspaceId !== workspaceSupport.workspaceId

  // Seed project/team pickers from the same coworker sources as Team. API IDs stay
  // unchanged; this is a presentation-layer roster, not a second registry.
  const loadAgents = useCallback(async () => {
    const loadSequence = agentLoadSequenceRef.current + 1
    agentLoadSequenceRef.current = loadSequence
    const workspaceId = workspaceSupport.workspaceId
    if (coordinationRestricted) {
      setAgentState({ workspaceId, agents: [], status: 'ready' })
      return
    }
    setAgentState((current) => ({
      workspaceId,
      agents: current.workspaceId === workspaceId ? current.agents : [],
      status: 'loading',
    }))
    const [customResult, builtInResult, runtimeResult] = await Promise.allSettled([
      window.coworkApi.agents.list(),
      window.coworkApi.app.builtinAgents(),
      window.coworkApi.agents.runtime(),
    ] as const)
    if (agentLoadSequenceRef.current !== loadSequence) return
    const custom = customResult.status === 'fulfilled' ? customResult.value : []
    const builtIn = builtInResult.status === 'fulfilled' ? builtInResult.value : []
    const runtime = runtimeResult.status === 'fulfilled' ? runtimeResult.value : []
    const failures = [customResult, builtInResult, runtimeResult]
      .filter((result) => result.status === 'rejected').length
    const availableAgents = [...new Set([
      ...custom.filter((agent) => agent.enabled !== false && agent.valid !== false).map((agent) => agent.name),
      ...builtIn.filter((agent) => !agent.disabled && !agent.hidden).map((agent) => agent.name),
      ...runtime.filter((agent) => !agent.disabled).map((agent) => agent.name),
    ])].sort((left, right) => left.localeCompare(right))
    setAgentState((current) => ({
      workspaceId,
      agents: failures === 3
        ? []
        : [...new Set([
            ...(failures > 0 && current.workspaceId === workspaceId ? current.agents : []),
            ...availableAgents,
          ])].sort((left, right) => left.localeCompare(right)),
      status: failures === 3 ? 'error' : failures > 0 ? 'partial' : 'ready',
    }))
  }, [coordinationRestricted, workspaceSupport.workspaceId])

  useEffect(() => {
    void loadAgents()
  }, [loadAgents])

  const loadBoard = useCallback(async () => {
    const loadSequence = loadSequenceRef.current + 1
    loadSequenceRef.current = loadSequence
    const workspaceId = workspaceSupport.workspaceId
    if (coordinationRestricted) {
      setBoardState({ workspaceId, payload: null })
      setLoading(false)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const nextBoard = await window.coworkApi.coordination.board()
      if (loadSequenceRef.current !== loadSequence) return
      setBoardState({ workspaceId, payload: nextBoard })
      if (featureValueDiscoveryEnabled) recordFeatureValueDiscovery('projects')
    } catch (nextError) {
      if (loadSequenceRef.current !== loadSequence) return
      setBoardState((current) => current.workspaceId === workspaceId
        ? current
        : { workspaceId, payload: null })
      setError(describeError(nextError))
    } finally {
      if (loadSequenceRef.current === loadSequence) setLoading(false)
    }
  }, [coordinationRestricted, featureValueDiscoveryEnabled, workspaceSupport.workspaceId])

  useEffect(() => {
    void loadBoard()
  }, [loadBoard])

  useEffect(() => {
    if (coordinationRestricted) return
    return window.coworkApi.on.coordinationUpdated(() => {
      void loadBoard()
    })
  }, [coordinationRestricted, loadBoard])

  // These run inside the kanban surface's act() wrapper, which reports success
  // unless the callback throws. So we toast on the app's standard channel and
  // re-throw, letting the surface keep its own failure notice instead of falsely
  // flashing "opened". The missing-link cases are an expected neutral warning;
  // unexpected IPC faults are an error.
  const openConversation = useCallback((project: CoordinationProject) => {
    if (!project.sourceSessionId) {
      toast({ tone: 'warning', message: t('projects.board.noLinkedConversation', 'This project does not have a linked conversation yet.') })
      throw new Error('This project does not have a linked conversation yet.')
    }
    onOpenThread(project.sourceSessionId)
  }, [onOpenThread])

  const openWork = useCallback(async (task: CoordinationTask) => {
    let session: Awaited<ReturnType<typeof window.coworkApi.coordination.taskWorkTarget>>
    try {
      session = await window.coworkApi.coordination.taskWorkTarget(task.id)
    } catch (actionError) {
      toast({ tone: 'error', message: t('projects.board.openWorkFailed', 'Could not open this task’s work: {{message}}', { message: describeError(actionError) }) })
      throw actionError
    }
    if (!session?.id) {
      toast({ tone: 'warning', message: t('projects.board.noLinkedWork', 'This task does not have linked OpenCode work yet.') })
      throw new Error('This task does not have linked OpenCode work yet.')
    }
    onOpenThread(session.id)
  }, [onOpenThread])

  // Move/assign/hand-off/create/plan flow through the kanban surface's act()
  // wrapper, which already shows an in-board notice on failure, so they are left
  // to propagate there rather than double-surfacing a toast.
  const handToAgent = useCallback(async (task: CoordinationTask, agentName: string) => {
    await requireProjectMutation(() => window.coworkApi.coordination.assignTask(task.id, { assigneeAgent: agentName }))
    if (task.column === 'backlog') {
      await requireProjectMutation(() => window.coworkApi.coordination.moveTask(task.id, { column: 'planning' }))
    }
    recordFeatureValueActivation('projects')
  }, [])

  if (coordinationRestricted) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <RestrictedState
          icon="kanban"
          title={t('projects.board.deferredTitle', 'Projects board unavailable here')}
          body={t(
            'projects.board.deferredBody',
            'Switch to Local to plan objectives and tasks. Cloud, Paired, and Gateway project boards stay unavailable until their APIs are workspace-scoped.',
          )}
          reason={coordinationReason}
        />
      </div>
    )
  }

  const mutationsAllowed = !coordinationEntry || supportAllows(coordinationEntry, { mutation: true })

  return (
    <ProjectsKanbanSurface
      board={board}
      loading={boardLoading}
      error={error}
      agents={agents}
      agentCatalogStatus={agentCatalogStatus}
      agentCatalogMessage={agentCatalogStatus === 'partial'
        ? t('projects.roster.partial', 'Some coworkers could not be loaded. Available coworkers are still shown.')
        : agentCatalogStatus === 'error'
          ? t('projects.roster.error', 'Couldn’t load coworkers. Retry the roster before assigning a team.')
          : undefined}
      platformLabel={workspaceSupport.isLocal
        ? t('projects.board.localWorkspace', 'Local workspace')
        : t('projects.board.cloudWorkspace', 'Cloud workspace')}
      projectStatusLabel={projectStatusLabel}
      disabled={!mutationsAllowed}
      disabledReason={mutationsAllowed ? undefined : coordinationReason}
      onReload={loadBoard}
      onReloadAgents={loadAgents}
      onCreateProject={(input) => recordProjectMutation(() => window.coworkApi.coordination.createProject(input))}
      onPlanWithCleo={(projectId, input) => recordProjectMutation(() => window.coworkApi.coordination.planWithCleo(projectId, input))}
      onMoveTask={(taskId, input) => recordProjectMutation(() => window.coworkApi.coordination.moveTask(taskId, input))}
      onAssignTask={(taskId, input) => recordProjectMutation(() => window.coworkApi.coordination.assignTask(taskId, input))}
      onOpenConversation={openConversation}
      onOpenWork={openWork}
      onHandToAgent={handToAgent}
    />
  )
}
