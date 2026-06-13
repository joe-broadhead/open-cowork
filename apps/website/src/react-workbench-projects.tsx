import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { ProjectsKanbanSurface } from '@open-cowork/ui'
import { useAppApi } from '@open-cowork/ui/app-api'
import type { CoordinationBoardPayload, CoordinationProject, CoordinationTask } from '@open-cowork/shared'
import type { CloudWebClientBootstrap } from './client-contract.ts'
import { asRecord, errorMessage, setRouteHash } from './react-workbench-controller.ts'

function text(value: unknown, fallback = '') {
  return String(value ?? fallback)
}

export function CloudProjectBoardPortal({
  target,
  bootstrap,
  agents,
  onSelectSession,
}: {
  target: HTMLElement | null
  bootstrap: CloudWebClientBootstrap
  agents: string[]
  onSelectSession: (sessionId: string) => Promise<void>
}) {
  const api = useAppApi()
  const [board, setBoard] = useState<CoordinationBoardPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const actionsDisabled = bootstrap.features.chat === false

  const loadBoard = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setBoard(await api.coordination.board() as CoordinationBoardPayload)
    } catch (nextError) {
      setError(errorMessage(nextError))
      setBoard(null)
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    void loadBoard()
  }, [loadBoard])

  useEffect(() => {
    try {
      const stream = api.workspace.events({ message: () => { void loadBoard() } })
      return () => stream.close()
    } catch {
      return undefined
    }
  }, [api, loadBoard])

  const agentNames = useMemo(() => agents, [agents])
  if (!target) return null

  return createPortal(
    <ProjectsKanbanSurface
      board={board}
      loading={loading}
      error={error}
      platformLabel="Cloud Web"
      disabled={actionsDisabled}
      disabledReason={actionsDisabled ? 'Project actions are disabled by this cloud profile.' : undefined}
      agents={agentNames}
      onReload={loadBoard}
      onCreateProject={(input) => api.coordination.createProject(input)}
      onPlanWithCleo={(projectId, input) => api.coordination.planWithCleo(projectId, input)}
      onMoveTask={(taskId, input) => api.coordination.moveTask(taskId, input)}
      onAssignTask={(taskId, input) => api.coordination.assignTask(taskId, input)}
      onOpenConversation={async (project: CoordinationProject) => {
        if (!project.sourceSessionId) throw new Error('This project does not have a linked cloud conversation yet.')
        setRouteHash('chat')
        await onSelectSession(project.sourceSessionId)
      }}
      onOpenWork={async (task: CoordinationTask) => {
        const session = asRecord(await api.coordination.taskWorkTarget(task.id))
        const sessionId = text(session.id)
        if (!sessionId) throw new Error('This task does not have linked cloud work yet.')
        setRouteHash('chat')
        await onSelectSession(sessionId)
      }}
      onHandToAgent={async (task: CoordinationTask, agentName: string) => {
        await api.coordination.assignTask(task.id, { assigneeAgent: agentName })
        if (task.column === 'backlog') await api.coordination.moveTask(task.id, { column: 'planning' })
      }}
    />,
    target,
  )
}
