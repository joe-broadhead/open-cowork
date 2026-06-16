import type {
  KnowledgeProposalInput,
  KnowledgeReviewInput,
  KnowledgeSnapshotOptions,
} from '@open-cowork/shared'
import type { CloudApiRouteInput } from './types.ts'
import { CloudServiceError } from '../cloud-service-error.ts'
import { principalHasOrgAdminRole, principalHasPrivilegedTokenScope } from '../principal-access.ts'
import {
  acceptKnowledgeProposal,
  createKnowledgeProposal,
  declineKnowledgeProposal,
  listKnowledgePageHistory,
  listKnowledgeSnapshot,
  restoreKnowledgePageVersion,
} from '../../knowledge/knowledge-service.ts'
import { normalizeKnowledgeProposalContent } from '../../knowledge/knowledge-input.ts'

type CloudKnowledgeSnapshotOptions = KnowledgeSnapshotOptions & {
  storageDataDir?: string | null
}
type CloudKnowledgeProposalInput = KnowledgeProposalInput & {
  storageDataDir?: string | null
}
type CloudKnowledgeReviewInput = KnowledgeReviewInput & {
  storageDataDir?: string | null
}

function knowledgeWorkspaceId(context: CloudApiRouteInput['context']) {
  return `cloud:${context.principal.tenantId.trim() || context.principal.orgId || context.principal.userId || 'default'}`
}

function knowledgeErrorStatus(error: unknown) {
  const status = Number((error as { status?: unknown } | null)?.status)
  if (Number.isInteger(status) && status >= 400 && status < 600) return status
  if (!(error instanceof Error)) return 500
  const message = error.message
  if (/\bnot found\b/i.test(message)) return 404
  if (/(permission|not allowed|forbidden|unauthori[sz]ed|requires (an )?(org )?admin|requires (contributor|maintainer)|not readable for this role)/i.test(message)) return 403
  // Map the knowledge store's client-input phrasing to 400. Anything that
  // doesn't match a known client error (a raw DB/IO exception, a violated
  // internal invariant) falls through to 500 so it surfaces to alerting instead
  // of looking like a bad request.
  if (/(is required|is invalid|must be|must not|too large|too long|too many|malformed|cannot be empty|out of range|exceeds|is not pending|requires at least|belongs to a different|non-empty|is already the current)/i.test(message)) return 400
  return 500
}

function writeKnowledgeError(input: CloudApiRouteInput, error: unknown) {
  const status = knowledgeErrorStatus(error)
  const message = error instanceof Error && status < 500 ? error.message : 'Knowledge request failed.'
  input.tools.writeError(input.res, status, message, input.options.corsOrigin)
}

function readSpaceId(input: CloudApiRouteInput) {
  const value = input.context.url.searchParams.get('spaceId')
  return value && value.trim() ? value.trim() : null
}

function queryOptions(input: CloudApiRouteInput, workspaceId: string): CloudKnowledgeSnapshotOptions {
  const spaceId = readSpaceId(input)
  const limit = input.tools.parseLimit(input.context.url)
  return {
    workspaceId,
    storageDataDir: input.options.knowledgeDataDir,
    ...(spaceId ? { spaceId } : {}),
    ...(limit ? { limit } : {}),
  }
}

function knowledgeActor(input: CloudApiRouteInput) {
  const { principal } = input.context
  return principal.email || principal.accountId || principal.userId || principal.tokenId || 'cloud-user'
}

function id(value: string | undefined, label: string) {
  let decoded = value
  if (decoded) {
    try {
      decoded = decodeURIComponent(decoded)
    } catch {
      throw new Error(`${label} is invalid.`)
    }
  }
  const trimmed = decoded?.trim()
  if (!trimmed || trimmed.length > 512) throw new Error(`${label} is invalid.`)
  return trimmed
}

function assertKnowledgeReviewAuthority(input: CloudApiRouteInput) {
  const { principal } = input.context
  const allowed = principal.authSource === 'api_token'
    ? principalHasPrivilegedTokenScope(principal, 'admin')
    : principalHasOrgAdminRole(principal)
  if (!allowed) {
    throw new CloudServiceError(403, 'Knowledge proposal review requires an org admin or admin-scoped API token.')
  }
}

function assertKnowledgeProposalAuthority(input: CloudApiRouteInput) {
  const { principal } = input.context
  const allowed = principal.authSource === 'api_token'
    ? principalHasPrivilegedTokenScope(principal, 'admin')
    : principalHasOrgAdminRole(principal)
  if (!allowed) {
    throw new CloudServiceError(403, 'Knowledge proposal creation requires an org admin or admin-scoped API token.')
  }
}

export async function handleKnowledgeApiRoute(input: CloudApiRouteInput): Promise<void> {
  const { req, res, options, itemId: collection, action: itemId, artifactId: itemAction, tools } = input

  try {
    await options.service.ensurePrincipal(input.context.principal)
  } catch (error) {
    writeKnowledgeError(input, error)
    return
  }

  const workspaceId = knowledgeWorkspaceId(input.context)

  if (!collection && req.method === 'GET') {
    try {
      tools.writeJson(res, 200, listKnowledgeSnapshot(queryOptions(input, workspaceId)), options.corsOrigin)
    } catch (error) {
      writeKnowledgeError(input, error)
    }
    return
  }

  if (collection === 'proposals') {
    if (!itemId && req.method === 'POST') {
      const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      try {
        assertKnowledgeProposalAuthority(input)
        tools.writeJson(res, 201, createKnowledgeProposal({
          ...normalizeKnowledgeProposalContent(body as Record<string, unknown>),
          workspaceId,
          storageDataDir: input.options.knowledgeDataDir,
          by: knowledgeActor(input),
        } as CloudKnowledgeProposalInput), options.corsOrigin)
      } catch (error) {
        writeKnowledgeError(input, error)
      }
      return
    }

    if (itemId && itemAction === 'accept' && req.method === 'POST') {
      const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      try {
        assertKnowledgeReviewAuthority(input)
        tools.writeJson(res, 200, acceptKnowledgeProposal(id(itemId, 'Knowledge proposal id'), {
          ...(body as KnowledgeReviewInput),
          workspaceId,
          storageDataDir: input.options.knowledgeDataDir,
          reviewedBy: knowledgeActor(input),
        } as CloudKnowledgeReviewInput), options.corsOrigin)
      } catch (error) {
        writeKnowledgeError(input, error)
      }
      return
    }

    if (itemId && itemAction === 'decline' && req.method === 'POST') {
      const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      try {
        assertKnowledgeReviewAuthority(input)
        tools.writeJson(res, 200, declineKnowledgeProposal(id(itemId, 'Knowledge proposal id'), {
          ...(body as KnowledgeReviewInput),
          workspaceId,
          storageDataDir: input.options.knowledgeDataDir,
          reviewedBy: knowledgeActor(input),
        } as CloudKnowledgeReviewInput), options.corsOrigin)
      } catch (error) {
        writeKnowledgeError(input, error)
      }
      return
    }
  }

  if (collection === 'pages' && itemId && itemAction === 'history' && req.method === 'GET') {
    try {
      tools.writeJson(res, 200, listKnowledgePageHistory(id(itemId, 'Knowledge page id'), queryOptions(input, workspaceId)), options.corsOrigin)
    } catch (error) {
      writeKnowledgeError(input, error)
    }
    return
  }

  if (collection === 'pages' && itemId && itemAction === 'restore' && req.method === 'POST') {
    const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
    try {
      assertKnowledgeReviewAuthority(input)
      const rawVersionId = (body as Record<string, unknown> | null)?.versionId
      const versionId = id(typeof rawVersionId === 'string' ? rawVersionId : undefined, 'Knowledge version id')
      tools.writeJson(res, 200, restoreKnowledgePageVersion(id(itemId, 'Knowledge page id'), versionId, {
        workspaceId,
        storageDataDir: input.options.knowledgeDataDir,
        reviewedBy: knowledgeActor(input),
      } as CloudKnowledgeReviewInput), options.corsOrigin)
    } catch (error) {
      writeKnowledgeError(input, error)
    }
    return
  }

  tools.writeError(res, 404, 'Knowledge route was not found.', options.corsOrigin)
}
