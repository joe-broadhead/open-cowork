import type { ArtifactKind, ArtifactStatus } from '@open-cowork/shared'
import type { CloudApiRouteInput } from './types.ts'

export async function handleSessionArtifactsApiRoute(input: CloudApiRouteInput): Promise<boolean> {
  const { req, res, options, context, resource, itemId: sessionId, action, artifactId, tools } = input
  if (resource !== 'sessions' || action !== 'artifacts' || !sessionId) return false

  if (!options.policy.features.artifacts) {
    tools.writePolicyError(res, 403, 'Artifacts are disabled for this cloud profile.', 'artifacts.disabled', options.corsOrigin)
    return true
  }
  if (!options.artifacts) {
    tools.writeError(res, 503, 'Cloud artifact storage is not configured.', options.corsOrigin)
    return true
  }
  if (!artifactId && req.method === 'GET') {
    tools.writeJson(res, 200, {
      artifacts: await options.artifacts.listPublicSessionArtifacts(context.principal, sessionId),
    }, options.corsOrigin)
    return true
  }
  if (!artifactId && req.method === 'POST') {
    const body = await tools.readJsonBody(req, options.maxBodyBytes || 35 * 1024 * 1024)
    const uploaded = await options.artifacts.uploadSessionArtifact(context.principal, sessionId, {
      filename: tools.readString(body.filename) || '',
      contentType: tools.readString(body.contentType),
      dataBase64: tools.readString(body.dataBase64) || '',
      kind: tools.readString(body.kind) as ArtifactKind | null,
      status: tools.readString(body.status) as ArtifactStatus | null,
      authorAgentId: tools.readString(body.authorAgentId),
      projectId: tools.readString(body.projectId),
      taskId: tools.readString(body.taskId),
      statusUpdatedBy: tools.readString(body.statusUpdatedBy),
      statusUpdatedAt: tools.readString(body.statusUpdatedAt),
    })
    tools.writeJson(res, 201, { artifact: options.artifacts.publicArtifact(uploaded) }, options.corsOrigin)
    return true
  }

  const artifactSubaction = context.segments[5]
  if (artifactId && artifactSubaction === 'status' && req.method === 'POST') {
    const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
    const nextStatus = tools.readString(body.status)
    if (!nextStatus) {
      tools.writeError(res, 400, 'Artifact status is required.', options.corsOrigin)
      return true
    }
    const artifact = await options.artifacts.updateSessionArtifactStatus(context.principal, sessionId, artifactId, {
      status: nextStatus as ArtifactStatus,
      updatedBy: tools.readString(body.updatedBy),
      authorAgentId: tools.readString(body.authorAgentId),
      projectId: tools.readString(body.projectId),
      taskId: tools.readString(body.taskId),
      kind: tools.readString(body.kind) as ArtifactKind | null,
    })
    tools.writeJson(res, 200, { artifact: options.artifacts.publicArtifact(artifact) }, options.corsOrigin)
    return true
  }
  if (artifactId && !artifactSubaction && req.method === 'GET') {
    // Opt-in direct-to-store download. When the client asks (?transfer=presigned) AND the
    // configured object store supports presigning, hand back a time-limited URL the client
    // fetches straight from object storage instead of base64-buffering the bytes through the
    // pod. Any other case (no opt-in, or no presign support) falls through to the buffered
    // base64 response below, which stays the default-safe path.
    if (context.url.searchParams.get('transfer') === 'presigned') {
      const presigned = await options.artifacts.presignSessionArtifactDownload(context.principal, sessionId, artifactId)
      if (presigned) {
        tools.writeJson(res, 200, {
          artifact: {
            ...options.artifacts.publicArtifact(presigned.artifact),
            transfer: 'presigned',
            downloadUrl: presigned.presigned.url,
            downloadExpiresAt: presigned.presigned.expiresAt,
          },
        }, options.corsOrigin)
        return true
      }
    }
    const artifact = await options.artifacts.readSessionArtifact(context.principal, sessionId, artifactId)
    tools.writeJson(res, 200, {
      artifact: {
        ...options.artifacts.publicArtifact(artifact),
        contentType: artifact.contentType,
        dataBase64: artifact.dataBase64,
      },
    }, options.corsOrigin)
    return true
  }
  tools.writeError(res, 404, 'Not found.', options.corsOrigin)
  return true
}
