import {
  isKnowledgeSpaceVisibility,
  knowledgeSpaceIdFromCreationId,
  type KnowledgeSpaceVisibility,
} from '@open-cowork/shared'

export type NewSpaceCreationProgress = {
  workspaceId: string
  creationId: string
  name: string
  visibility: KnowledgeSpaceVisibility
  spaceId?: string
  proposalId?: string
  pageId?: string
  uncertainStage?: 'space' | 'proposal' | 'accept'
  needsReconciliation?: true
}

const STORAGE_KEY_PREFIX = 'open-cowork.knowledge.new-space.v1.'
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const completionListeners = new Set<(workspaceId: string, creationId: string) => void>()

function publishCompletion(workspaceId: string, creationId: string) {
  for (const listener of completionListeners) {
    try {
      listener(workspaceId, creationId)
    } catch {
      // A stale subscriber cannot turn a committed Space into a failed operation.
    }
  }
}

function storageKey(workspaceId: string) {
  return `${STORAGE_KEY_PREFIX}${encodeURIComponent(workspaceId)}`
}

function optionalId(value: unknown): string | undefined | false {
  if (value === undefined) return undefined
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= 512
    ? value
    : false
}

function parseProgress(value: unknown, workspaceId: string): NewSpaceCreationProgress | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  const spaceId = optionalId(candidate.spaceId)
  const proposalId = optionalId(candidate.proposalId)
  const pageId = optionalId(candidate.pageId)
  const uncertainStage = candidate.uncertainStage
  if (
    candidate.workspaceId !== workspaceId
    || typeof candidate.creationId !== 'string'
    || !UUID_V4_PATTERN.test(candidate.creationId)
    || typeof candidate.name !== 'string'
    || !candidate.name.trim()
    || candidate.name.length > 240
    || !isKnowledgeSpaceVisibility(candidate.visibility)
    || spaceId === false
    || (spaceId !== undefined && spaceId !== knowledgeSpaceIdFromCreationId(candidate.creationId))
    || proposalId === false
    || pageId === false
    || (uncertainStage !== undefined && uncertainStage !== 'space' && uncertainStage !== 'proposal' && uncertainStage !== 'accept')
  ) return null

  return {
    workspaceId,
    creationId: candidate.creationId,
    name: candidate.name,
    visibility: candidate.visibility,
    ...(spaceId ? { spaceId } : {}),
    ...(proposalId ? { proposalId } : {}),
    ...(pageId ? { pageId } : {}),
    ...(uncertainStage ? { uncertainStage } : {}),
    needsReconciliation: true,
  }
}

export function readNewSpaceCreationProgress(workspaceId: string): NewSpaceCreationProgress | null {
  const key = storageKey(workspaceId)
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    if (raw.length > 4096) {
      window.localStorage.removeItem(key)
      return null
    }
    const progress = parseProgress(JSON.parse(raw), workspaceId)
    if (!progress) window.localStorage.removeItem(key)
    return progress
  } catch {
    try {
      window.localStorage.removeItem(key)
    } catch {
      // Storage can be unavailable in restricted renderer contexts.
    }
    return null
  }
}

export function persistNewSpaceCreationProgress(progress: NewSpaceCreationProgress | null, workspaceId: string) {
  try {
    const key = storageKey(workspaceId)
    if (progress) window.localStorage.setItem(key, JSON.stringify(progress))
    else window.localStorage.removeItem(key)
  } catch {
    // Recovery remains available for the current mount when storage is unavailable.
  }
}

export function clearNewSpaceCreationProgress(creationId: string, workspaceId: string) {
  const key = storageKey(workspaceId)
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return
    const candidate = JSON.parse(raw) as { creationId?: unknown }
    if (candidate?.creationId === creationId) {
      window.localStorage.removeItem(key)
      publishCompletion(workspaceId, creationId)
    }
  } catch {
    // A later read validates and removes malformed recovery state.
  }
}

export function subscribeNewSpaceCreationCompletion(listener: (workspaceId: string, creationId: string) => void) {
  completionListeners.add(listener)
  return () => {
    completionListeners.delete(listener)
  }
}
