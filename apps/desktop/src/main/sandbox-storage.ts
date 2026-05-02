import { existsSync, lstatSync, readdirSync, realpathSync, rmSync, statSync } from 'fs'
import { isAbsolute, join, relative, resolve } from 'path'
import type { SandboxCleanupResult, SandboxStorageStats } from '@open-cowork/shared'
import { listSessionRecords, type SessionRecord } from './session-registry.ts'
import { DEFAULT_SANDBOX_RETENTION_DAYS, getSandboxRootDir, isSandboxWorkspaceDir } from './runtime-paths.ts'

function directorySize(path: string): number {
  let stats
  try {
    stats = lstatSync(path)
  } catch {
    return 0
  }

  if (stats.isSymbolicLink()) return 0
  if (stats.isFile()) return stats.size
  if (!stats.isDirectory()) return 0

  let total = 0
  for (const name of readdirSync(path)) {
    total += directorySize(join(path, name))
  }
  return total
}

function isInsideRoot(root: string, candidate: string) {
  const relativePath = relative(root, candidate)
  const firstSegment = relativePath.split(/[\\/]/, 1)[0]
  return relativePath === '' || (
    Boolean(relativePath)
    && firstSegment !== '..'
    && !isAbsolute(relativePath)
  )
}

function realpathOrNull(path: string) {
  try {
    return realpathSync.native(path)
  } catch {
    return null
  }
}

function isRemovableSandboxDirectory(root: string, directory: string) {
  const normalizedRoot = resolve(root)
  const normalizedDirectory = resolve(directory)
  if (!isInsideRoot(normalizedRoot, normalizedDirectory)) return false
  if (!isSandboxWorkspaceDir(normalizedDirectory)) return false

  try {
    const stats = lstatSync(normalizedDirectory)
    if (stats.isSymbolicLink() || !stats.isDirectory()) return false
  } catch {
    return false
  }

  const realRoot = realpathOrNull(normalizedRoot)
  const realDirectory = realpathOrNull(normalizedDirectory)
  if (!realRoot || !realDirectory) return false
  return isInsideRoot(realRoot, realDirectory)
}

function listSandboxWorkspaceDirectories() {
  const root = resolve(getSandboxRootDir())
  if (!existsSync(root)) {
    return { root, directories: [] as string[] }
  }

  const directories = readdirSync(root)
    .map((name) => join(root, name))
    .filter((path) => isRemovableSandboxDirectory(root, path))

  return { root, directories }
}

function referencedSandboxDirectories(excludingSessionId?: string | null) {
  const referenced = new Set<string>()
  for (const record of listSessionRecords()) {
    if (excludingSessionId && record.id === excludingSessionId) continue
    const directory = resolve(record.opencodeDirectory)
    if (isSandboxWorkspaceDir(directory)) {
      referenced.add(directory)
    }
  }
  return referenced
}

function staleCutoffMs(retentionDays = DEFAULT_SANDBOX_RETENTION_DAYS) {
  return Date.now() - retentionDays * 24 * 60 * 60 * 1000
}

function staleWorkspace(directory: string, retentionDays = DEFAULT_SANDBOX_RETENTION_DAYS) {
  try {
    return statSync(directory).mtimeMs < staleCutoffMs(retentionDays)
  } catch {
    return false
  }
}

export function getSandboxStorageStats(): SandboxStorageStats {
  const { root, directories } = listSandboxWorkspaceDirectories()
  const referenced = referencedSandboxDirectories()

  let totalBytes = 0
  let referencedWorkspaceCount = 0
  let unreferencedWorkspaceCount = 0
  let staleWorkspaceCount = 0

  for (const directory of directories) {
    totalBytes += directorySize(directory)
    if (referenced.has(resolve(directory))) {
      referencedWorkspaceCount += 1
    } else {
      unreferencedWorkspaceCount += 1
      if (staleWorkspace(directory)) staleWorkspaceCount += 1
    }
  }

  return {
    root,
    totalBytes,
    workspaceCount: directories.length,
    referencedWorkspaceCount,
    unreferencedWorkspaceCount,
    staleWorkspaceCount,
    staleThresholdDays: DEFAULT_SANDBOX_RETENTION_DAYS,
  }
}

export function cleanupSandboxStorage(mode: SandboxCleanupResult['mode']): SandboxCleanupResult {
  const { directories } = listSandboxWorkspaceDirectories()
  const referenced = referencedSandboxDirectories()

  let removedWorkspaces = 0
  let removedBytes = 0

  for (const directory of directories) {
    const normalized = resolve(directory)
    if (referenced.has(normalized)) continue
    if (mode === 'old-unreferenced' && !staleWorkspace(directory)) continue
    if (!isRemovableSandboxDirectory(getSandboxRootDir(), directory)) continue

    const bytes = directorySize(directory)
    rmSync(directory, { recursive: true, force: true })
    removedWorkspaces += 1
    removedBytes += bytes
  }

  return {
    mode,
    removedWorkspaces,
    removedBytes,
  }
}

export function cleanupSandboxWorkspaceForSession(record: SessionRecord | null) {
  if (!record) return false
  const directory = resolve(record.opencodeDirectory)
  if (!isSandboxWorkspaceDir(directory)) return false
  if (!isRemovableSandboxDirectory(getSandboxRootDir(), directory)) return false

  const referencedElsewhere = referencedSandboxDirectories(record.id)
  if (referencedElsewhere.has(directory)) return false

  rmSync(directory, { recursive: true, force: true })
  return true
}

export function pruneOldUnreferencedSandboxStorage() {
  return cleanupSandboxStorage('old-unreferenced')
}
