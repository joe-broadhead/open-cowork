import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import type { RuntimeContextOptions } from '@open-cowork/shared'
import { getProjectOverlayDirName } from './config-loader.ts'
import { getEffectiveSkillBundleSync, listEffectiveSkillsSync } from './effective-skills.ts'
import { log } from './logger.ts'
import { getRuntimeHomeDir, getRuntimeSkillCatalogDir } from './runtime-paths.ts'

export type RuntimeSkillBundle = {
  name: string
  content: string
  files: Array<{ path: string; content: string }>
}

function normalizeBundlePath(value: string) {
  return value.replace(/\\/g, '/').replace(/^\.\/+/, '').trim()
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

function writeBundle(root: string, bundle: RuntimeSkillBundle, skillContent: string, options?: { includeFiles?: boolean }) {
  const skillRoot = join(root, bundle.name)
  rmSync(skillRoot, { recursive: true, force: true })
  mkdirSync(skillRoot, { recursive: true })
  writeFileSync(join(skillRoot, 'SKILL.md'), skillContent, 'utf-8')
  if (options?.includeFiles !== false) {
    for (const file of bundle.files) {
      const output = join(skillRoot, normalizeBundlePath(file.path))
      mkdirSync(dirname(output), { recursive: true })
      writeFileSync(output, file.content, 'utf-8')
    }
  }
}

function listContextBundles(context?: RuntimeContextOptions): RuntimeSkillBundle[] {
  return listEffectiveSkillsSync(context)
    .map((skill) => getEffectiveSkillBundleSync(skill.name, context))
    .filter((bundle): bundle is NonNullable<typeof bundle> => Boolean(bundle))
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

export function syncReadableSkillMirror(directory?: string | null, context?: RuntimeContextOptions) {
  const root = resolveReadableMirrorRoot(directory)
  try {
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })
    for (const bundle of listContextBundles(context)) {
      writeBundle(root, bundle, bundle.content)
    }
    return root
  } catch (error) {
    log('runtime', `Could not sync readable skill mirror at ${root}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

export function buildRuntimeSkillCatalog(context?: RuntimeContextOptions) {
  const catalogRoot = getRuntimeSkillCatalogDir()
  rmSync(catalogRoot, { recursive: true, force: true })
  mkdirSync(catalogRoot, { recursive: true })

  const bundles = listContextBundles(context)
  for (const bundle of bundles) {
    writeBundle(catalogRoot, bundle, buildRuntimeSkillContent(bundle.name, bundle.content, bundle.files), { includeFiles: false })
  }

  syncReadableSkillMirror(null, undefined)
  if (context?.directory) {
    syncReadableSkillMirror(context.directory, context)
  }

  log('runtime', `Prepared runtime skill catalog with ${bundles.length} bundle(s)`)
  return catalogRoot
}
