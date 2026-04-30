import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'fs'
import { dirname, isAbsolute, join, relative, resolve } from 'path'
import type { CapabilitySkillBundle, RuntimeContextOptions } from '@open-cowork/shared'
import { getConfiguredSkillsFromConfig } from './config-loader.ts'
import { getCustomSkill, listCustomSkills } from './native-customizations.ts'
import type { NativeConfigScope } from './runtime-paths.ts'
import { findBundledSkillDir as findBundledSkillDirInRoot, getBundledSkillRoots } from './runtime-content.ts'
import { log } from './logger.ts'
import { validateOpenCodeSkillBundle } from './skill-bundle-validation.ts'

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

function extractFrontmatterField(content: string, field: string) {
  const match = content.match(new RegExp(`^---\\n[\\s\\S]*?\\n${field}:\\s*["']?(.+?)["']?\\s*(?:\\n|$)`, 'm'))
  return match?.[1]?.trim() || null
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

// Walks every configured bundle root (downstream `skills/`, upstream
// `skills/`, packaged resources) and recursively searches for a
// directory named `skillName` containing a `SKILL.md`. Downstream
// distributions commonly nest skills one level deep
// (`skills/<product>/<skill-name>/SKILL.md`) — a shallow join would
// miss those and the Capabilities UI would render an empty bundle.
function findBundledSkillDir(skillName: string) {
  const roots = getBundledSkillRoots()
  for (const root of roots) {
    const hit = findBundledSkillDirInRoot(root, skillName)
    if (hit) return hit
  }
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

export function listEffectiveSkillsSync(context?: RuntimeContextOptions): EffectiveSkillDefinition[] {
  const configuredSkills = buildConfiguredSkillMap()
  const managedCustomSkills = new Map(
    listCustomSkills(context).map((skill) => [skill.name, skill] as const),
  )
  const skills = new Map<string, EffectiveSkillDefinition>()

  for (const [skillName, configured] of configuredSkills.entries()) {
    const bundledDir = findBundledSkillDir(skillName)
    const bundledSkillPath = bundledDir ? join(bundledDir, 'SKILL.md') : null
    const content = bundledSkillPath && existsSync(bundledSkillPath)
      ? readFileSync(bundledSkillPath, 'utf-8')
      : null
    if (!content) {
      log('capability', `Configured skill ${skillName} is not present in the bundled runtime roots and will not be advertised to agents.`)
      continue
    }
    const issues = validateOpenCodeSkillBundle({ name: skillName, content })
    if (issues.length > 0) {
      logSkippedSkill(skillName, 'builtin', issues)
      continue
    }

    skills.set(skillName, {
      name: skillName,
      label: configured.name,
      description: extractFrontmatterField(content || '', 'description') || configured.description,
      source: 'builtin',
      origin: 'open-cowork',
      scope: null,
      location: bundledSkillPath ? resolve(bundledSkillPath) : null,
      toolIds: configured.toolIds ? [...configured.toolIds] : undefined,
      content,
    })
  }

  for (const managed of managedCustomSkills.values()) {
    if (skills.has(managed.name)) continue
    const issues = validateOpenCodeSkillBundle({ name: managed.name, content: managed.content })
    if (issues.length > 0) {
      logSkippedSkill(managed.name, 'custom', issues)
      continue
    }

    skills.set(managed.name, {
      name: managed.name,
      label: extractFrontmatterField(managed.content, 'title')
        || extractFrontmatterField(managed.content, 'name')
        || humanize(managed.name),
      description: extractFrontmatterField(managed.content, 'description') || 'Custom skill',
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

  return Array.from(skills.values()).sort((a, b) => a.label.localeCompare(b.label))
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

  const effectiveSkill = listEffectiveSkillsSync(context).find((skill) => skill.name === skillName) || null
  if (!effectiveSkill) return null

  const location = effectiveSkill.location
  const root = location
    ? (location.endsWith('SKILL.md') ? dirname(location) : location)
    : findBundledSkillDir(skillName)
  const skillPath = root ? resolveBundleFilePath(root, 'SKILL.md') : null

  return {
    name: effectiveSkill.name,
    source: effectiveSkill.source,
    origin: effectiveSkill.origin,
    scope: effectiveSkill.scope,
    location,
    content: effectiveSkill.content || (skillPath && existsSync(skillPath) ? readFileSync(skillPath, 'utf-8') : null),
    files: root
      ? listBundleFiles(root)
        .map((file) => {
          const resolved = resolveBundleFilePath(root, file.path)
          return resolved
            ? {
                path: file.path,
                content: readFileSync(resolved, 'utf-8'),
              }
            : null
        })
        .filter((file): file is { path: string; content: string } => Boolean(file))
      : [],
  }
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

  const root = findBundledSkillDir(skillName)
  if (!root) return null

  const candidate = resolveBundleFilePath(root, filePath)
  if (!candidate) return null
  try {
    return readFileSync(candidate, 'utf-8')
  } catch {
    return null
  }
}
