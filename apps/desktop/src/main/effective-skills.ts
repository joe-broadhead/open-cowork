import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { dirname, join, relative, resolve } from 'path'
import type { CapabilitySkillBundle, RuntimeContextOptions } from '@open-cowork/shared'
import { getConfiguredSkillsFromConfig } from './config-loader.ts'
import { getCustomSkill, listCustomSkills } from './native-customizations.ts'
import type { NativeConfigScope } from './runtime-paths.ts'
import { getBundledSkillRoots } from './runtime-content.ts'

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

function listBundleFiles(root: string, current = root): Array<{ path: string }> {
  const files: Array<{ path: string }> = []
  if (!existsSync(current)) return files

  for (const entry of readdirSync(current)) {
    const fullPath = join(current, entry)
    let stats
    try {
      stats = statSync(fullPath)
    } catch {
      continue
    }

    if (stats.isDirectory()) {
      files.push(...listBundleFiles(root, fullPath))
      continue
    }

    const filePath = relative(root, fullPath).replace(/\\/g, '/')
    if (filePath === 'SKILL.md') continue
    files.push({ path: filePath })
  }

  return files.sort((a, b) => a.path.localeCompare(b.path))
}

function findBundledSkillDir(skillName: string) {
  for (const root of getBundledSkillRoots()) {
    const direct = join(root, skillName)
    if (existsSync(join(direct, 'SKILL.md'))) return direct
  }
  return null
}

function buildConfiguredSkillMap() {
  return new Map(
    getConfiguredSkillsFromConfig().map((skill) => [skill.sourceName, skill] as const),
  )
}

export async function listEffectiveSkills(context?: RuntimeContextOptions): Promise<EffectiveSkillDefinition[]> {
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

export async function getEffectiveSkillBundle(
  skillName: string,
  context?: RuntimeContextOptions,
): Promise<CapabilitySkillBundle | null> {
  const managed = getCustomSkill(skillName, context)
  if (managed) {
    return {
      name: managed.name,
      source: 'custom',
      origin: 'custom',
      scope: managed.scope,
      location: null,
      content: managed.content,
      files: (managed.files || []).map((file) => ({ path: file.path })),
    }
  }

  const effectiveSkill = (await listEffectiveSkills(context)).find((skill) => skill.name === skillName) || null
  if (!effectiveSkill) return null

  const location = effectiveSkill.location
  const root = location
    ? (location.endsWith('SKILL.md') ? dirname(location) : location)
    : findBundledSkillDir(skillName)
  const skillPath = location && location.endsWith('SKILL.md')
    ? location
    : root
      ? join(root, 'SKILL.md')
      : null

  return {
    name: effectiveSkill.name,
    source: effectiveSkill.source,
    origin: effectiveSkill.origin,
    scope: effectiveSkill.scope,
    location,
    content: effectiveSkill.content || (skillPath && existsSync(skillPath) ? readFileSync(skillPath, 'utf-8') : null),
    files: root ? listBundleFiles(root) : [],
  }
}
