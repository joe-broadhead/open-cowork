import type { KnowledgeSnapshotPayload, KnowledgeSpaceVisibility } from '@open-cowork/shared'
import { recordFeatureValueActivation } from '../../helpers/feature-value-telemetry'
import type { NewSpaceCreationProgress } from './knowledge-space-creation-recovery'

const NEW_SPACE_OVERVIEW_TITLE = 'Overview'
const activeCreationRuns = new Map<string, Promise<unknown>>()

export type NewSpaceCreationResult = {
  pageId: string
  snapshot?: KnowledgeSnapshotPayload
}

type RunKnowledgeSpaceCreationOptions = {
  workspaceId: string
  spaceIdFromCreationId: (creationId: string) => string
  existingProgress: NewSpaceCreationProgress | null
  input: {
    name: string
    visibility: KnowledgeSpaceVisibility
  }
  persistProgress: (progress: NewSpaceCreationProgress) => void
  clearProgress: (creationId: string) => void
}

function reconcileNewSpaceCreation(
  progress: NewSpaceCreationProgress,
  next: KnowledgeSnapshotPayload,
  expectedSpaceId: string,
) {
  progress.spaceId = undefined
  progress.proposalId = undefined
  progress.pageId = undefined
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

export function runNewSpaceCreationSingleFlight<T>(creationId: string, run: () => Promise<T>): {
  joined: boolean
  promise: Promise<T>
} {
  const existing = activeCreationRuns.get(creationId) as Promise<T> | undefined
  if (existing) return { joined: true, promise: existing }

  let promise: Promise<T>
  promise = Promise.resolve()
    .then(run)
    .finally(() => {
      if (activeCreationRuns.get(creationId) === promise) activeCreationRuns.delete(creationId)
    })
  activeCreationRuns.set(creationId, promise)
  return { joined: false, promise }
}

export function runKnowledgeSpaceCreation({
  workspaceId,
  spaceIdFromCreationId,
  existingProgress,
  input,
  persistProgress,
  clearProgress,
}: RunKnowledgeSpaceCreationOptions): {
  creationId: string
  joined: boolean
  promise: Promise<NewSpaceCreationResult>
} {
  const progress: NewSpaceCreationProgress = existingProgress?.workspaceId === workspaceId
    ? existingProgress
    : {
        workspaceId,
        creationId: crypto.randomUUID(),
        name: input.name,
        visibility: input.visibility,
      }
  if (progress !== existingProgress) persistProgress(progress)
  const expectedSpaceId = spaceIdFromCreationId(progress.creationId)

  const reconcile = async () => {
    const next = await window.coworkApi.knowledge.snapshot({
      workspaceId,
      spaceId: expectedSpaceId,
    })
    reconcileNewSpaceCreation(progress, next, expectedSpaceId)
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

  const run = runNewSpaceCreationSingleFlight(progress.creationId, async () => {
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
  return { creationId: progress.creationId, ...run }
}
