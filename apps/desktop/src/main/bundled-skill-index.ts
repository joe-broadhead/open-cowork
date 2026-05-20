import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'fs'
import { basename, isAbsolute, join, relative, resolve } from 'path'

export type BundledSkillIndexEntry = {
  name: string
  root: string
  skillDir: string
  skillPath: string
  depth: number
}

type CachedBundledSkillIndex = {
  key: string
  index: Map<string, BundledSkillIndexEntry>
}

let cachedIndex: CachedBundledSkillIndex | null = null

function isInsideRoot(root: string, candidate: string) {
  const relativePath = relative(root, candidate)
  const firstSegment = relativePath.split(/[\\/]/, 1)[0]
  return relativePath === '' || (
    Boolean(relativePath)
    && firstSegment !== '..'
    && !isAbsolute(relativePath)
  )
}

function isSafeDirectoryInsideRoot(root: string, candidate: string) {
  const absoluteRoot = resolve(root)
  const absoluteCandidate = resolve(candidate)
  if (!isInsideRoot(absoluteRoot, absoluteCandidate)) return false
  if (!existsSync(absoluteCandidate)) return false

  try {
    if (lstatSync(absoluteCandidate).isSymbolicLink()) return false
    const realRoot = realpathSync.native(absoluteRoot)
    const realCandidate = realpathSync.native(absoluteCandidate)
    if (!isInsideRoot(realRoot, realCandidate)) return false
    return statSync(realCandidate).isDirectory()
  } catch {
    return false
  }
}

function isSafeSkillDefinition(root: string, skillPath: string) {
  const absoluteRoot = resolve(root)
  const absoluteSkillPath = resolve(skillPath)
  if (!isInsideRoot(absoluteRoot, absoluteSkillPath)) return false
  if (!existsSync(absoluteSkillPath)) return false

  try {
    if (lstatSync(absoluteSkillPath).isSymbolicLink()) return false
    const realRoot = realpathSync.native(absoluteRoot)
    const realSkillPath = realpathSync.native(absoluteSkillPath)
    if (!isInsideRoot(realRoot, realSkillPath)) return false
    return statSync(realSkillPath).isFile()
  } catch {
    return false
  }
}

function rootSignature(root: string) {
  const resolvedRoot = resolve(root)
  try {
    const stats = statSync(resolvedRoot)
    return `${resolvedRoot}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}`
  } catch {
    return `${resolvedRoot}:missing`
  }
}

function cacheKeyForRoots(roots: string[]) {
  return roots.map(rootSignature).join('|')
}

function entrySortKey(entry: BundledSkillIndexEntry) {
  return `${entry.depth.toString().padStart(6, '0')}:${entry.skillDir}`
}

function shouldReplaceEntry(existing: BundledSkillIndexEntry | undefined, next: BundledSkillIndexEntry) {
  if (!existing) return true
  return entrySortKey(next).localeCompare(entrySortKey(existing)) < 0
}

function scanBundledSkillRoot(root: string) {
  const absoluteRoot = resolve(root)
  if (!isSafeDirectoryInsideRoot(absoluteRoot, absoluteRoot)) return []

  const entries: BundledSkillIndexEntry[] = []
  const queue = [absoluteRoot]
  const visited = new Set<string>()

  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const current = queue[queueIndex]

    let realCurrent: string
    try {
      realCurrent = realpathSync.native(current)
    } catch {
      continue
    }
    if (visited.has(realCurrent)) continue
    visited.add(realCurrent)

    let children
    try {
      children = readdirSync(current).sort((a, b) => a.localeCompare(b))
    } catch {
      continue
    }

    for (const child of children) {
      const candidate = join(current, child)
      if (!isSafeDirectoryInsideRoot(absoluteRoot, candidate)) continue

      const skillPath = join(candidate, 'SKILL.md')
      if (isSafeSkillDefinition(absoluteRoot, skillPath)) {
        const relativePath = relative(absoluteRoot, candidate)
        const depth = relativePath ? relativePath.split(/[\\/]/).length : 0
        entries.push({
          name: basename(candidate),
          root: absoluteRoot,
          skillDir: candidate,
          skillPath,
          depth,
        })
      }

      queue.push(candidate)
    }
  }

  return entries
}

export function clearBundledSkillIndexCache() {
  cachedIndex = null
}

export function buildBundledSkillIndex(roots: string[]) {
  const index = new Map<string, BundledSkillIndexEntry>()

  for (const root of roots.map((entry) => resolve(entry))) {
    const rootEntries = new Map<string, BundledSkillIndexEntry>()
    for (const entry of scanBundledSkillRoot(root)) {
      if (shouldReplaceEntry(rootEntries.get(entry.name), entry)) {
        rootEntries.set(entry.name, entry)
      }
    }

    for (const [name, entry] of rootEntries.entries()) {
      if (!index.has(name)) {
        index.set(name, entry)
      }
    }
  }

  return index
}

export function getBundledSkillIndex(roots: string[]) {
  const key = cacheKeyForRoots(roots)
  if (cachedIndex?.key === key) return cachedIndex.index

  const index = buildBundledSkillIndex(roots)
  cachedIndex = { key, index }
  return index
}

export function findBundledSkillDirInRoot(root: string, skillName: string) {
  return buildBundledSkillIndex([root]).get(skillName)?.skillDir || null
}
