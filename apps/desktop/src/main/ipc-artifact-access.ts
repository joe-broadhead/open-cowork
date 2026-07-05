import type { SessionRecord } from '@open-cowork/runtime-host/session-registry'
import { getRuntimeHomeDir } from '@open-cowork/runtime-host/runtime'
import { isSandboxWorkspaceDir } from '@open-cowork/runtime-host/runtime-paths'
import { isAbsolute, relative, resolve } from 'path'
import type { SessionArtifactRequest } from '@open-cowork/shared'
import { getChartArtifactsRoot } from './chart-artifacts.ts'
import { getBrandName } from './config-loader.ts'
import { resolveContainedArtifactPath } from './artifact-path-policy.ts'
function isInsideOrSame(root: string, source: string) {
  const relativeToRoot = relative(root, source)
  return relativeToRoot === '' || (!relativeToRoot.startsWith('..') && !isAbsolute(relativeToRoot))
}

export function resolvePrivateSessionArtifactPath(
  request: SessionArtifactRequest,
  options: { ensureSessionRecord: (sessionId: string) => SessionRecord | null },
) {
  const record = options.ensureSessionRecord(request.sessionId)
  if (!record) throw new Error(`Unknown ${getBrandName()} session: ${request.sessionId}`)

  const source = resolve(request.filePath)

  // Chart PNGs live outside the session's working directory so they
  // don't pollute user project dirs. Whitelist them explicitly here
  // so the standard export/reveal IPC works uniformly across file
  // artifacts and chart artifacts without forking the channel.
  const chartRoot = resolve(getChartArtifactsRoot(request.sessionId))
  if (isInsideOrSame(chartRoot, source)) {
    return resolveContainedArtifactPath(chartRoot, source)
  }

  const root = resolve(record.opencodeDirectory || getRuntimeHomeDir())
  const privateWorkspace = root === resolve(getRuntimeHomeDir()) || isSandboxWorkspaceDir(root)
  if (!privateWorkspace) {
    throw new Error('Artifacts can only be accessed from Cowork private workspaces.')
  }

  return resolveContainedArtifactPath(root, source)
}
