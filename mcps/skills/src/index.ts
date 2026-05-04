import { closeSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, isAbsolute, join, parse, relative, resolve } from 'path'
import { pathToFileURL } from 'url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({
  name: 'skills',
  version: '1.0.0',
})

const skillFileSchema = z.object({
  path: z.string().min(1).describe('Relative path inside the skill bundle, for example references/example.md'),
  content: z.string().describe('UTF-8 file contents'),
})

function skillsRoot() {
  const root = resolveSafeSkillsRoot(process.env.OPEN_COWORK_CUSTOM_SKILLS_DIR)
  mkdirSync(root, { recursive: true })
  return root
}

export function isSafeSkillBundleName(value: string) {
  const trimmed = value.trim()
  if (trimmed.length < 1 || trimmed.length > 64) return false
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(trimmed)) return false
  return !trimmed.includes('--')
}

const skillBundleNameSchema = z.string()
  .min(1)
  .max(64)
  .refine(isSafeSkillBundleName, 'Use lowercase letters, numbers, and single hyphens only')

export function resolveSafeSkillsRoot(value?: string) {
  const raw = value?.trim()
  if (!raw) {
    throw new Error('OPEN_COWORK_CUSTOM_SKILLS_DIR is not configured')
  }
  if (!isAbsolute(raw)) {
    throw new Error('OPEN_COWORK_CUSTOM_SKILLS_DIR must be an absolute app-managed directory')
  }

  const root = resolve(raw)
  if (root === parse(root).root) {
    throw new Error('OPEN_COWORK_CUSTOM_SKILLS_DIR cannot point at a filesystem root')
  }
  if (root === resolve(homedir())) {
    throw new Error('OPEN_COWORK_CUSTOM_SKILLS_DIR cannot point at the user home directory')
  }
  return root
}

function skillDir(name: string) {
  const trimmed = name.trim()
  if (!isSafeSkillBundleName(trimmed)) {
    throw new Error('Skill bundle name must be a lowercase path segment using letters, numbers, and single hyphens')
  }
  return join(skillsRoot(), trimmed)
}

export function isSafeRelativePath(value: string) {
  if (!value.trim()) return false
  if (value.startsWith('/') || value.startsWith('\\')) return false
  return !value.replace(/\\/g, '/').split('/').some((segment) => segment === '..' || segment === '')
}

function listBundleFiles(root: string, current = root): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = []
  let entries
  try {
    entries = readdirSync(current, { withFileTypes: true })
  } catch {
    return files
  }

  for (const entry of entries) {
    const fullPath = join(current, entry.name)
    if (entry.isDirectory()) {
      files.push(...listBundleFiles(root, fullPath))
      continue
    }
    if (!entry.isFile()) continue

    const filePath = relative(root, fullPath).replace(/\\/g, '/')
    if (filePath === 'SKILL.md') continue
    files.push({
      path: filePath,
      content: readTextFileCheckedSync(fullPath),
    })
  }

  return files.sort((a, b) => a.path.localeCompare(b.path))
}

function readTextFileCheckedSync(path: string) {
  const fd = openSync(path, 'r')
  try {
    const stats = fstatSync(fd)
    if (!stats.isFile()) throw new Error('Path is not a regular file.')
    return readFileSync(fd, 'utf-8')
  } finally {
    closeSync(fd)
  }
}

function readSkillBundle(name: string) {
  if (!isSafeSkillBundleName(name)) return null
  const root = skillDir(name)
  const skillFile = join(root, 'SKILL.md')
  let content: string
  try {
    content = readTextFileCheckedSync(skillFile)
  } catch {
    return null
  }
  return {
    name,
    content,
    files: listBundleFiles(root),
  }
}

export function saveSkillBundle(name: string, skillContent: string, files: Array<{ path: string; content: string }>) {
  const root = skillDir(name)
  const validatedFiles = files.map((file) => {
    if (!isSafeRelativePath(file.path)) {
      throw new Error(`Invalid skill file path: ${file.path}`)
    }
    const output = resolve(root, file.path)
    const outputRelative = relative(root, output)
    if (outputRelative.startsWith('..') || outputRelative.startsWith('/')) {
      throw new Error(`Skill file escapes bundle root: ${file.path}`)
    }
    return { ...file, outputRelative }
  })

  const tempRoot = `${root}.tmp-${process.pid}-${Date.now()}`
  rmSync(tempRoot, { recursive: true, force: true })
  mkdirSync(tempRoot, { recursive: true })

  try {
    writeFileSync(join(tempRoot, 'SKILL.md'), skillContent)
    for (const file of validatedFiles) {
      const output = resolve(tempRoot, file.outputRelative)
      const outputRelative = relative(tempRoot, output)
      if (outputRelative.startsWith('..') || outputRelative.startsWith('/')) {
        throw new Error(`Skill file escapes bundle root: ${file.path}`)
      }
      mkdirSync(dirname(output), { recursive: true })
      writeFileSync(output, file.content)
    }

    rmSync(root, { recursive: true, force: true })
    renameSync(tempRoot, root)
  } catch (err) {
    rmSync(tempRoot, { recursive: true, force: true })
    throw err
  }
}

server.tool(
  'list_skill_bundles',
  'List the custom (user-authored) OpenCode skill bundles. Product-shipped skills are discovered natively by OpenCode via `config.skills.paths` and surfaced to the model through the `skill` tool — this MCP covers the writable customization layer.',
  {},
  async () => {
    const root = skillsRoot()
    const bundles = readdirSync(root)
      .map((entry) => readSkillBundle(entry))
      .filter((bundle): bundle is NonNullable<ReturnType<typeof readSkillBundle>> => bundle !== null)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((bundle) => {
        return {
          name: bundle.name,
          fileCount: bundle.files.length,
        }
      })

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(bundles),
      }],
    }
  },
)

server.tool(
  'get_skill_bundle',
  'Read one custom OpenCode skill bundle, including SKILL.md and any extra files.',
  {
    name: skillBundleNameSchema.describe('Skill bundle directory name'),
  },
  async ({ name }) => {
    const bundle = readSkillBundle(name)
    if (!bundle) {
      throw new Error(`Skill bundle not found: ${name}`)
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(bundle),
      }],
    }
  },
)

server.tool(
  'save_skill_bundle',
  'Create or update a custom OpenCode skill bundle in Open Cowork.',
  {
    name: skillBundleNameSchema.describe('Skill bundle directory name'),
    skill_md: z.string().describe('The contents of SKILL.md'),
    files: z.array(skillFileSchema).optional().default([]).describe('Optional extra files in the skill bundle'),
  },
  async ({ name, skill_md, files }) => {
    saveSkillBundle(name, skill_md, files)
    const bundle = readSkillBundle(name)
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          saved: true,
          bundle,
        }),
      }],
    }
  },
)

server.tool(
  'delete_skill_bundle',
  'Delete a custom OpenCode skill bundle from Open Cowork.',
  {
    name: skillBundleNameSchema.describe('Skill bundle directory name'),
  },
  async ({ name }) => {
    rmSync(skillDir(name), { recursive: true, force: true })
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ deleted: true, name }),
      }],
    }
  },
)

export async function startSkillsMcpServer() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startSkillsMcpServer()
}
