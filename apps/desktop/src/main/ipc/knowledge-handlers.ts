import type {
  KnowledgeProposalInput,
  KnowledgeReviewInput,
  KnowledgeSnapshotOptions,
  WorkspaceOptions,
} from '@open-cowork/shared'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcHandlerContext } from './context.ts'
import {
  objectArg,
  optionalObjectArg,
  registerIpcInvoke,
  stringAndOptionalObjectArgs,
  twoStringsAndOptionalObjectArgs,
} from './schema.ts'
import {
  acceptKnowledgeProposal,
  createKnowledgeProposal,
  declineKnowledgeProposal,
  listKnowledgePageHistory,
  listKnowledgeSnapshot,
  restoreKnowledgePageVersion,
} from '../knowledge/knowledge-service.ts'
import { normalizeKnowledgeProposalContent } from '../knowledge/knowledge-input.ts'
import { LOCAL_WORKSPACE_ID, readWorkspaceIdOption } from '../workspace-gateway.ts'

function assertKnowledgeId(value: unknown, label = 'knowledge id') {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) {
    throw new Error(`${label} is invalid.`)
  }
  return value.trim()
}

function normalizeWorkspaceOptions(value: Record<string, unknown>): WorkspaceOptions {
  const workspaceId = readWorkspaceIdOption(value)
  return workspaceId ? { workspaceId } : {}
}

function normalizeSnapshotOptions(value: Record<string, unknown>): KnowledgeSnapshotOptions {
  const workspaceId = readWorkspaceIdOption(value)
  const spaceId = typeof value.spaceId === 'string' && value.spaceId.trim() ? value.spaceId.trim() : null
  return {
    ...(workspaceId ? { workspaceId } : {}),
    ...(spaceId ? { spaceId } : {}),
  }
}

function normalizeReviewInput(value: Record<string, unknown>): KnowledgeReviewInput {
  const workspaceId = readWorkspaceIdOption(value)
  const reviewedBy = typeof value.reviewedBy === 'string' && value.reviewedBy.trim() ? value.reviewedBy.trim() : null
  return {
    ...(workspaceId ? { workspaceId } : {}),
    ...(reviewedBy ? { reviewedBy } : {}),
  }
}

function normalizeProposalInput(value: Record<string, unknown>): KnowledgeProposalInput {
  const workspaceId = readWorkspaceIdOption(value)
  const by = typeof value.by === 'string' && value.by.trim() ? value.by.trim() : value.by === null ? null : undefined
  return {
    ...(workspaceId ? { workspaceId } : {}),
    ...(by !== undefined ? { by } : {}),
    ...normalizeKnowledgeProposalContent(value),
  }
}

function assertLocalWorkspace(context: IpcHandlerContext, event: IpcMainInvokeEvent, options?: unknown) {
  context.workspaceGateway.assertLocalWorkspace(event, readWorkspaceIdOption(options))
}

function withLocalWorkspace<T extends WorkspaceOptions>(options: T | undefined): T & { workspaceId: string } {
  return { ...((options || {}) as T), workspaceId: LOCAL_WORKSPACE_ID } as T & { workspaceId: string }
}

export function registerKnowledgeHandlers(context: IpcHandlerContext) {
  registerIpcInvoke(context, 'knowledge:snapshot', optionalObjectArg<KnowledgeSnapshotOptions>('knowledge options', normalizeSnapshotOptions), async (event, options) => {
    assertLocalWorkspace(context, event, options)
    return listKnowledgeSnapshot(withLocalWorkspace(options))
  })

  registerIpcInvoke(context, 'knowledge:proposal:create', objectArg<KnowledgeProposalInput>('knowledge proposal', normalizeProposalInput), async (event, input) => {
    assertLocalWorkspace(context, event, input)
    return createKnowledgeProposal(withLocalWorkspace(input))
  })

  registerIpcInvoke(context, 'knowledge:proposal:accept', stringAndOptionalObjectArgs<KnowledgeReviewInput>('proposal id', 'knowledge review input', {}, normalizeReviewInput), async (event, proposalId, input) => {
    assertLocalWorkspace(context, event, input)
    return acceptKnowledgeProposal(assertKnowledgeId(proposalId, 'Proposal id'), withLocalWorkspace(input))
  })

  registerIpcInvoke(context, 'knowledge:proposal:decline', stringAndOptionalObjectArgs<KnowledgeReviewInput>('proposal id', 'knowledge review input', {}, normalizeReviewInput), async (event, proposalId, input) => {
    assertLocalWorkspace(context, event, input)
    return declineKnowledgeProposal(assertKnowledgeId(proposalId, 'Proposal id'), withLocalWorkspace(input))
  })

  registerIpcInvoke(context, 'knowledge:page:history', stringAndOptionalObjectArgs<KnowledgeSnapshotOptions>('page id', 'knowledge options', {}, normalizeWorkspaceOptions), async (event, pageId, options) => {
    assertLocalWorkspace(context, event, options)
    return listKnowledgePageHistory(assertKnowledgeId(pageId, 'Page id'), withLocalWorkspace(options))
  })

  registerIpcInvoke(context, 'knowledge:page:restore', twoStringsAndOptionalObjectArgs<KnowledgeReviewInput>('page id', 'version id', 'knowledge review input', {}, normalizeReviewInput), async (event, pageId, versionId, input) => {
    assertLocalWorkspace(context, event, input)
    return restoreKnowledgePageVersion(
      assertKnowledgeId(pageId, 'Page id'),
      assertKnowledgeId(versionId, 'Version id'),
      withLocalWorkspace(input),
    )
  })
}
