import { acceptKnowledgeProposal, createKnowledgeProposal, createKnowledgeSpace, declineKnowledgeProposal, listKnowledgePageHistory, listKnowledgeSnapshot, restoreKnowledgePageVersion } from '@open-cowork/runtime-host/knowledge/knowledge-service'
import type {
  KnowledgeProposalInput,
  KnowledgeReviewInput,
  KnowledgeSnapshotOptions,
  KnowledgeSpaceInput,
  WorkspaceOptions,
} from '@open-cowork/shared'
import { isKnowledgeSpaceVisibility, normalizeKnowledgeProposalContent } from '@open-cowork/shared'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcHandlerContext } from './context.ts'
import {
  objectArg,
  optionalObjectArg,
  registerIpcInvoke,
  stringAndOptionalObjectArgs,
  twoStringsAndOptionalObjectArgs,
} from './schema.ts'
import { LOCAL_WORKSPACE_ID, readWorkspaceIdOption } from '../workspace-gateway.ts'
import { userInfo } from 'node:os'

// The knowledge audit author for the local desktop workspace. Resolved in the
// MAIN process (like the cloud route derives its actor from the verified
// principal, never the request body) so the audit trail records a real
// identity — the OS user — instead of a renderer-supplied literal. The
// coworker/agent write path sets its own `by: 'Coworker'` via the tool bridge
// and never reaches these human IPC handlers.
let cachedLocalAuthor: string | null = null
function localKnowledgeAuthor(): string {
  if (cachedLocalAuthor) return cachedLocalAuthor
  let name = 'Desktop user'
  try {
    const username = userInfo().username?.trim()
    if (username) name = username
  } catch {
    // os.userInfo() throws when the uid has no passwd entry (some containers/CI);
    // fall back to the generic, brand-agnostic label.
  }
  cachedLocalAuthor = name
  return name
}

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
  // `reviewedBy` is resolved authoritatively in the handler (localKnowledgeAuthor),
  // never trusted from the renderer — so the review audit records the real user.
  const workspaceId = readWorkspaceIdOption(value)
  return workspaceId ? { workspaceId } : {}
}

function normalizeProposalInput(value: Record<string, unknown>): KnowledgeProposalInput {
  // `by` is resolved authoritatively in the handler (localKnowledgeAuthor), never
  // trusted from the renderer.
  const workspaceId = readWorkspaceIdOption(value)
  return {
    ...(workspaceId ? { workspaceId } : {}),
    ...normalizeKnowledgeProposalContent(value),
  }
}

function normalizeSpaceInput(value: Record<string, unknown>): KnowledgeSpaceInput {
  const workspaceId = readWorkspaceIdOption(value)
  // Default visibility handling lives in the store; only pass through an explicit
  // valid value. The store re-validates `name`, so pass it through as-is.
  return {
    ...(workspaceId ? { workspaceId } : {}),
    name: value.name as KnowledgeSpaceInput['name'],
    ...(isKnowledgeSpaceVisibility(value.visibility) ? { visibility: value.visibility } : {}),
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

  registerIpcInvoke(context, 'knowledge:space:create', objectArg<KnowledgeSpaceInput>('knowledge space', normalizeSpaceInput), async (event, input) => {
    assertLocalWorkspace(context, event, input)
    return createKnowledgeSpace(withLocalWorkspace(input))
  })

  registerIpcInvoke(context, 'knowledge:proposal:create', objectArg<KnowledgeProposalInput>('knowledge proposal', normalizeProposalInput), async (event, input) => {
    assertLocalWorkspace(context, event, input)
    return createKnowledgeProposal({ ...withLocalWorkspace(input), by: localKnowledgeAuthor() })
  })

  registerIpcInvoke(context, 'knowledge:proposal:accept', stringAndOptionalObjectArgs<KnowledgeReviewInput>('proposal id', 'knowledge review input', {}, normalizeReviewInput), async (event, proposalId, input) => {
    assertLocalWorkspace(context, event, input)
    return acceptKnowledgeProposal(assertKnowledgeId(proposalId, 'Proposal id'), { ...withLocalWorkspace(input), reviewedBy: localKnowledgeAuthor() })
  })

  registerIpcInvoke(context, 'knowledge:proposal:decline', stringAndOptionalObjectArgs<KnowledgeReviewInput>('proposal id', 'knowledge review input', {}, normalizeReviewInput), async (event, proposalId, input) => {
    assertLocalWorkspace(context, event, input)
    return declineKnowledgeProposal(assertKnowledgeId(proposalId, 'Proposal id'), { ...withLocalWorkspace(input), reviewedBy: localKnowledgeAuthor() })
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
      { ...withLocalWorkspace(input), reviewedBy: localKnowledgeAuthor() },
    )
  })
}
