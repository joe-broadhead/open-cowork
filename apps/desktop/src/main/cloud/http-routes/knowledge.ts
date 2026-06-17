import { isKnowledgeSpaceVisibility, type KnowledgeStore, type KnowledgeStoreListOptions, normalizeKnowledgeProposalContent } from '@open-cowork/shared'
import type { CloudApiRouteInput } from './types.ts'
import { CloudServiceError } from '../cloud-service-error.ts'
import { principalHasOrgAdminRole, principalHasPrivilegedTokenScope } from '../principal-access.ts'
function knowledgeWorkspaceId(context: CloudApiRouteInput['context']) {
  return `cloud:${context.principal.tenantId.trim() || context.principal.orgId || context.principal.userId || 'default'}`
}

// The cloud HTTP server always resolves a concrete store (Postgres in cloud,
// SQLite otherwise) before dispatching here, so `knowledgeStore` is guaranteed.
function knowledgeStore(input: CloudApiRouteInput): KnowledgeStore {
  return input.options.knowledgeStore as KnowledgeStore
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

function listOptions(input: CloudApiRouteInput): KnowledgeStoreListOptions {
  const spaceId = readSpaceId(input)
  const limit = input.tools.parseLimit(input.context.url)
  return {
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

export async function handleKnowledgeApiRoute(input: CloudApiRouteInput): Promise<void> {
  const { req, res, options, itemId: collection, action: itemId, artifactId: itemAction, tools } = input

  if (!options.policy.features.knowledge) {
    tools.writePolicyError(res, 403, 'Knowledge is disabled for this cloud profile.', 'knowledge.disabled', options.corsOrigin)
    return
  }

  try {
    await options.service.ensurePrincipal(input.context.principal)
  } catch (error) {
    writeKnowledgeError(input, error)
    return
  }

  // The workspace id is the tenant-isolation boundary: it is recomputed from the
  // authenticated principal on every request and passed as the first argument to
  // every store call below, so a request can only ever read/mutate its own
  // workspace.
  const workspaceId = knowledgeWorkspaceId(input.context)
  const store = knowledgeStore(input)

  if (!collection && req.method === 'GET') {
    try {
      tools.writeJson(res, 200, await store.listSnapshot(workspaceId, listOptions(input)), options.corsOrigin)
    } catch (error) {
      writeKnowledgeError(input, error)
    }
    return
  }

  if (collection === 'spaces' && !itemId && req.method === 'POST') {
    const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024) as Record<string, unknown>
    try {
      // Creating a Space is a structural change, so it is org-admin gated (like review). The
      // creator owns the new Space as Maintainer; the store validates name/visibility.
      assertKnowledgeReviewAuthority(input)
      const visibilityRaw = tools.readString(body.visibility)
      tools.writeJson(res, 201, await store.createSpace(workspaceId, {
        name: tools.readString(body.name) || '',
        visibility: isKnowledgeSpaceVisibility(visibilityRaw) ? visibilityRaw : undefined,
        icon: tools.readString(body.icon) || undefined,
        hue: tools.readString(body.hue) || undefined,
      }), options.corsOrigin)
    } catch (error) {
      writeKnowledgeError(input, error)
    }
    return
  }

  if (collection === 'proposals') {
    if (!itemId && req.method === 'POST') {
      const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      try {
        // Proposing is governed by the space role (the store's assertCanPropose — Contributor or
        // Maintainer), not org-admin: any active member with a contributor role may propose, and
        // proposals stay pending until a Maintainer/admin reviews (assertKnowledgeReviewAuthority).
        tools.writeJson(res, 201, await store.createProposal(workspaceId, {
          ...normalizeKnowledgeProposalContent(body as Record<string, unknown>),
          by: knowledgeActor(input),
        }), options.corsOrigin)
      } catch (error) {
        writeKnowledgeError(input, error)
      }
      return
    }

    if (itemId && itemAction === 'accept' && req.method === 'POST') {
      await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      try {
        assertKnowledgeReviewAuthority(input)
        tools.writeJson(res, 200, await store.acceptProposal(workspaceId, id(itemId, 'Knowledge proposal id'), {
          reviewedBy: knowledgeActor(input),
        }), options.corsOrigin)
      } catch (error) {
        writeKnowledgeError(input, error)
      }
      return
    }

    if (itemId && itemAction === 'decline' && req.method === 'POST') {
      await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      try {
        assertKnowledgeReviewAuthority(input)
        tools.writeJson(res, 200, await store.declineProposal(workspaceId, id(itemId, 'Knowledge proposal id'), {
          reviewedBy: knowledgeActor(input),
        }), options.corsOrigin)
      } catch (error) {
        writeKnowledgeError(input, error)
      }
      return
    }
  }

  if (collection === 'pages' && itemId && itemAction === 'history' && req.method === 'GET') {
    try {
      tools.writeJson(res, 200, await store.listPageHistory(workspaceId, id(itemId, 'Knowledge page id'), listOptions(input)), options.corsOrigin)
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
      tools.writeJson(res, 200, await store.restoreVersion(workspaceId, id(itemId, 'Knowledge page id'), versionId, {
        reviewedBy: knowledgeActor(input),
      }), options.corsOrigin)
    } catch (error) {
      writeKnowledgeError(input, error)
    }
    return
  }

  tools.writeError(res, 404, 'Knowledge route was not found.', options.corsOrigin)
}
