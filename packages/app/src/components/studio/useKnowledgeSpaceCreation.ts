import { useCallback, useEffect, useRef, useState } from 'react'
import { knowledgeSpaceIdFromCreationId, type KnowledgeSpaceVisibility } from '@open-cowork/shared'
import {
  clearNewSpaceCreationProgress,
  persistNewSpaceCreationProgress,
  readNewSpaceCreationProgress,
  subscribeNewSpaceCreationCompletion,
  type NewSpaceCreationProgress,
} from './knowledge-space-creation-recovery'
import type { NewSpaceCreationResult } from './knowledge-space-creation-runner'

type UseKnowledgeSpaceCreationOptions = {
  workspaceId: string
  onComplete: (result: NewSpaceCreationResult) => void
  onPassiveComplete: () => void
}

export function useKnowledgeSpaceCreation({
  workspaceId,
  onComplete,
  onPassiveComplete,
}: UseKnowledgeSpaceCreationOptions) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [creation, setCreation] = useState<NewSpaceCreationProgress | null>(
    () => readNewSpaceCreationProgress(workspaceId),
  )
  const creationRef = useRef<NewSpaceCreationProgress | null>(creation)

  const persistProgress = useCallback((progress: NewSpaceCreationProgress | null) => {
    creationRef.current = progress
    setCreation(progress)
    persistNewSpaceCreationProgress(progress, workspaceId)
  }, [workspaceId])

  const clearProgress = useCallback((creationId: string) => {
    if (creationRef.current?.creationId === creationId) {
      creationRef.current = null
      setCreation(null)
    }
    clearNewSpaceCreationProgress(creationId, workspaceId)
  }, [workspaceId])

  useEffect(() => {
    creationRef.current = readNewSpaceCreationProgress(workspaceId)
    setCreation(creationRef.current)
    setOpen(false)
    setError(null)
  }, [workspaceId])

  useEffect(() => subscribeNewSpaceCreationCompletion((completedWorkspaceId, creationId) => {
    if (completedWorkspaceId !== workspaceId || creationRef.current?.creationId !== creationId) return
    creationRef.current = null
    setCreation(null)
    onPassiveComplete()
  }), [onPassiveComplete, workspaceId])

  const openDialog = useCallback(() => {
    setError(null)
    setOpen(true)
  }, [])

  const closeDialog = useCallback(() => setOpen(false), [])

  const submit = useCallback(async ({ name, visibility }: {
    name: string
    visibility: KnowledgeSpaceVisibility
  }) => {
    setBusy(true)
    setError(null)
    let joined = false
    try {
      // The transactional create/reconcile engine is only needed after submit;
      // keep it off the initial Knowledge route while recovery state and dialog
      // controls remain immediately available.
      const { runKnowledgeSpaceCreation } = await import('./knowledge-space-creation-runner')
      const creationRun = runKnowledgeSpaceCreation({
        workspaceId,
        spaceIdFromCreationId: knowledgeSpaceIdFromCreationId,
        existingProgress: creationRef.current,
        input: { name, visibility },
        persistProgress,
        clearProgress,
      })
      joined = creationRun.joined
      const result = await creationRun.promise
      clearProgress(creationRun.creationId)
      setOpen(false)
      onComplete(result)
    } catch (creationError) {
      if (joined) {
        const recovered = readNewSpaceCreationProgress(workspaceId)
        creationRef.current = recovered
        setCreation(recovered)
      }
      setError(creationError instanceof Error ? creationError.message : String(creationError))
    } finally {
      setBusy(false)
    }
  }, [clearProgress, onComplete, persistProgress, workspaceId])

  return {
    open,
    busy,
    error,
    creation,
    recoveryAvailable: Boolean(creation),
    openDialog,
    closeDialog,
    submit,
  }
}
