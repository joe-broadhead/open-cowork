import { useCallback, useEffect, useState } from 'react'
import { ProjectsKanbanSurface } from '@open-cowork/ui'
import type { CoordinationBoardPayload, CoordinationProject, CoordinationTask } from '@open-cowork/shared'
import { toast } from '../ui'
import { t } from '../../helpers/i18n'

type ProjectsBoardPageProps = {
  onOpenThread: (sessionId: string) => void
}

function describeError(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'Projects board failed to load.'
}

export function ProjectsBoardPage({ onOpenThread }: ProjectsBoardPageProps) {
  const [board, setBoard] = useState<CoordinationBoardPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadBoard = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setBoard(await window.coworkApi.coordination.board())
    } catch (nextError) {
      setError(describeError(nextError))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadBoard()
  }, [loadBoard])

  useEffect(() => {
    return window.coworkApi.on.coordinationUpdated(() => {
      void loadBoard()
    })
  }, [loadBoard])

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
    await window.coworkApi.coordination.assignTask(task.id, { assigneeAgent: agentName })
    if (task.column === 'backlog') {
      await window.coworkApi.coordination.moveTask(task.id, { column: 'planning' })
    }
  }, [])

  return (
    <ProjectsKanbanSurface
      board={board}
      loading={loading}
      error={error}
      platformLabel="Desktop"
      onReload={loadBoard}
      onCreateProject={(input) => window.coworkApi.coordination.createProject(input)}
      onPlanWithCleo={(projectId, input) => window.coworkApi.coordination.planWithCleo(projectId, input)}
      onMoveTask={(taskId, input) => window.coworkApi.coordination.moveTask(taskId, input)}
      onAssignTask={(taskId, input) => window.coworkApi.coordination.assignTask(taskId, input)}
      onOpenConversation={openConversation}
      onOpenWork={openWork}
      onHandToAgent={handToAgent}
    />
  )
}
