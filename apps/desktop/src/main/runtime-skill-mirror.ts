import { createHash } from 'crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'fs'
import { join, relative } from 'path'
import { writeFileAtomic } from './fs-atomic.ts'
import { log } from './logger.ts'

const MANAGED_SKILL_MIRROR_REGISTRY = '.open-cowork-managed-skills.json'
const MANAGED_SKILL_MIRROR_SCHEMA_VERSION = 1

type ManagedSkillMirrorRegistry = {
  schemaVersion: number
  updatedAt: string
  skillNames?: string[]
  skills?: Array<{
    name: string
    fingerprint: string
  }>
}

function registryPath(root: string) {
  return join(root, MANAGED_SKILL_MIRROR_REGISTRY)
}

function normalizeSkillNames(value: unknown) {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(
    value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean),
  )).sort((a, b) => a.localeCompare(b))
}

function readManagedSkillMirrorRegistry(root: string): ManagedSkillMirrorRegistry | null {
  try {
    const raw = JSON.parse(readFileSync(registryPath(root), 'utf-8')) as Partial<ManagedSkillMirrorRegistry>
    return {
      schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
      skillNames: normalizeSkillNames(raw.skillNames),
      skills: Array.isArray(raw.skills)
        ? raw.skills
          .filter((entry): entry is { name: string; fingerprint: string } => (
            typeof entry?.name === 'string'
            && entry.name.trim().length > 0
            && typeof entry.fingerprint === 'string'
            && entry.fingerprint.trim().length > 0
          ))
          .map((entry) => ({ name: entry.name.trim(), fingerprint: entry.fingerprint.trim() }))
          .sort((a, b) => a.name.localeCompare(b.name))
        : [],
    }
  } catch {
    return null
  }
}

export function readManagedSkillMirrorNames(root: string): Set<string> {
  const registry = readManagedSkillMirrorRegistry(root)
  if (!registry) {
    return new Set()
  }
  const names = registry.skills?.length
    ? registry.skills.map((skill) => skill.name)
    : registry.skillNames || []
  return new Set(normalizeSkillNames(names))
}

export function writeManagedSkillMirrorNames(root: string, skillNames: string[]) {
  mkdirSync(root, { recursive: true })
  const names = normalizeSkillNames(skillNames)
  const registry: ManagedSkillMirrorRegistry = {
    schemaVersion: MANAGED_SKILL_MIRROR_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    skills: names
      .map((name) => {
        const fingerprint = fingerprintDirectory(join(root, name))
        return fingerprint ? { name, fingerprint } : null
      })
      .filter((entry): entry is { name: string; fingerprint: string } => Boolean(entry)),
  }
  writeFileAtomic(registryPath(root), `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 })
}

function fingerprintDirectory(root: string) {
  if (!existsSync(root)) return null

  try {
    if (!statSync(root).isDirectory()) return null
  } catch {
    return null
  }

  const hash = createHash('sha256')
  let fileCount = 0

  const visit = (current: string): boolean => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return false
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name)
      let stats
      try {
        stats = lstatSync(path)
      } catch {
        return false
      }
      if (stats.isSymbolicLink()) return false
      if (stats.isDirectory()) {
        if (!visit(path)) return false
        continue
      }
      if (!stats.isFile()) continue

      hash.update(relative(root, path).replace(/\\/g, '/'))
      hash.update('\0')
      hash.update(readFileSync(path))
      hash.update('\0')
      fileCount += 1
    }
    return true
  }

  return visit(root) ? `${fileCount}:${hash.digest('hex')}` : null
}

function directoriesHaveSameContent(left: string, right: string) {
  const leftFingerprint = fingerprintDirectory(left)
  if (!leftFingerprint) return false
  return leftFingerprint === fingerprintDirectory(right)
}

export function pruneManagedSkillMirror(input: {
  discoverableSkillsDir: string
  previousManagedSkillsDir: string
  configuredSkillNames: Set<string>
  findBundledSkillSource: (skillName: string) => string | null
}) {
  const { discoverableSkillsDir, previousManagedSkillsDir, configuredSkillNames, findBundledSkillSource } = input
  if (!existsSync(discoverableSkillsDir)) return []

  const registry = readManagedSkillMirrorRegistry(discoverableSkillsDir)
  const registryFingerprints = new Map(
    (registry?.skills || []).map((entry) => [entry.name, entry.fingerprint] as const),
  )
  const pruned: string[] = []

  for (const entry of readdirSync(discoverableSkillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (configuredSkillNames.has(entry.name)) continue

    const skillRoot = join(discoverableSkillsDir, entry.name)
    const previousManagedRoot = join(previousManagedSkillsDir, entry.name)
    const bundledSource = findBundledSkillSource(entry.name)
    const currentFingerprint = registryFingerprints.has(entry.name)
      ? fingerprintDirectory(skillRoot)
      : null
    const generatedByRegistry = Boolean(
      currentFingerprint
      && registryFingerprints.get(entry.name) === currentFingerprint,
    )
    const generatedByPreviousMirror = existsSync(previousManagedRoot)
      && directoriesHaveSameContent(previousManagedRoot, skillRoot)
    const generatedByBundledSource = bundledSource
      ? directoriesHaveSameContent(bundledSource, skillRoot)
      : false

    if (!generatedByRegistry && !generatedByPreviousMirror && !generatedByBundledSource) {
      continue
    }

    rmSync(skillRoot, { recursive: true, force: true })
    pruned.push(entry.name)
  }

  if (pruned.length > 0) {
    log('runtime', `Pruned stale managed skill mirror(s): ${pruned.sort((a, b) => a.localeCompare(b)).join(', ')}`)
  }

  return pruned
}
