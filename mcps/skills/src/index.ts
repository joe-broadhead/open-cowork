import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { dirname, join, relative, resolve } from 'path'
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
  const root = process.env.OPEN_COWORK_CUSTOM_SKILLS_DIR?.trim()
  if (!root) {
    throw new Error('OPEN_COWORK_CUSTOM_SKILLS_DIR is not configured')
  }
  mkdirSync(root, { recursive: true })
  return root
}

function skillDir(name: string) {
  return join(skillsRoot(), name)
}

function isSafeRelativePath(value: string) {
  if (!value.trim()) return false
  if (value.startsWith('/') || value.startsWith('\\')) return false
  return !value.replace(/\\/g, '/').split('/').some((segment) => segment === '..' || segment === '')
}

function listBundleFiles(root: string, current = root): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = []
  if (!existsSync(current)) return files

  for (const entry of readdirSync(current)) {
    const fullPath = join(current, entry)
    const stats = statSync(fullPath)
    if (stats.isDirectory()) {
      files.push(...listBundleFiles(root, fullPath))
      continue
    }

    const filePath = relative(root, fullPath).replace(/\\/g, '/')
    if (filePath === 'SKILL.md') continue
    files.push({
      path: filePath,
      content: readFileSync(fullPath, 'utf-8'),
    })
  }

  return files.sort((a, b) => a.path.localeCompare(b.path))
}

function readSkillBundle(name: string) {
  const root = skillDir(name)
  const skillFile = join(root, 'SKILL.md')
  if (!existsSync(skillFile)) return null
  return {
    name,
    content: readFileSync(skillFile, 'utf-8'),
    files: listBundleFiles(root),
  }
}

function saveSkillBundle(name: string, skillContent: string, files: Array<{ path: string; content: string }>) {
  const root = skillDir(name)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'SKILL.md'), skillContent)

  for (const file of files) {
    if (!isSafeRelativePath(file.path)) {
      throw new Error(`Invalid skill file path: ${file.path}`)
    }
    const output = resolve(root, file.path)
    const outputRelative = relative(root, output)
    if (outputRelative.startsWith('..') || outputRelative.startsWith('/')) {
      throw new Error(`Skill file escapes bundle root: ${file.path}`)
    }
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, file.content)
  }
}

server.tool(
  'list_skill_bundles',
  'List the custom (user-authored) OpenCode skill bundles. Product-shipped skills are discovered natively by OpenCode via `config.skills.paths` and surfaced to the model through the `skill` tool — this MCP covers the writable customization layer.',
  {},
  async () => {
    const root = skillsRoot()
    const bundles = readdirSync(root)
      .filter((entry) => existsSync(join(root, entry, 'SKILL.md')))
      .sort()
      .map((name) => {
        const bundle = readSkillBundle(name)
        return {
          name,
          fileCount: bundle?.files.length || 0,
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
    name: z.string().describe('Skill bundle directory name'),
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
    name: z.string().describe('Skill bundle directory name'),
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
    name: z.string().describe('Skill bundle directory name'),
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

const transport = new StdioServerTransport()
await server.connect(transport)
