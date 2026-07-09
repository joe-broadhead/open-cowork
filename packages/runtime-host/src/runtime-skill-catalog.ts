import { writeFileAtomic } from '@open-cowork/shared/node'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { getProjectOverlayDirName } from './config-loader-core.js'
import { listEffectiveSkillBundlesSync, type EffectiveSkillContextOptions } from './effective-skills.js'
import { warmBundledSkillIndex } from './bundled-skill-index.js'
import { log } from '@open-cowork/shared/node'
import { getRuntimeHomeDir, getRuntimeSkillCatalogDir } from './runtime-paths.js'
import { getBundledSkillRoots } from './runtime-content.js'
export type RuntimeSkillBundle = {
  name: string
  content: string
  files: Array<{ path: string; content: string }>
}

// Drop any `..`/`.`/empty/leading-slash segment so a bundle file path can never traverse out
// of the skill root (P3 defense-in-depth: today only curated built-in bundles reach this, but
// the write below trusts the result). Returns '' when nothing safe remains, so the caller skips.
function normalizeBundlePath(value: string) {
  return value
    .replace(/\\/g, '/')
    .trim()
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join('/')
}

function uniqueByBasename(files: Array<{ path: string; content: string }>) {
  const byBasename = new Map<string, string[]>()
  for (const file of files) {
    const normalized = normalizeBundlePath(file.path)
    const basename = normalized.split('/').pop()
    if (!basename) continue
    const entries = byBasename.get(basename) || []
    entries.push(normalized)
    byBasename.set(basename, entries)
  }
  return byBasename
}

export function buildReadableSkillMirrorRelativePath(skillName: string, filePath: string) {
  return `${getProjectOverlayDirName()}/skill-bundles/${skillName}/${normalizeBundlePath(filePath)}`
}

function resolveBundleReferencePath(
  token: string,
  files: Array<{ path: string; content: string }>,
): string | null {
  const normalized = normalizeBundlePath(token)
  if (!normalized || normalized.startsWith(`${getProjectOverlayDirName()}/skill-bundles/`)) return null

  const actualPaths = new Set(files.map((file) => normalizeBundlePath(file.path)))
  if (actualPaths.has(normalized)) return normalized

  const suffixMatches = Array.from(actualPaths).filter((candidate) => normalized.endsWith(`/${candidate}`))
  if (suffixMatches.length === 1) return suffixMatches[0]!

  const basename = normalized.split('/').pop()
  if (!basename) return null
  const basenameMatches = uniqueByBasename(files).get(basename) || []
  if (basenameMatches.length === 1) return basenameMatches[0]!

  return null
}

function rewriteInlineSkillFileReferences(
  _skillName: string,
  content: string,
  files: Array<{ path: string; content: string }>,
) {
  const rewriteToken = (token: string) => {
    const resolved = resolveBundleReferencePath(token, files)
    return resolved ? `embedded bundle file "${resolved}"` : token
  }

  let next = content.replace(/`([^`\n]+)`/g, (_full, inner: string) => `\`${rewriteToken(inner)}\``)
  next = next.replace(/^(\s*-\s+)([^`\n]+)$/gm, (full, prefix: string, rawValue: string) => {
    const trimmed = rawValue.trim()
    const rewritten = rewriteToken(trimmed)
    if (rewritten === trimmed) return full
    return `${prefix}\`${rewritten}\``
  })
  return next
}

function embedSupportingFiles(content: string, files: Array<{ path: string; content: string }>) {
  if (files.length === 0) return content

  const sections = files.map((file) => {
    const trimmed = file.content.trimEnd()
    return [
      `### Embedded bundle file: ${normalizeBundlePath(file.path)}`,
      '',
      '```md',
      trimmed,
      '```',
      '',
    ].join('\n')
  })

  const preface = [
    '## Embedded supporting files',
    '',
    'Do not use the read tool for bundle-relative files from this skill.',
    'Their contents are embedded below inside this single runtime skill document.',
    '',
  ].join('\n')

  return `${content.trimEnd()}\n\n${preface}${sections.join('\n')}`
}

function insertMirrorSection(
  skillName: string,
  content: string,
  files: Array<{ path: string; content: string }>,
) {
  if (files.length === 0) return content

  const lines = [
    '## Open Cowork bundle files',
    '',
    'Only the workspace-local paths below are guaranteed to exist for this skill at runtime:',
    ...files.map((file) => `- \`${buildReadableSkillMirrorRelativePath(skillName, file.path)}\``),
    '',
  ]
  const section = `${lines.join('\n')}\n`
  const frontmatter = content.match(/^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/)
  if (!frontmatter) {
    return `${section}${content}`
  }
  return `${content.slice(0, frontmatter[0].length)}\n${section}${content.slice(frontmatter[0].length)}`
}

export function buildRuntimeSkillContent(skillName: string, content: string, files: Array<{ path: string; content: string }>) {
  const withRewrittenReferences = rewriteInlineSkillFileReferences(skillName, content, files)
  const withMirrorSection = insertMirrorSection(skillName, withRewrittenReferences, files)
  return embedSupportingFiles(withMirrorSection, files)
}

export function writeRuntimeSkillBundle(root: string, bundle: RuntimeSkillBundle, skillContent: string, options?: { includeFiles?: boolean }) {
  const skillRoot = join(root, bundle.name)
  rmSync(skillRoot, { recursive: true, force: true })
  mkdirSync(skillRoot, { recursive: true })
  writeFileAtomic(join(skillRoot, 'SKILL.md'), skillContent, { mode: 0o600 })
  if (options?.includeFiles !== false) {
    for (const file of bundle.files) {
      const safePath = normalizeBundlePath(file.path)
      if (!safePath) continue
      const output = join(skillRoot, safePath)
      mkdirSync(dirname(output), { recursive: true })
      writeFileAtomic(output, file.content, { mode: 0o600 })
    }
  }
}

function listContextBundles(context?: EffectiveSkillContextOptions): RuntimeSkillBundle[] {
  // The generated SDK skills.paths catalog is the app-owned discovery surface
  // for both bundled and allowed custom skills. Runtime config disables
  // OpenCode's ambient custom-skill discovery so org policy can hide custom
  // skills deterministically without deleting user/project skill files.
  return listEffectiveSkillBundlesSync(context)
    .map((bundle) => ({
      name: bundle.name,
      content: bundle.content || '',
      files: (bundle.files || []).map((file) => ({
        path: file.path,
        content: typeof file.content === 'string' ? file.content : '',
      })),
    }))
}

function resolveReadableMirrorRoot(directory?: string | null) {
  if (!directory) {
    return join(getRuntimeHomeDir(), getProjectOverlayDirName(), 'skill-bundles')
  }
  return join(resolve(directory), getProjectOverlayDirName(), 'skill-bundles')
}

export function syncReadableSkillMirror(directory?: string | null, context?: EffectiveSkillContextOptions) {
  const root = resolveReadableMirrorRoot(directory)
  try {
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })
    for (const bundle of listContextBundles(context)) {
      writeRuntimeSkillBundle(root, bundle, bundle.content)
    }
    return root
  } catch (error) {
    log('runtime', `Could not sync readable skill mirror at ${root}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

export function buildRuntimeSkillCatalog(context?: EffectiveSkillContextOptions) {
  const catalogRoot = getRuntimeSkillCatalogDir()
  rmSync(catalogRoot, { recursive: true, force: true })
  mkdirSync(catalogRoot, { recursive: true })

  warmBundledSkillIndex(getBundledSkillRoots())
  const bundles = listContextBundles(context)
  for (const bundle of bundles) {
    writeRuntimeSkillBundle(catalogRoot, bundle, buildRuntimeSkillContent(bundle.name, bundle.content, bundle.files), { includeFiles: false })
  }

  syncReadableSkillMirror(null, undefined)
  if (context?.directory) {
    syncReadableSkillMirror(context.directory, context)
  }

  log('runtime', `Prepared runtime skill catalog with ${bundles.length} bundle(s)`)
  return catalogRoot
}
