import { writeFileAtomic, readFileCheckedSync } from '@open-cowork/shared/node'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { log } from '@open-cowork/shared/node'

const MANAGED_SKILL_MIRROR_REGISTRY = '.open-cowork-managed-skills.json'
const MANAGED_SKILL_MIRROR_SCHEMA_VERSION = 1
const MANAGED_SKILL_MIRROR_REGISTRY_KEYS = new Set(['schemaVersion', 'updatedAt', 'skills'])
const MANAGED_SKILL_MIRROR_ENTRY_KEYS = new Set(['name', 'fingerprint'])

type ManagedSkillMirrorRegistry = {
  schemaVersion: typeof MANAGED_SKILL_MIRROR_SCHEMA_VERSION
  updatedAt: string
  skills: Array<{
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

function hasExactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>) {
  const actual = Object.keys(value)
  return actual.length === keys.size && actual.every((key) => keys.has(key))
}

function readManagedSkillMirrorRegistry(root: string): ManagedSkillMirrorRegistry | null {
  try {
    const parsed = JSON.parse(readFileSync(registryPath(root), 'utf-8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const raw = parsed as Record<string, unknown>
    if (
      !hasExactKeys(raw, MANAGED_SKILL_MIRROR_REGISTRY_KEYS)
      || raw.schemaVersion !== MANAGED_SKILL_MIRROR_SCHEMA_VERSION
      || typeof raw.updatedAt !== 'string'
      || !raw.updatedAt.trim()
      || !Array.isArray(raw.skills)
      || raw.skills.some((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return true
        const skill = entry as Record<string, unknown>
        return !hasExactKeys(skill, MANAGED_SKILL_MIRROR_ENTRY_KEYS)
          || typeof skill.name !== 'string'
          || !skill.name.trim()
          || typeof skill.fingerprint !== 'string'
          || !skill.fingerprint.trim()
      })
    ) return null

    return {
      schemaVersion: MANAGED_SKILL_MIRROR_SCHEMA_VERSION,
      updatedAt: raw.updatedAt,
      skills: (raw.skills as Array<{ name: string; fingerprint: string }>)
        .map((entry) => ({ name: entry.name.trim(), fingerprint: entry.fingerprint.trim() }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }
  } catch {
    return null
  }
}

export function readCurrentManagedSkillMirrorNames(root: string): Set<string> {
  const registry = readManagedSkillMirrorRegistry(root)
  if (!registry?.skills?.length) return new Set()

  const names = new Set<string>()
  for (const skill of registry.skills) {
    const currentFingerprint = fingerprintDirectory(join(root, skill.name))
    if (currentFingerprint && currentFingerprint === skill.fingerprint) {
      names.add(skill.name)
    }
  }
  return names
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
      hash.update(readFileCheckedSync(path).bytes)
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
}) {
  const { discoverableSkillsDir, previousManagedSkillsDir, configuredSkillNames } = input
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
    const currentFingerprint = registryFingerprints.has(entry.name)
      ? fingerprintDirectory(skillRoot)
      : null
    const generatedByRegistry = Boolean(
      currentFingerprint
      && registryFingerprints.get(entry.name) === currentFingerprint,
    )
    const generatedByPreviousMirror = existsSync(previousManagedRoot)
      && directoriesHaveSameContent(previousManagedRoot, skillRoot)

    if (!generatedByRegistry && !generatedByPreviousMirror) {
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
