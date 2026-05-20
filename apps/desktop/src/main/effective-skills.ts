import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'fs'
import { isAbsolute, join, relative, resolve } from 'path'
import {
  extractSkillFrontmatterField,
  type CapabilitySkillBundle,
  type RuntimeContextOptions,
} from '@open-cowork/shared'
import { getConfiguredSkillsFromConfig } from './config-loader.ts'
import { getCustomSkill, listCustomSkills } from './native-customizations.ts'
import type { NativeConfigScope } from './runtime-paths.ts'
import { getBundledSkillRoots } from './runtime-content.ts'
import { getBundledSkillIndex, type BundledSkillIndexEntry } from './bundled-skill-index.ts'
import { log } from './logger.ts'
import { validateOpenCodeSkillBundle } from './skill-bundle-validation.ts'
import { measurePerf } from './perf-metrics.ts'

export type EffectiveSkillDefinition = {
  name: string
  label: string
  description: string
  source: 'builtin' | 'custom'
  origin: 'open-cowork' | 'custom'
  scope: NativeConfigScope | null
  location: string | null
  toolIds?: string[]
  content: string | null
}

export type EffectiveSkillBundle = Omit<CapabilitySkillBundle, 'files'> & {
  files: Array<{ path: string; content?: string }>
}

type ConfiguredSkill = ReturnType<typeof getConfiguredSkillsFromConfig>[number]

function logSkippedSkill(name: string, source: 'builtin' | 'custom', issues: string[]) {
  if (issues.length === 0) return
  log('capability', `Skipping ${source} skill ${name}: ${issues.join(' ')}`)
}

function humanize(value: string) {
  return value
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
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

function resolveBundleFilePath(root: string, filePath: string) {
  if (!filePath || isAbsolute(filePath)) return null

  const absoluteRoot = resolve(root)
  const candidate = resolve(absoluteRoot, filePath)
  if (!isInsideRoot(absoluteRoot, candidate)) return null
  if (!existsSync(candidate)) return null

  try {
    if (lstatSync(candidate).isSymbolicLink()) return null
    const realRoot = realpathSync.native(absoluteRoot)
    const realCandidate = realpathSync.native(candidate)
    if (!isInsideRoot(realRoot, realCandidate)) return null
    if (!statSync(realCandidate).isFile()) return null
    return realCandidate
  } catch {
    return null
  }
}

function listBundleFiles(root: string, current = root): Array<{ path: string }> {
  const files: Array<{ path: string }> = []
  if (!existsSync(current)) return files

  for (const entry of readdirSync(current)) {
    const fullPath = join(current, entry)
    let stats
    try {
      stats = lstatSync(fullPath)
    } catch {
      continue
    }
    if (stats.isSymbolicLink()) continue

    if (stats.isDirectory()) {
      files.push(...listBundleFiles(root, fullPath))
      continue
    }

    const filePath = relative(root, fullPath).replace(/\\/g, '/')
    if (filePath === 'SKILL.md') continue
    if (!resolveBundleFilePath(root, filePath)) continue
    files.push({ path: filePath })
  }

  return files.sort((a, b) => a.path.localeCompare(b.path))
}

function findBundledSkillEntry(skillName: string) {
  const roots = getBundledSkillRoots()
  const entry = getBundledSkillIndex(roots).get(skillName) || null
  if (entry) return entry
  // Diagnostic — fires every time the Capabilities UI opens a skill
  // with no resolvable bundle. Prints the roots it actually searched so
  // downstream packaging issues (wrong `OPEN_COWORK_DOWNSTREAM_ROOT`,
  // missing `skills/` mount, typo in `sourceName`) are visible.
  log('capability', `skill=${skillName} not found in roots: ${roots.join(', ')}`)
  return null
}

function buildConfiguredSkillMap() {
  return new Map(
    getConfiguredSkillsFromConfig().map((skill) => [skill.sourceName, skill] as const),
  )
}

function readBundledSkillContent(entry: BundledSkillIndexEntry) {
  try {
    return readFileSync(entry.skillPath, 'utf-8')
  } catch {
    return null
  }
}

function buildBundledSkillDefinition(
  skillName: string,
  configured: ConfiguredSkill,
  entry: BundledSkillIndexEntry | null,
) {
  if (!entry) {
    log('capability', `Configured skill ${skillName} is not present in the bundled runtime roots and will not be advertised to agents.`)
    return null
  }
  const content = readBundledSkillContent(entry)
  if (!content) {
    log('capability', `Configured skill ${skillName} is not present in the bundled runtime roots and will not be advertised to agents.`)
    return null
  }

  const issues = validateOpenCodeSkillBundle({ name: skillName, content })
  if (issues.length > 0) {
    logSkippedSkill(skillName, 'builtin', issues)
    return null
  }

  return {
    name: skillName,
    label: configured.name,
    description: extractSkillFrontmatterField(content, 'description') || configured.description,
    source: 'builtin' as const,
    origin: 'open-cowork' as const,
    scope: null,
    location: resolve(entry.skillPath),
    toolIds: configured.toolIds ? [...configured.toolIds] : undefined,
    content,
  } satisfies EffectiveSkillDefinition
}

function readBundledSkillBundle(
  skill: EffectiveSkillDefinition,
  entry: BundledSkillIndexEntry,
): EffectiveSkillBundle {
  return {
    name: skill.name,
    source: skill.source,
    origin: skill.origin,
    scope: skill.scope,
    location: skill.location,
    content: skill.content,
    files: listBundleFiles(entry.skillDir)
      .map((file) => {
        const resolved = resolveBundleFilePath(entry.skillDir, file.path)
        return resolved
          ? {
              path: file.path,
              content: readFileSync(resolved, 'utf-8'),
            }
          : null
      })
      .filter((file): file is { path: string; content: string } => Boolean(file)),
  }
}

export function listEffectiveSkillsSync(context?: RuntimeContextOptions): EffectiveSkillDefinition[] {
  return measurePerf('skills.effective.list', () => {
    const configuredSkills = buildConfiguredSkillMap()
    const managedCustomSkills = new Map(
      listCustomSkills(context).map((skill) => [skill.name, skill] as const),
    )
    const bundledSkillIndex = getBundledSkillIndex(getBundledSkillRoots())
    const skills = new Map<string, EffectiveSkillDefinition>()

    for (const managed of managedCustomSkills.values()) {
      const issues = validateOpenCodeSkillBundle({ name: managed.name, content: managed.content })
      if (issues.length > 0) {
        logSkippedSkill(managed.name, 'custom', issues)
        continue
      }

      skills.set(managed.name, {
        name: managed.name,
        label: extractSkillFrontmatterField(managed.content, 'title')
          || extractSkillFrontmatterField(managed.content, 'name')
          || humanize(managed.name),
        description: extractSkillFrontmatterField(managed.content, 'description') || 'Custom skill',
        source: 'custom',
        origin: 'custom',
        scope: managed.scope,
        location: null,
        // Surface the toolIds the custom skill declared in its frontmatter
        // so the agent builder's "skill needs these tools" auto-attach hint
        // works for custom skills too, not just upstream-configured ones.
        toolIds: managed.toolIds?.length ? [...managed.toolIds] : undefined,
        content: managed.content,
      })
    }

    for (const [skillName, configured] of configuredSkills.entries()) {
      if (skills.has(skillName)) continue
      const skill = buildBundledSkillDefinition(skillName, configured, bundledSkillIndex.get(skillName) || null)
      if (skill) skills.set(skillName, skill)
    }

    return Array.from(skills.values()).sort((a, b) => a.label.localeCompare(b.label))
  }, {
    slowThresholdMs: 100,
    slowData: { context: context?.directory ? 'project' : 'global' },
  })
}

export async function listEffectiveSkills(context?: RuntimeContextOptions): Promise<EffectiveSkillDefinition[]> {
  return listEffectiveSkillsSync(context)
}

export async function getEffectiveSkillBundle(
  skillName: string,
  context?: RuntimeContextOptions,
): Promise<EffectiveSkillBundle | null> {
  return getEffectiveSkillBundleSync(skillName, context)
}

export function getEffectiveSkillBundleSync(
  skillName: string,
  context?: RuntimeContextOptions,
): EffectiveSkillBundle | null {
  const managed = getCustomSkill(skillName, context)
  if (managed) {
    return {
      name: managed.name,
      source: 'custom',
      origin: 'custom',
      scope: managed.scope,
      location: null,
      content: managed.content,
      files: (managed.files || []).map((file) => ({ path: file.path, content: file.content })),
    }
  }

  const configured = buildConfiguredSkillMap().get(skillName)
  if (!configured) return null
  const entry = findBundledSkillEntry(skillName)
  const skill = buildBundledSkillDefinition(skillName, configured, entry)
  return skill && entry ? readBundledSkillBundle(skill, entry) : null
}

export function listEffectiveBuiltInSkillBundlesSync(context?: RuntimeContextOptions): EffectiveSkillBundle[] {
  return measurePerf('skills.effective.bundles', () => {
    const configuredSkills = buildConfiguredSkillMap()
    const managedCustomSkillNames = new Set(listCustomSkills(context).map((skill) => skill.name))
    const bundledSkillIndex = getBundledSkillIndex(getBundledSkillRoots())
    const bundles: EffectiveSkillBundle[] = []

    for (const [skillName, configured] of configuredSkills.entries()) {
      if (managedCustomSkillNames.has(skillName)) continue
      const entry = bundledSkillIndex.get(skillName) || null
      const skill = buildBundledSkillDefinition(skillName, configured, entry)
      if (skill && entry) {
        bundles.push(readBundledSkillBundle(skill, entry))
      }
    }

    return bundles.sort((a, b) => a.name.localeCompare(b.name))
  }, {
    slowThresholdMs: 150,
    slowData: { context: context?.directory ? 'project' : 'global' },
  })
}

// Read a single file from a skill bundle on demand. Called by the
// Capabilities UI when the user clicks to expand a referenced file
// (templates, reference docs, example scripts that ship alongside
// SKILL.md). Returning inline content on the bundle listing would
// balloon memory for skills with many / large files; this lazy path
// keeps the initial load cheap.
//
// Path safety: the requested path is resolved against the skill's
// root and rejected if it escapes the bundle (traversal via `..` or
// an absolute path). Symlinks are rejected rather than followed so a
// downstream skill bundle cannot point the Capabilities UI at files
// outside the configured bundle root.
export async function readEffectiveSkillBundleFile(
  skillName: string,
  filePath: string,
  context?: RuntimeContextOptions,
): Promise<string | null> {
  if (!filePath || filePath.trim().length === 0) return null

  const managed = getCustomSkill(skillName, context)
  if (managed) {
    // Custom skills carry their file list in memory already; we can't
    // expand arbitrary content from disk because the custom-skill
    // store may not even surface a filesystem location. Return the
    // content if the file was captured at save time, otherwise null.
    const match = (managed.files || []).find((file) => file.path === filePath)
    return match?.content ?? null
  }

  const root = findBundledSkillEntry(skillName)?.skillDir || null
  if (!root) return null

  const candidate = resolveBundleFilePath(root, filePath)
  if (!candidate) return null
  try {
    return readFileSync(candidate, 'utf-8')
  } catch {
    return null
  }
}
