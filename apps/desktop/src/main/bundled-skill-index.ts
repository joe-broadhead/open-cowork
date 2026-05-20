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
  rootsKey: string
  treeKey: string
  index: Map<string, BundledSkillIndexEntry>
}

type BundledSkillRoot = {
  requestedRoot: string
  realRoot: string
}

type BundledSkillRootScan = {
  entries: BundledSkillIndexEntry[]
  treeKey: string
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

function resolveBundledSkillRoot(root: string): BundledSkillRoot | null {
  const requestedRoot = resolve(root)
  if (!existsSync(requestedRoot)) return null

  try {
    const realRoot = realpathSync.native(requestedRoot)
    if (!statSync(realRoot).isDirectory()) return null
    return { requestedRoot, realRoot }
  } catch {
    return null
  }
}

function isSafeDirectoryInsideRoot(root: BundledSkillRoot, candidate: string) {
  const absoluteCandidate = resolve(candidate)
  if (!isInsideRoot(root.requestedRoot, absoluteCandidate)) return false
  if (!existsSync(absoluteCandidate)) return false

  try {
    if (lstatSync(absoluteCandidate).isSymbolicLink()) return false
    const realCandidate = realpathSync.native(absoluteCandidate)
    if (!isInsideRoot(root.realRoot, realCandidate)) return false
    return statSync(realCandidate).isDirectory()
  } catch {
    return false
  }
}

function isSafeSkillDefinition(root: BundledSkillRoot, skillPath: string) {
  const absoluteSkillPath = resolve(skillPath)
  if (!isInsideRoot(root.requestedRoot, absoluteSkillPath)) return false
  if (!existsSync(absoluteSkillPath)) return false

  try {
    if (lstatSync(absoluteSkillPath).isSymbolicLink()) return false
    const realSkillPath = realpathSync.native(absoluteSkillPath)
    if (!isInsideRoot(root.realRoot, realSkillPath)) return false
    return statSync(realSkillPath).isFile()
  } catch {
    return false
  }
}

function statsSignature(kind: 'dir' | 'file' | 'root', root: BundledSkillRoot, path: string) {
  try {
    const realPath = realpathSync.native(path)
    const stats = statSync(realPath)
    const relativePath = relative(root.realRoot, realPath) || '.'
    return `${kind}:${relativePath}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}`
  } catch {
    return `${kind}:missing:${path}`
  }
}

function cacheRootsKey(roots: string[]) {
  return roots.map((root) => resolve(root)).join('|')
}

function entrySortKey(entry: BundledSkillIndexEntry) {
  return `${entry.depth.toString().padStart(6, '0')}:${entry.skillDir}`
}

function shouldReplaceEntry(existing: BundledSkillIndexEntry | undefined, next: BundledSkillIndexEntry) {
  if (!existing) return true
  return entrySortKey(next).localeCompare(entrySortKey(existing)) < 0
}

function scanBundledSkillRoot(root: string): BundledSkillRootScan {
  const resolvedRoot = resolveBundledSkillRoot(root)
  if (!resolvedRoot) return { entries: [], treeKey: `${resolve(root)}:missing` }

  const entries: BundledSkillIndexEntry[] = []
  const signatureParts = [
    `root:${resolvedRoot.requestedRoot}:${resolvedRoot.realRoot}`,
    statsSignature('root', resolvedRoot, resolvedRoot.realRoot),
  ]
  const queue = [resolvedRoot.requestedRoot]
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
    signatureParts.push(statsSignature('dir', resolvedRoot, realCurrent))

    let children
    try {
      children = readdirSync(current).sort((a, b) => a.localeCompare(b))
    } catch {
      continue
    }
    signatureParts.push(`children:${relative(resolvedRoot.realRoot, realCurrent) || '.'}:${children.join('\u0000')}`)

    for (const child of children) {
      const candidate = join(current, child)
      if (!isSafeDirectoryInsideRoot(resolvedRoot, candidate)) continue

      const skillPath = join(candidate, 'SKILL.md')
      if (isSafeSkillDefinition(resolvedRoot, skillPath)) {
        const relativePath = relative(resolvedRoot.requestedRoot, candidate)
        const depth = relativePath ? relativePath.split(/[\\/]/).length : 0
        signatureParts.push(statsSignature('file', resolvedRoot, skillPath))
        entries.push({
          name: basename(candidate),
          root: resolvedRoot.requestedRoot,
          skillDir: candidate,
          skillPath,
          depth,
        })
      }

      queue.push(candidate)
    }
  }

  return { entries, treeKey: signatureParts.join('|') }
}

export function clearBundledSkillIndexCache() {
  cachedIndex = null
}

export function buildBundledSkillIndex(roots: string[]) {
  const index = new Map<string, BundledSkillIndexEntry>()

  for (const root of roots.map((entry) => resolve(entry))) {
    const rootEntries = new Map<string, BundledSkillIndexEntry>()
    for (const entry of scanBundledSkillRoot(root).entries) {
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
  const rootsKey = cacheRootsKey(roots)
  const scans = roots.map((root) => scanBundledSkillRoot(root))
  const treeKey = scans.map((scan) => scan.treeKey).join('||')
  if (cachedIndex?.rootsKey === rootsKey && cachedIndex.treeKey === treeKey) return cachedIndex.index

  const index = new Map<string, BundledSkillIndexEntry>()
  for (const scan of scans) {
    const rootEntries = new Map<string, BundledSkillIndexEntry>()
    for (const entry of scan.entries) {
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
  cachedIndex = { rootsKey, treeKey, index }
  return index
}

export function findBundledSkillDirInRoot(root: string, skillName: string) {
  return buildBundledSkillIndex([root]).get(skillName)?.skillDir || null
}
