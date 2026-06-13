import { createElement, useCallback, useEffect, useMemo, useState } from 'react'
import {
  resolveConversationTaskContext,
  type ConversationTaskContext,
  type CoordinationBoardPayload,
} from '@open-cowork/shared'

export const CLOUD_DELIVERABLE_APPROVAL_COPY = 'Nothing ships until you approve.'

type CloudConversationContextApi = {
  coordination: {
    board: () => Promise<unknown>
  }
  workspace: {
    events: (handlers: { message?: () => void }) => { close: () => void }
  }
}

export function useCloudConversationTaskContext(
  api: CloudConversationContextApi,
  selectedSessionId: string | null,
) {
  const [coordinationBoard, setCoordinationBoard] = useState<CoordinationBoardPayload | null>(null)
  const loadCoordinationBoard = useCallback(async () => {
    try {
      setCoordinationBoard(await api.coordination.board() as CoordinationBoardPayload)
    } catch {
      setCoordinationBoard(null)
    }
  }, [api])

  useEffect(() => {
    void loadCoordinationBoard()
  }, [loadCoordinationBoard])

  useEffect(() => {
    try {
      const stream = api.workspace.events({ message: () => { void loadCoordinationBoard() } })
      return () => stream.close()
    } catch {
      return undefined
    }
  }, [api, loadCoordinationBoard])

  return useMemo(
    () => resolveConversationTaskContext(coordinationBoard, selectedSessionId),
    [coordinationBoard, selectedSessionId],
  )
}

export function CloudConversationMeta({
  summary,
  taskContext,
  onOpenBoard,
}: {
  summary: string
  taskContext?: ConversationTaskContext | null
  onOpenBoard?: () => void
}) {
  if (!taskContext) {
    return createElement('span', { className: 'cloud-conversation-meta__summary' }, summary)
  }
  return createElement(
    'span',
    { className: 'cloud-conversation-meta' },
    createElement(
      'span',
      {
        'aria-label': `Project ${taskContext.projectTitle}, task ${taskContext.taskTitle}`,
        className: 'cloud-conversation-meta__context',
      },
      createElement('span', null, taskContext.projectTitle),
      createElement('span', null, taskContext.taskTitle),
    ),
    createElement('span', { className: 'cloud-conversation-meta__summary' }, summary),
    onOpenBoard
      ? createElement('button', {
        className: 'ghost cloud-conversation-meta__board',
        onClick: onOpenBoard,
        type: 'button',
      }, 'Open board')
      : null,
  )
}
