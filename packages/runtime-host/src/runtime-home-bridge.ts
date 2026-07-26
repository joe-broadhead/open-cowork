import {
  RUNTIME_TOOLING_BRIDGE_PROJECTIONS,
  normalizeRuntimeToolingBridgeConsent,
  type BridgeProjection,
  type RuntimeToolingBridgeCategoryId,
  type RuntimeToolingBridgeConsent,
} from '@open-cowork/shared'
import { writeFileAtomic } from '@open-cowork/shared/node'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path'
import { getRuntimeHomeDir } from './runtime-paths.js'

const BRIDGE_MANIFEST_VERSION = 1
const BRIDGE_MANIFEST_RELATIVE_PATH = '.open-cowork/tooling-bridge-v1.json'

// Entries created by the former monolithic bridge. Reconciliation removes
// only links that still point to the corresponding host-home entry; it never
// follows a link or removes its host target.
const LEGACY_TOOLING_BRIDGE_ENTRIES = [
  '.gitconfig',
  '.gitignore',
  '.gitignore_global',
  '.gitmessage',
  '.npmrc',
  '.pnpmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.netrc',
  '.ssh',
  '.aws',
  '.azure',
  '.docker',
  '.kube',
  '.config/git',
  '.config/gh',
  '.config/gcloud',
  '.config/npm',
  '.config/yarn',
  '.config/pnpm',
  '.config/gh-copilot',
] as const

type BridgeManifestEntry = Pick<
  BridgeProjection,
  'id' | 'category' | 'sourceRelativePath' | 'runtimeDestination'
>

type BridgeManifest = {
  version: typeof BRIDGE_MANIFEST_VERSION
  entries: BridgeManifestEntry[]
}

export type RuntimeToolingBridgeReconciliationStatus =
  | 'linked'
  | 'unchanged'
  | 'removed'
  | 'source-missing'
  | 'conflict'
  | 'error'

export type RuntimeToolingBridgeReconciliation = {
  projectionId: string
  category: RuntimeToolingBridgeCategoryId
  status: RuntimeToolingBridgeReconciliationStatus
}

function normalizeLinkedTarget(target: string) {
  try {
    const stats = lstatSync(target)
    if (!stats.isSymbolicLink()) return null
    return resolve(dirname(target), readlinkSync(target))
  } catch {
    return null
  }
}

function resolveContainedPath(root: string, relativePath: string) {
  const normalizedRoot = resolve(root)
  const target = resolve(normalizedRoot, relativePath)
  if (target === normalizedRoot || !target.startsWith(`${normalizedRoot}${sep}`)) return null
  return target
}

function isSafeRelativePath(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return false
  if (isAbsolute(value)) return false
  const normalizedPath = normalize(value)
  return normalizedPath !== '..' && !normalizedPath.startsWith(`..${sep}`)
}

function hasSafeRuntimeParents(runtimeHome: string, target: string, createMissing = false) {
  const root = resolve(runtimeHome)
  try {
    const rootStats = lstatSync(root)
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) return false
  } catch {
    return false
  }
  const parentRelativePath = relative(root, dirname(target))
  if (
    parentRelativePath === '..'
    || parentRelativePath.startsWith(`..${sep}`)
    || isAbsolute(parentRelativePath)
  ) {
    return false
  }
  if (!parentRelativePath) return true

  let cursor = root
  for (const segment of parentRelativePath.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, segment)
    try {
      const stats = lstatSync(cursor)
      if (stats.isSymbolicLink() || !stats.isDirectory()) return false
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
      if (!createMissing) return true
      try {
        mkdirSync(cursor, { mode: 0o700 })
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') return false
      }
      try {
        const stats = lstatSync(cursor)
        if (stats.isSymbolicLink() || !stats.isDirectory()) return false
      } catch {
        return false
      }
    }
  }
  return true
}

function normalizeManifestEntry(value: unknown): BridgeManifestEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (
    typeof raw.id !== 'string'
    || typeof raw.category !== 'string'
    || !isSafeRelativePath(raw.sourceRelativePath)
    || !isSafeRelativePath(raw.runtimeDestination)
  ) {
    return null
  }

  // The runtime can write inside its managed home, including this ownership
  // manifest. Treat the file as an untrusted cache of catalog ids rather than
  // accepting paths from it: otherwise a forged entry could reuse an active id
  // with a legacy directory destination (for example `.ssh`) and suppress the
  // broad-link cleanup below.
  const projection = RUNTIME_TOOLING_BRIDGE_PROJECTIONS.find(({ id }) => id === raw.id)
  if (
    !projection
    || raw.category !== projection.category
    || raw.sourceRelativePath !== projection.sourceRelativePath
    || raw.runtimeDestination !== projection.runtimeDestination
  ) {
    return null
  }
  return {
    id: projection.id,
    category: projection.category,
    sourceRelativePath: projection.sourceRelativePath,
    runtimeDestination: projection.runtimeDestination,
  }
}

function readManifest(runtimeHome: string): BridgeManifest {
  const path = resolveContainedPath(runtimeHome, BRIDGE_MANIFEST_RELATIVE_PATH)
  if (!path || !hasSafeRuntimeParents(runtimeHome, path) || !existsSync(path)) {
    return { version: BRIDGE_MANIFEST_VERSION, entries: [] }
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { version: BRIDGE_MANIFEST_VERSION, entries: [] }
    }
    const raw = parsed as { version?: unknown; entries?: unknown }
    if (raw.version !== BRIDGE_MANIFEST_VERSION || !Array.isArray(raw.entries)) {
      return { version: BRIDGE_MANIFEST_VERSION, entries: [] }
    }
    return {
      version: BRIDGE_MANIFEST_VERSION,
      entries: raw.entries
        .map(normalizeManifestEntry)
        .filter((entry): entry is BridgeManifestEntry => Boolean(entry)),
    }
  } catch {
    return { version: BRIDGE_MANIFEST_VERSION, entries: [] }
  }
}

function writeManifest(runtimeHome: string, entries: BridgeManifestEntry[]) {
  const path = resolveContainedPath(runtimeHome, BRIDGE_MANIFEST_RELATIVE_PATH)
  if (!path) throw new Error('Runtime tooling bridge manifest path is invalid.')
  if (!hasSafeRuntimeParents(runtimeHome, path, true)) {
    throw new Error('Runtime tooling bridge manifest parent is not an owned directory.')
  }
  writeFileAtomic(path, JSON.stringify({
    version: BRIDGE_MANIFEST_VERSION,
    entries,
  } satisfies BridgeManifest), { mode: 0o600 })
}

function removeExpectedLink(target: string, expectedSource: string) {
  const linkedTarget = normalizeLinkedTarget(target)
  if (linkedTarget !== expectedSource) return false
  rmSync(target, { force: true })
  return true
}

function pathExistsWithoutFollowing(path: string) {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    // Treat unreadable/indeterminate targets as present so reconciliation
    // fails closed. Only a definite ENOENT is safe to grant over.
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

function cleanupLegacyLinks(
  runtimeHome: string,
  realHome: string,
  ownedDestinations: ReadonlySet<string>,
) {
  const failures: string[] = []
  const cleanupCandidates = new Set([
    ...LEGACY_TOOLING_BRIDGE_ENTRIES,
    ...RUNTIME_TOOLING_BRIDGE_PROJECTIONS.map(({ runtimeDestination }) => runtimeDestination),
  ])
  for (const relativePath of cleanupCandidates) {
    if (ownedDestinations.has(relativePath)) continue
    const source = resolveContainedPath(realHome, relativePath)
    const target = resolveContainedPath(runtimeHome, relativePath)
    if (!source || !target) continue
    try {
      if (!hasSafeRuntimeParents(runtimeHome, target)) {
        failures.push(relativePath)
        continue
      }
      const isFixedProjectionParent = RUNTIME_TOOLING_BRIDGE_PROJECTIONS.some(
        ({ runtimeDestination }) => runtimeDestination.startsWith(`${relativePath}${sep}`),
      )
      if (isFixedProjectionParent) {
        try {
          const stats = lstatSync(target)
          // New file-level projections create real parent directories. They
          // are not remnants of the former broad-link bridge.
          if (!stats.isSymbolicLink() && stats.isDirectory()) continue
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            failures.push(relativePath)
          }
          // A definitely missing parent is safe; the fixed link grant can
          // create it later.
        }
      }
      const removed = removeExpectedLink(target, source)
      // A legacy managed destination that no longer points at its expected
      // host path is unowned. Preserve it, but block runtime startup until the
      // conflict is resolved rather than silently leaving broad access active.
      if (!removed && pathExistsWithoutFollowing(target)) failures.push(relativePath)
    } catch {
      failures.push(relativePath)
    }
  }
  if (failures.length) {
    throw new Error(`Runtime tooling bridge could not safely remove ${failures.length} legacy link(s).`)
  }
}

function projectionPaths(
  projection: Pick<BridgeProjection, 'sourceRelativePath' | 'runtimeDestination'>,
  realHome: string,
  runtimeHome: string,
) {
  const source = resolveContainedPath(realHome, projection.sourceRelativePath)
  const target = resolveContainedPath(runtimeHome, projection.runtimeDestination)
  if (!source || !target) return null
  return { source, target }
}

function sourceIsFile(path: string) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function linkProjection(runtimeHome: string, source: string, target: string) {
  if (!hasSafeRuntimeParents(runtimeHome, target, true)) {
    throw new Error('Runtime tooling bridge destination parent is not an owned directory.')
  }
  symlinkSync(source, target, 'file')
}

/**
 * Reconciles granular host tooling consent before OpenCode starts.
 *
 * Cleanup is completed first. If a stale broad link cannot be removed, the
 * runtime startup fails before any new access is granted. Results contain only
 * catalog ids/categories/statuses so callers can report failures without host
 * paths or credential content.
 */
export function syncRuntimeHomeToolingBridge(options?: {
  runtimeHome?: string
  realHome?: string
  consent?: RuntimeToolingBridgeConsent
}) {
  const runtimeHome = options?.runtimeHome || getRuntimeHomeDir()
  const realHome = options?.realHome || homedir()
  const consent = normalizeRuntimeToolingBridgeConsent(options?.consent)
  const projections = RUNTIME_TOOLING_BRIDGE_PROJECTIONS
  const manifestPath = resolveContainedPath(runtimeHome, BRIDGE_MANIFEST_RELATIVE_PATH)
  if (!manifestPath || !hasSafeRuntimeParents(runtimeHome, manifestPath)) {
    throw new Error('Runtime tooling bridge root is not an owned directory.')
  }
  const previousManifest = readManifest(runtimeHome)
  const ownedDestinations = new Set(previousManifest.entries.map(({ runtimeDestination }) => runtimeDestination))
  const results: RuntimeToolingBridgeReconciliation[] = []

  cleanupLegacyLinks(runtimeHome, realHome, ownedDestinations)

  const activeProjectionIds = new Set(
    projections
      .filter(({ category }) => consent.categories[category])
      .map(({ id }) => id),
  )
  const retainedEntries: BridgeManifestEntry[] = []
  const previousById = new Map(previousManifest.entries.map((entry) => [entry.id, entry]))

  // Remove stale or disabled bridge-owned links before granting anything new.
  for (const entry of previousManifest.entries) {
    const paths = projectionPaths(entry, realHome, runtimeHome)
    if (!paths) continue
    if (activeProjectionIds.has(entry.id)) continue
    try {
      if (!hasSafeRuntimeParents(runtimeHome, paths.target)) {
        results.push({ projectionId: entry.id, category: entry.category, status: 'error' })
        continue
      }
      const removed = removeExpectedLink(paths.target, paths.source)
      results.push({
        projectionId: entry.id,
        category: entry.category,
        status: removed || !pathExistsWithoutFollowing(paths.target) ? 'removed' : 'conflict',
      })
    } catch {
      results.push({ projectionId: entry.id, category: entry.category, status: 'error' })
    }
  }

  if (results.some(({ status }) => status === 'error' || status === 'conflict')) {
    throw new Error('Runtime tooling bridge could not safely remove one or more owned links.')
  }

  const newlyLinked: Array<{ source: string; target: string }> = []
  const rollbackNewLinks = () => {
    for (const { source, target } of newlyLinked) {
      try {
        if (hasSafeRuntimeParents(runtimeHome, target)) removeExpectedLink(target, source)
      } catch {
        // The generic caller error avoids logging a sensitive host path.
      }
    }
  }

  for (const projection of projections) {
    if (!consent.categories[projection.category]) continue
    const paths = projectionPaths(projection, realHome, runtimeHome)
    if (!paths) {
      results.push({ projectionId: projection.id, category: projection.category, status: 'error' })
      continue
    }
    if (!sourceIsFile(paths.source)) {
      results.push({ projectionId: projection.id, category: projection.category, status: 'source-missing' })
      continue
    }
    if (!hasSafeRuntimeParents(runtimeHome, paths.target)) {
      results.push({ projectionId: projection.id, category: projection.category, status: 'conflict' })
      continue
    }
    const linkedTarget = normalizeLinkedTarget(paths.target)
    if (previousById.has(projection.id) && linkedTarget === paths.source) {
      retainedEntries.push({
        id: projection.id,
        category: projection.category,
        sourceRelativePath: projection.sourceRelativePath,
        runtimeDestination: projection.runtimeDestination,
      })
      results.push({ projectionId: projection.id, category: projection.category, status: 'unchanged' })
      continue
    }
    if (linkedTarget || pathExistsWithoutFollowing(paths.target)) {
      results.push({ projectionId: projection.id, category: projection.category, status: 'conflict' })
      continue
    }
    try {
      linkProjection(runtimeHome, paths.source, paths.target)
      newlyLinked.push(paths)
      retainedEntries.push({
        id: projection.id,
        category: projection.category,
        sourceRelativePath: projection.sourceRelativePath,
        runtimeDestination: projection.runtimeDestination,
      })
      results.push({ projectionId: projection.id, category: projection.category, status: 'linked' })
    } catch {
      results.push({ projectionId: projection.id, category: projection.category, status: 'error' })
    }
  }

  if (results.some(({ status }) => status === 'error' || status === 'conflict')) {
    rollbackNewLinks()
    throw new Error('Runtime tooling bridge could not safely grant one or more projections.')
  }

  try {
    writeManifest(runtimeHome, retainedEntries)
  } catch {
    // Without a durable ownership record later cleanup cannot prove a link is
    // ours. Roll back only links created during this reconciliation.
    rollbackNewLinks()
    throw new Error('Runtime tooling bridge could not persist its ownership record.')
  }

  return results
}
