import type {
  KnowledgeProposalInput,
  KnowledgeReviewInput,
  KnowledgeSnapshotOptions,
  KnowledgeSpaceVisibility,
} from '@open-cowork/shared'

// Minimal structural view of the renderer window we notify on knowledge changes —
// avoids a (type-only) Electron import so this module is package-resolvable. The
// desktop injects the real BrowserWindow getter via configureKnowledgeService.
type RendererWindow = {
  isDestroyed(): boolean
  webContents: { send(channel: string, ...args: unknown[]): void }
}
import {
  acceptKnowledgeProposal as acceptProposalState,
  createKnowledgeProposal as createProposalState,
  createKnowledgeSpace as createSpaceState,
  declineKnowledgeProposal as declineProposalState,
  listKnowledgePageHistory as listPageHistoryState,
  listKnowledgeSnapshot as listSnapshotState,
  restoreKnowledgePageVersion as restorePageVersionState,
} from './knowledge-store.ts'

type KnowledgeStorageOptions = {
  storageDataDir?: string | null
}
type InternalKnowledgeSnapshotOptions = KnowledgeSnapshotOptions & KnowledgeStorageOptions
type InternalKnowledgeProposalInput = KnowledgeProposalInput & KnowledgeStorageOptions
type InternalKnowledgeReviewInput = KnowledgeReviewInput & KnowledgeStorageOptions
type InternalKnowledgeSpaceInput = {
  name: string
  visibility?: KnowledgeSpaceVisibility | null
  icon?: string | null
  hue?: string | null
  workspaceId?: string | null
} & KnowledgeStorageOptions

let getMainWindow: (() => RendererWindow | null) | null = null

function publishKnowledgeUpdated() {
  const win = getMainWindow?.()
  if (win && !win.isDestroyed()) win.webContents.send('knowledge:updated')
}

export function configureKnowledgeService(options: {
  getMainWindow: () => RendererWindow | null
}) {
  getMainWindow = options.getMainWindow
}

export function listKnowledgeSnapshot(options: InternalKnowledgeSnapshotOptions = {}) {
  return listSnapshotState(options)
}

export function listKnowledgePageHistory(pageId: string, options: InternalKnowledgeSnapshotOptions = {}) {
  return listPageHistoryState(pageId, options)
}

export function createKnowledgeSpace(input: InternalKnowledgeSpaceInput) {
  const space = createSpaceState(input.workspaceId ?? '', input, input)
  publishKnowledgeUpdated()
  return space
}

export function createKnowledgeProposal(input: InternalKnowledgeProposalInput) {
  const proposal = createProposalState(input)
  publishKnowledgeUpdated()
  return proposal
}

export function acceptKnowledgeProposal(proposalId: string, input: InternalKnowledgeReviewInput = {}) {
  const result = acceptProposalState(proposalId, input)
  publishKnowledgeUpdated()
  return result
}

export function declineKnowledgeProposal(proposalId: string, input: InternalKnowledgeReviewInput = {}) {
  const proposal = declineProposalState(proposalId, input)
  publishKnowledgeUpdated()
  return proposal
}

export function restoreKnowledgePageVersion(pageId: string, versionId: string, input: InternalKnowledgeReviewInput = {}) {
  const result = restorePageVersionState(pageId, versionId, input)
  publishKnowledgeUpdated()
  return result
}
