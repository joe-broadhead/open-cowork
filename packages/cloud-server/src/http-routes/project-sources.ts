import type { CloudProjectSnapshotUploadInput } from '@open-cowork/shared'
import { normalizeCloudProjectSource } from '@open-cowork/shared'
import type { CloudApiRouteInput } from './types.ts'

export async function handleProjectSourcesApiRoute(input: CloudApiRouteInput): Promise<boolean> {
  const { req, res, options, context, itemId, action, tools } = input

  if (itemId === 'validate' && !action && req.method === 'POST') {
    const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
    tools.writeJson(res, 200, options.service.domains.projectSources.validateProjectSource(normalizeCloudProjectSource(body.projectSource)), options.corsOrigin)
    return true
  }

  if (itemId === 'snapshots' && !action && req.method === 'POST') {
    const body = await tools.readJsonBody(req, options.maxBodyBytes || 35 * 1024 * 1024)
    const uploaded = await options.service.domains.projectSources.uploadProjectSnapshot(context.principal, {
      title: tools.readString(body.title),
      files: Array.isArray(body.files) ? body.files as CloudProjectSnapshotUploadInput['files'] : [],
      excluded: Array.isArray(body.excluded) ? body.excluded as CloudProjectSnapshotUploadInput['excluded'] : [],
      warnings: Array.isArray(body.warnings) ? body.warnings.filter((entry): entry is string => typeof entry === 'string') : [],
      fileCount: typeof body.fileCount === 'number' ? body.fileCount : undefined,
      byteCount: typeof body.byteCount === 'number' ? body.byteCount : undefined,
    })
    tools.writeJson(res, 201, uploaded, options.corsOrigin)
    return true
  }

  tools.writeError(res, 404, 'Not found.', options.corsOrigin)
  return true
}
