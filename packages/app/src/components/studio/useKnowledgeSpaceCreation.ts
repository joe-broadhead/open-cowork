import { useCallback, useEffect, useRef, useState } from 'react'
import {
  knowledgeSpaceIdFromCreationId,
  type KnowledgeSnapshotPayload,
  type KnowledgeSpaceVisibility,
} from '@open-cowork/shared'
import { recordFeatureValueActivation } from '../../helpers/feature-value-telemetry'
import {
  clearNewSpaceCreationProgress,
  persistNewSpaceCreationProgress,
  readNewSpaceCreationProgress,
  runNewSpaceCreationSingleFlight,
  subscribeNewSpaceCreationCompletion,
  type NewSpaceCreationProgress,
} from './knowledge-space-creation-recovery'

const NEW_SPACE_OVERVIEW_TITLE = 'Overview'

type NewSpaceCreationResult = {
  pageId: string
  snapshot?: KnowledgeSnapshotPayload
}

type UseKnowledgeSpaceCreationOptions = {
  workspaceId: string
  onComplete: (result: NewSpaceCreationResult) => void
  onPassiveComplete: () => void
}

function reconcileNewSpaceCreation(
  progress: NewSpaceCreationProgress,
  next: KnowledgeSnapshotPayload,
) {
  progress.spaceId = undefined
  progress.proposalId = undefined
  progress.pageId = undefined
  const expectedSpaceId = knowledgeSpaceIdFromCreationId(progress.creationId)
  if (next.spaces.some((space) => space.id === expectedSpaceId)) progress.spaceId = expectedSpaceId
  if (!progress.spaceId) return

  const page = next.pages.find((candidate) => (
    candidate.spaceId === progress.spaceId
    && candidate.title === NEW_SPACE_OVERVIEW_TITLE
  ))
  if (page) {
    progress.pageId = page.id
    return
  }

  progress.proposalId = next.proposals.find((proposal) => (
    proposal.spaceId === progress.spaceId
    && proposal.pageTitle === NEW_SPACE_OVERVIEW_TITLE
    && proposal.status === 'pending'
  ))?.id
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
    const existingProgress = creationRef.current
    let progress: NewSpaceCreationProgress
    if (!existingProgress || existingProgress.workspaceId !== workspaceId) {
      progress = {
        workspaceId,
        creationId: crypto.randomUUID(),
        name,
        visibility,
      }
      persistProgress(progress)
    } else {
      progress = existingProgress
    }

    const reconcile = async () => {
      const next = await window.coworkApi.knowledge.snapshot({
        workspaceId,
        spaceId: knowledgeSpaceIdFromCreationId(progress.creationId),
      })
      reconcileNewSpaceCreation(progress, next)
      persistProgress(progress)
      return next
    }

    const commitStage = async <T,>(
      stage: NonNullable<NewSpaceCreationProgress['uncertainStage']>,
      write: () => Promise<T>,
      apply: (result: T) => void,
      committed: () => boolean,
    ) => {
      progress.uncertainStage = stage
      persistProgress(progress)
      try {
        apply(await write())
        progress.uncertainStage = undefined
        persistProgress(progress)
      } catch (writeError) {
        try {
          await reconcile()
        } catch {
          throw writeError
        }
        if (!committed()) {
          progress.uncertainStage = undefined
          if (stage === 'space') clearProgress(progress.creationId)
          else persistProgress(progress)
          throw writeError
        }
        progress.uncertainStage = undefined
        persistProgress(progress)
      }
    }

    const creationRun = runNewSpaceCreationSingleFlight(progress.creationId, async () => {
      if (progress.needsReconciliation || progress.uncertainStage) {
        await reconcile()
        progress.needsReconciliation = undefined
        progress.uncertainStage = undefined
        persistProgress(progress)
      }
      if (!progress.spaceId) {
        await commitStage(
          'space',
          () => window.coworkApi.knowledge.createSpace({
            workspaceId,
            creationId: progress.creationId,
            name: progress.name,
            visibility: progress.visibility,
          }),
          (space) => { progress.spaceId = space.id },
          () => Boolean(progress.spaceId),
        )
      }
      if (!progress.proposalId && !progress.pageId) {
        await commitStage(
          'proposal',
          () => window.coworkApi.knowledge.propose({
            workspaceId,
            spaceId: progress.spaceId!,
            pageTitle: NEW_SPACE_OVERVIEW_TITLE,
            summary: `Create the first page for ${progress.name}.`,
            links: [],
            body: [{
              id: 'overview-intro',
              type: 'p',
              text: `Use this page to capture reviewed context for ${progress.name}.`,
            }],
          }),
          (proposal) => { progress.proposalId = proposal.id },
          () => Boolean(progress.proposalId || progress.pageId),
        )
      }
      if (!progress.pageId && progress.proposalId) {
        await commitStage(
          'accept',
          () => window.coworkApi.knowledge.acceptProposal(progress.proposalId!, { workspaceId }),
          (published) => { progress.pageId = published.page.id },
          () => Boolean(progress.pageId),
        )
      }
      if (!progress.pageId) throw new Error('The Overview page could not be created.')

      recordFeatureValueActivation('knowledge')
      try {
        return {
          pageId: progress.pageId,
          snapshot: await window.coworkApi.knowledge.snapshot({ workspaceId }),
        }
      } catch {
        return { pageId: progress.pageId }
      }
    })

    try {
      const result = await creationRun.promise
      clearProgress(progress.creationId)
      setOpen(false)
      onComplete(result)
    } catch (creationError) {
      if (creationRun.joined) {
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
