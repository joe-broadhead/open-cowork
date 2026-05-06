import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'fs'
import { basename, dirname, join, relative, resolve } from 'path'
import type {
  CustomSkillConfig,
  RuntimeContextOptions,
  ScopedArtifactRef,
} from '@open-cowork/shared'
import { log } from './logger.ts'
import { writeFileAtomic } from './fs-atomic.ts'
import { readTextFileCheckedSync } from './fs-read.ts'
import { resolveProjectDirectory } from './runtime-paths.ts'
import {
  assertValidOpenCodeSkillBundle,
  extractSkillFrontmatterName,
  normalizeSkillBundleName,
  writeSkillNameIntoFrontmatter,
} from './skill-bundle-validation.ts'
import {
  CUSTOM_SKILL_LIMITS,
  assertCustomSkillContent,
  assertCustomSkillFiles,
  textBytes,
} from './custom-content-limits.ts'
import {
  ensureDirectory,
  mergeByName,
  skillsDirForTarget,
  targetDirectory,
} from './custom-store-common.ts'
import type { NativeConfigScope } from './runtime-paths.ts'

type SkillFileReadState = {
  files: Array<{ path: string; content: string }>
  totalBytes: number
}

function isSafeRelativePath(value: string) {
  if (!value.trim()) return false
  if (value.startsWith('/') || value.startsWith('\\')) return false
  return !value.replace(/\\/g, '/').split('/').some((segment) => segment === '..' || segment === '')
}

function listFiles(root: string, current = root, depth = 0, state: SkillFileReadState = { files: [], totalBytes: 0 }): Array<{ path: string; content: string }> {
  let entries
  try {
    entries = readdirSync(current, { withFileTypes: true })
  } catch {
    return state.files
  }

  for (const entry of entries) {
    const fullPath = join(current, entry.name)
    if (entry.isDirectory()) {
      if (depth >= CUSTOM_SKILL_LIMITS.pathDepth) {
        throw new Error(`Skill bundle is nested too deeply under ${relative(root, fullPath).replace(/\\/g, '/')}`)
      }
      listFiles(root, fullPath, depth + 1, state)
      continue
    }
    if (!entry.isFile()) continue

    const filePath = relative(root, fullPath).replace(/\\/g, '/')
    if (filePath === 'SKILL.md') continue
    const fileDepth = filePath.split('/').filter(Boolean).length
    if (fileDepth > CUSTOM_SKILL_LIMITS.pathDepth) {
      throw new Error(`Skill file path is too deep: ${filePath}`)
    }
    if (state.files.length >= CUSTOM_SKILL_LIMITS.fileCount) {
      throw new Error(`Skill bundle has too many supporting files (limit ${CUSTOM_SKILL_LIMITS.fileCount}).`)
    }
    const content = readTextFileCheckedSync(fullPath, { maxBytes: CUSTOM_SKILL_LIMITS.fileBytes }).content
    const bytes = textBytes(content)
    if (bytes > CUSTOM_SKILL_LIMITS.fileBytes) {
      throw new Error(`Skill file ${filePath} is too large (${bytes} bytes; limit ${CUSTOM_SKILL_LIMITS.fileBytes} bytes).`)
    }
    if (state.totalBytes + bytes > CUSTOM_SKILL_LIMITS.totalFileBytes) {
      throw new Error(`Skill bundle supporting files are too large (limit ${CUSTOM_SKILL_LIMITS.totalFileBytes} bytes).`)
    }
    state.totalBytes += bytes
    state.files.push({ path: filePath, content })
  }

  return state.files.sort((a, b) => a.path.localeCompare(b.path))
}

function canonicalizeManagedSkillContent(skillName: string, skillFile: string, rawContent: string) {
  const frontmatterName = extractSkillFrontmatterName(rawContent)?.trim()
  if (!frontmatterName || frontmatterName === skillName) {
    return rawContent
  }

  const canonicalContent = writeSkillNameIntoFrontmatter(rawContent, skillName)
  if (canonicalContent === rawContent) {
    return rawContent
  }

  try {
    writeFileAtomic(skillFile, canonicalContent)
  } catch (error) {
    log(
      'error',
      `Custom skill canonicalization failed for ${skillName}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  return canonicalContent
}

function readScopedSkills(scope: NativeConfigScope, directory?: string | null) {
  const root = ensureDirectory(skillsDirForTarget(scope, directory))
  const entries = readdirSync(root, { withFileTypes: true })
  const skills: CustomSkillConfig[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillRoot = join(root, entry.name)

    const skillFile = join(skillRoot, 'SKILL.md')
    let rawContent: string
    try {
      rawContent = readTextFileCheckedSync(skillFile).content
    } catch {
      continue
    }

    const content = canonicalizeManagedSkillContent(entry.name, skillFile, rawContent)
    const toolIds = parseToolIdsFromFrontmatter(content)

    try {
      skills.push({
        scope,
        directory: scope === 'project' ? targetDirectory(scope, directory) : null,
        name: entry.name,
        content,
        files: listFiles(skillRoot),
        ...(toolIds.length > 0 ? { toolIds } : {}),
      })
    } catch (error) {
      log('warn', `Skipping invalid custom skill bundle ${entry.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return skills
}

// Pull `toolIds: [a, b, c]` out of SKILL.md frontmatter. Also tolerates
// the multi-line YAML form:
//     toolIds:
//       - a
//       - b
// Returns [] when the key is missing or can't be parsed — a malformed
// entry shouldn't block skill loading.
function parseToolIdsFromFrontmatter(content: string): string[] {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return []
  const frontmatter = match[1]

  // Inline array: `toolIds: [a, b, c]` or `toolIds: ["a","b"]`.
  const inlineMatch = frontmatter.match(/^\s*toolIds\s*:\s*\[([^\]]*)\]/m)
  if (inlineMatch) {
    return inlineMatch[1]
      .split(',')
      .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
      .filter((entry) => entry.length > 0)
  }

  // Block array:
  //   toolIds:
  //     - a
  //     - b
  const blockMatch = frontmatter.match(/^\s*toolIds\s*:\s*\n((?:[ \t]*-[^\n]*\n?)+)/m)
  if (blockMatch) {
    return blockMatch[1]
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('-'))
      .map((line) => line.slice(1).trim().replace(/^['"]|['"]$/g, ''))
      .filter((entry) => entry.length > 0)
  }

  return []
}

// Write a canonical `toolIds: ["a","b"]` line into the SKILL.md
// frontmatter, replacing any existing toolIds entry (inline or block
// form) so the form's selection is the single source of truth. If the
// file has no frontmatter, prepend one. If `toolIds` is empty, strip any
// existing entry rather than leaving `toolIds: []` noise.
function writeToolIdsIntoFrontmatter(content: string, toolIds: string[]): string {
  const serialized = `toolIds: [${toolIds.map((id) => JSON.stringify(id)).join(', ')}]`
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/)
  if (!frontmatterMatch) {
    if (toolIds.length === 0) return content
    return `---\n${serialized}\n---\n\n${content.replace(/^[\s]+/, '')}`
  }

  const frontmatter = frontmatterMatch[1]
  const rest = content.slice(frontmatterMatch[0].length)
  // Remove any existing `toolIds:` entry (inline AND block form). We
  // strip the line plus any subsequent indented `- value` lines that
  // belong to a block array.
  const lines = frontmatter.split(/\r?\n/)
  const stripped: string[] = []
  let skippingBlock = false
  for (const line of lines) {
    if (skippingBlock) {
      if (/^[ \t]+-/.test(line) || line.trim() === '') {
        continue
      }
      skippingBlock = false
    }
    if (/^\s*toolIds\s*:/.test(line)) {
      skippingBlock = !/\[.*\]/.test(line)
      continue
    }
    stripped.push(line)
  }

  const cleaned = stripped.join('\n').replace(/\n+$/, '')
  const next = toolIds.length > 0 ? `${cleaned}\n${serialized}` : cleaned
  return `---\n${next}\n---${rest.startsWith('\n') || rest.startsWith('\r') ? '' : '\n'}${rest}`
}

export function readSkillBundleDirectory(directory: string, target: ScopedArtifactRef): CustomSkillConfig {
  const root = resolve(directory)
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error('Select a valid skill bundle directory.')
  }

  const skillFile = join(root, 'SKILL.md')
  let rawContent: string
  try {
    rawContent = readTextFileCheckedSync(skillFile, { maxBytes: CUSTOM_SKILL_LIMITS.skillContentBytes }).content
  } catch (error) {
    if (error instanceof Error && error.name === 'FileTooLargeError') {
      throw new Error(`SKILL.md is too large (limit ${CUSTOM_SKILL_LIMITS.skillContentBytes} bytes).`, { cause: error })
    }
    throw new Error('The selected directory does not contain a SKILL.md file.', { cause: error })
  }
  const importedName = normalizeSkillBundleName(
    extractSkillFrontmatterName(rawContent)
      || basename(root),
  )

  if (!importedName) {
    throw new Error('Could not derive a valid skill id from this directory name.')
  }

  const content = writeSkillNameIntoFrontmatter(rawContent, importedName)
  assertValidOpenCodeSkillBundle({ name: importedName, content }, 'Imported skill bundle')

  const files = listFiles(root)
  assertCustomSkillFiles(files)

  return {
    scope: target.scope,
    directory: target.scope === 'project' ? targetDirectory(target.scope, target.directory) : null,
    name: importedName,
    content,
    files,
  }
}

export function listCustomSkills(context?: RuntimeContextOptions) {
  const projectDirectory = resolveProjectDirectory(context?.directory)
  const entries = [
    ...readScopedSkills('machine'),
    ...(projectDirectory ? readScopedSkills('project', projectDirectory) : []),
  ]
  return mergeByName(entries)
}

export function getCustomSkill(name: string, context?: RuntimeContextOptions) {
  return listCustomSkills(context).find((skill) => skill.name === name) || null
}

export function saveCustomSkill(skill: CustomSkillConfig) {
  const root = join(ensureDirectory(skillsDirForTarget(skill.scope, skill.directory)), skill.name)
  const filesToWrite = skill.files || []
  // `toolIds` is stored inside SKILL.md frontmatter so the bundle stays
  // self-contained — no sidecar to drift. The form's selection wins over
  // whatever the user typed into the raw YAML, so we reconcile here.
  let contentToWrite = writeSkillNameIntoFrontmatter(skill.content, skill.name)
  contentToWrite = skill.toolIds !== undefined
    ? writeToolIdsIntoFrontmatter(contentToWrite, skill.toolIds)
    : contentToWrite
  assertCustomSkillContent(contentToWrite)
  assertCustomSkillFiles(filesToWrite)
  assertValidOpenCodeSkillBundle({ name: skill.name, content: contentToWrite }, 'Custom skill bundle')
  for (const file of filesToWrite) {
    if (!isSafeRelativePath(file.path)) {
      throw new Error(`Invalid skill file path: ${file.path}`)
    }
    const output = resolve(root, file.path)
    const outputRelative = relative(root, output)
    if (outputRelative.startsWith('..') || outputRelative.startsWith('/')) {
      throw new Error(`Skill file escapes bundle root: ${file.path}`)
    }
  }

  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  writeFileAtomic(join(root, 'SKILL.md'), contentToWrite)

  for (const file of filesToWrite) {
    const output = resolve(root, file.path)
    mkdirSync(dirname(output), { recursive: true })
    writeFileAtomic(output, file.content)
  }

  return true
}

export function removeCustomSkill(target: ScopedArtifactRef) {
  rmSync(join(skillsDirForTarget(target.scope, target.directory), target.name), { recursive: true, force: true })
  return true
}
