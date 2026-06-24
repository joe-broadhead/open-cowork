import { isArtifactKind, isArtifactStatus, type ArtifactIndexRequest, type ArtifactKind, type ArtifactStatus } from '@open-cowork/shared'
import type { CloudApiRouteInput } from './types.ts'

function parseTaskIds(input: CloudApiRouteInput): string[] | null | undefined {
  const taskIds = input.context.url.searchParams
    .getAll('taskIds')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean)
  const unique = Array.from(new Set(taskIds))
  if (unique.length > 128) {
    input.tools.writeError(input.res, 400, 'Task ids exceeds 128 entries.', input.options.corsOrigin)
    return undefined
  }
  if (unique.some((value) => Buffer.byteLength(value, 'utf8') > 512)) {
    input.tools.writeError(input.res, 400, 'Task id is too large.', input.options.corsOrigin)
    return undefined
  }
  return unique.length > 0 ? unique : null
}

function artifactQuery(input: CloudApiRouteInput): ArtifactIndexRequest | null {
  const { context, tools } = input
  const kind = context.url.searchParams.get('kind')
  const status = context.url.searchParams.get('status')
  if (kind && !isArtifactKind(kind)) {
    tools.writeError(input.res, 400, 'Artifact kind is invalid.', input.options.corsOrigin)
    return null
  }
  if (status && !isArtifactStatus(status)) {
    tools.writeError(input.res, 400, 'Artifact status is invalid.', input.options.corsOrigin)
    return null
  }
  const taskIds = parseTaskIds(input)
  if (taskIds === undefined) return null
  return {
    sessionId: context.url.searchParams.get('sessionId'),
    projectId: context.url.searchParams.get('projectId'),
    taskId: context.url.searchParams.get('taskId'),
    taskIds,
    kind: kind as ArtifactKind | null,
    status: status as ArtifactStatus | null,
    limit: tools.parseLimit(context.url) || null,
  }
}

export async function handleArtifactsApiRoute(input: CloudApiRouteInput): Promise<boolean> {
  const { req, res, options, itemId, action, tools } = input
  if (input.resource !== 'artifacts') return false
  if (!options.policy.features.artifacts) {
    tools.writePolicyError(res, 403, 'Artifacts are disabled for this cloud profile.', 'artifacts.disabled', options.corsOrigin)
    return true
  }
  if (!options.artifacts) {
    tools.writeError(res, 503, 'Cloud artifact storage is not configured.', options.corsOrigin)
    return true
  }
  if (!itemId && !action && req.method === 'GET') {
    const query = artifactQuery(input)
    if (!query) return true
    tools.writeJson(res, 200, await options.artifacts.listArtifactIndex(input.context.principal, query), options.corsOrigin)
    return true
  }
  tools.writeError(res, 404, 'Not found.', options.corsOrigin)
  return true
}
