import { existsSync, realpathSync, statSync } from 'fs'
import { isAbsolute, relative, resolve } from 'path'

export function resolveContainedArtifactPath(root: string, filePath: string) {
  const resolvedRoot = resolve(root)
  const resolvedSource = resolve(filePath)
  if (!existsSync(resolvedRoot)) {
    throw new Error('Artifact workspace is no longer available.')
  }
  if (!existsSync(resolvedSource)) {
    throw new Error('Artifact file is no longer available.')
  }

  const realRoot = realpathSync.native(resolvedRoot)
  const realSource = realpathSync.native(resolvedSource)
  const relativeToRoot = relative(realRoot, realSource)
  const insideRoot = relativeToRoot === '' || (!relativeToRoot.startsWith('..') && !isAbsolute(relativeToRoot))
  if (!insideRoot) {
    throw new Error('Artifact path is outside the current private workspace.')
  }

  if (!statSync(realSource).isFile()) {
    throw new Error('Artifact file is no longer available.')
  }

  return { root: realRoot, source: realSource }
}
