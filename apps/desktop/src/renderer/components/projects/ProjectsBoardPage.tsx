import { useCallback, useEffect, useState } from 'react'
import { ProjectsKanbanSurface } from '@open-cowork/ui'
import type { CoordinationBoardPayload, CoordinationProject, CoordinationTask } from '@open-cowork/shared'

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

  const openConversation = useCallback((project: CoordinationProject) => {
    if (!project.sourceSessionId) {
      throw new Error('This project does not have a linked conversation yet.')
    }
    onOpenThread(project.sourceSessionId)
  }, [onOpenThread])

  const openWork = useCallback(async (task: CoordinationTask) => {
    const session = await window.coworkApi.coordination.taskWorkTarget(task.id)
    if (!session?.id) {
      throw new Error('This task does not have linked OpenCode work yet.')
    }
    onOpenThread(session.id)
  }, [onOpenThread])

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
