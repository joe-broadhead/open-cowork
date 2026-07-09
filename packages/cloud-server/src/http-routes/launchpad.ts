import { buildLaunchpadFeedFromSources, listLaunchpadCoordinationBoard } from '@open-cowork/runtime-host/launchpad/launchpad-service'
import type { ArtifactIndexPayload, LaunchpadFeedRequest } from '@open-cowork/shared'
import type { CloudApiRouteInput } from './types.ts'
const MAX_LAUNCHPAD_SECTION_LIMIT = 50
const LAUNCHPAD_SESSION_SCAN_LIMIT = 100

function launchpadWorkspaceId(context: CloudApiRouteInput['context']) {
  return `cloud:${context.principal.tenantId.trim() || context.principal.orgId || context.principal.userId || 'default'}`
}

function parseLimitParam(input: CloudApiRouteInput, key: keyof LaunchpadFeedRequest) {
  const raw = input.context.url.searchParams.get(String(key))
  if (raw === null || raw === '') return null
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > MAX_LAUNCHPAD_SECTION_LIMIT) {
    input.tools.writeError(input.res, 400, `${String(key)} must be an integer between 1 and ${MAX_LAUNCHPAD_SECTION_LIMIT}.`, input.options.corsOrigin)
    return undefined
  }
  return value
}

function launchpadQuery(input: CloudApiRouteInput): LaunchpadFeedRequest | null {
  const limit = parseLimitParam(input, 'limit')
  if (limit === undefined) return null
  const inProgressLimit = parseLimitParam(input, 'inProgressLimit')
  if (inProgressLimit === undefined) return null
  const waitingLimit = parseLimitParam(input, 'waitingLimit')
  if (waitingLimit === undefined) return null
  const artifactsLimit = parseLimitParam(input, 'artifactsLimit')
  if (artifactsLimit === undefined) return null
  return {
    projectId: input.context.url.searchParams.get('projectId'),
    limit,
    inProgressLimit,
    waitingLimit,
    artifactsLimit,
  }
}

export async function handleLaunchpadApiRoute(input: CloudApiRouteInput): Promise<boolean> {
  const { req, res, options, itemId, action, tools } = input
  if (input.resource !== 'launchpad') return false
  if (itemId !== 'feed' || action || req.method !== 'GET') {
    tools.writeError(res, 404, 'Not found.', options.corsOrigin)
    return true
  }

  const request = launchpadQuery(input)
  if (!request) return true
  const workspaceId = launchpadWorkspaceId(input.context)
  const board = listLaunchpadCoordinationBoard({
    workspaceId,
    projectId: request.projectId || null,
    limit: Math.max(500, Number(request.inProgressLimit || request.limit || 8) * 4),
  })
  const projectTaskIds = request.projectId
    ? board.tasks
        .filter((task) => task.projectId === request.projectId)
        .map((task) => task.id)
    : null
  const summaryPage = await options.service.listCloudLaunchpadSessionSummaries(input.context.principal, {
    limit: LAUNCHPAD_SESSION_SCAN_LIMIT,
  })
  const sessionSnapshots = summaryPage.items.map((summary) => ({
    sessionId: summary.sessionId,
    title: summary.sessionTitle,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    runId: null,
    view: {
      pendingApprovals: summary.pendingApprovals,
      pendingQuestions: summary.pendingQuestions,
    },
  }))
  const artifactIndex: ArtifactIndexPayload = options.policy.features.artifacts && options.artifacts
    ? await options.artifacts.listArtifactIndex(input.context.principal, {
        projectId: request.projectId || null,
        taskIds: projectTaskIds,
        limit: Math.max(Number(request.artifactsLimit || request.limit || 8) + 1, 9),
      })
    : { artifacts: [], total: 0 }

  tools.writeJson(res, 200, buildLaunchpadFeedFromSources({
    request,
    workspaceId,
    board,
    sessions: sessionSnapshots,
    sessionsTruncated: summaryPage.truncated,
    artifacts: artifactIndex.artifacts,
    artifactTotal: artifactIndex.total,
    artifactTruncated: artifactIndex.truncated,
  }), options.corsOrigin)
  return true
}
