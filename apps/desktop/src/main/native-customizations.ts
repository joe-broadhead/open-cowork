import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { basename, dirname, join, relative, resolve } from 'path'
import type {
  AgentColor,
  CustomAgentConfig,
  CustomMcpConfig,
  CustomSkillConfig,
  RuntimeContextOptions,
  ScopedArtifactRef,
} from '@open-cowork/shared'
import { getConfiguredToolPatterns, getConfiguredToolsFromConfig, getSidecarJsonSuffix } from './config-loader.ts'
import {
  readJsoncFile,
  resolveExistingJsonConfigPath,
  writeJsonFile,
  writeTopLevelObjectPropertyFile,
} from './jsonc.ts'
import { log } from './logger.ts'
import {
  getMachineAgentsDir,
  getMachineOpencodeDir,
  getMachineOpencodeConfigPath,
  getMachineSkillsDir,
  getProjectCoworkAgentsDir,
  getProjectCoworkConfigPath,
  getProjectCoworkDir,
  getProjectCoworkSkillsDir,
  resolveProjectDirectory,
  type NativeConfigScope,
} from './runtime-paths.ts'
import {
  assertValidOpenCodeSkillBundle,
  extractSkillFrontmatterName,
  normalizeSkillBundleName,
  writeSkillNameIntoFrontmatter,
} from './skill-bundle-validation.ts'

type JsonRecord = Record<string, unknown>

type ManagedAgentMetadata = {
  color?: AgentColor
  // Optional data URI for a user-uploaded avatar. See the comment on
  // CustomAgentConfig.avatar in packages/shared/src/index.ts — stored
  // inline in the JSON sidecar so runtime-project-overlay picks it up
  // for free along with the agent's .md + .opencowork.json pair.
  avatar?: string
}

type ManagedMcpMetadata = {
  label?: string
  description?: string
}

function ensureDirectory(path: string) {
  mkdirSync(path, { recursive: true })
  return path
}

function isSafeRelativePath(value: string) {
  if (!value.trim()) return false
  if (value.startsWith('/') || value.startsWith('\\')) return false
  return !value.replace(/\\/g, '/').split('/').some((segment) => segment === '..' || segment === '')
}

function targetDirectory(scope: NativeConfigScope, directory?: string | null) {
  if (scope === 'project') {
    const resolved = resolveProjectDirectory(directory)
    if (!resolved) {
      throw new Error('Project scope requires a project directory.')
    }
    return resolved
  }
  return null
}

function configPathForTarget(scope: NativeConfigScope, directory?: string | null) {
  const basePath = scope === 'project'
    ? getProjectCoworkConfigPath(targetDirectory(scope, directory)!)
    : getMachineOpencodeConfigPath()
  return resolveExistingJsonConfigPath(basePath)
}

function skillsDirForTarget(scope: NativeConfigScope, directory?: string | null) {
  if (scope === 'project') {
    return getProjectCoworkSkillsDir(targetDirectory(scope, directory)!)
  }
  return getMachineSkillsDir()
}

function agentsDirForTarget(scope: NativeConfigScope, directory?: string | null) {
  if (scope === 'project') {
    return getProjectCoworkAgentsDir(targetDirectory(scope, directory)!)
  }
  return getMachineAgentsDir()
}

function mergeByName<T extends { name: string }>(items: T[]) {
  const merged = new Map<string, T>()
  for (const item of items) {
    merged.set(item.name, item)
  }
  return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name))
}

function mcpMetaPathForTarget(scope: NativeConfigScope, directory?: string | null) {
  if (scope === 'project') {
    return join(getProjectCoworkDir(targetDirectory(scope, directory)!), 'mcp.open-cowork.json')
  }
  return join(getMachineOpencodeDir(), 'mcp.open-cowork.json')
}

function readManagedMcpMetadata(
  scope: NativeConfigScope,
  directory?: string | null,
): Record<string, ManagedMcpMetadata> {
  const path = mcpMetaPathForTarget(scope, directory)
  if (!existsSync(path)) return {}
  try {
    const value = readJsoncFile<JsonRecord>(path)
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry && typeof entry === 'object' && !Array.isArray(entry))
        .map(([name, entry]) => {
          const record = entry as Record<string, unknown>
          return [name, {
            label: typeof record.label === 'string' ? record.label : undefined,
            description: typeof record.description === 'string' ? record.description : undefined,
          }]
        }),
    )
  } catch (error) {
    log('error', `Custom MCP metadata load failed: ${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
}

function writeManagedMcpMetadata(
  scope: NativeConfigScope,
  directory: string | null | undefined,
  updater: (current: Record<string, ManagedMcpMetadata>) => Record<string, ManagedMcpMetadata>,
) {
  const path = mcpMetaPathForTarget(scope, directory)
  const current = readManagedMcpMetadata(scope, directory)
  const next = updater(current)

  if (Object.keys(next).length === 0) {
    rmSync(path, { force: true })
    return
  }

  writeJsonFile(path, next as JsonRecord)
}

function serializeCustomMcp(mcp: CustomMcpConfig): JsonRecord {
  if (mcp.type === 'stdio') {
    if (!mcp.command?.trim()) {
      throw new Error('Local MCPs require a command.')
    }
    const entry: JsonRecord = {
      type: 'local',
      command: [mcp.command.trim(), ...(mcp.args || []).filter(Boolean)],
      enabled: true,
    }
    if (mcp.env && Object.keys(mcp.env).length > 0) {
      entry.environment = mcp.env
    }
    return entry
  }

  if (!mcp.url?.trim()) {
    throw new Error('Remote MCPs require a URL.')
  }

  const entry: JsonRecord = {
    type: 'remote',
    url: mcp.url.trim(),
    enabled: true,
  }
  if (mcp.headers && Object.keys(mcp.headers).length > 0) {
    entry.headers = mcp.headers
  }
  return entry
}

function parseCustomMcpEntry(
  name: string,
  value: unknown,
  scope: NativeConfigScope,
  metadata: ManagedMcpMetadata,
  directory?: string | null,
): CustomMcpConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entry = value as Record<string, unknown>
  const type = entry.type === 'local' ? 'stdio' : entry.type === 'remote' ? 'http' : null
  if (!type) return null

  const commandArray = Array.isArray(entry.command)
    ? entry.command.filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    : []

  return {
    scope,
    directory: scope === 'project' ? targetDirectory(scope, directory) : null,
    name,
    label: metadata.label,
    description: metadata.description,
    type,
    command: type === 'stdio' ? commandArray[0] : undefined,
    args: type === 'stdio' ? commandArray.slice(1) : undefined,
    env: entry.environment && typeof entry.environment === 'object' && !Array.isArray(entry.environment)
      ? Object.fromEntries(Object.entries(entry.environment as Record<string, unknown>).filter(([, raw]) => typeof raw === 'string')) as Record<string, string>
      : undefined,
    url: type === 'http' && typeof entry.url === 'string' ? entry.url : undefined,
    headers: entry.headers && typeof entry.headers === 'object' && !Array.isArray(entry.headers)
      ? Object.fromEntries(Object.entries(entry.headers as Record<string, unknown>).filter(([, raw]) => typeof raw === 'string')) as Record<string, string>
      : undefined,
  }
}

function readScopedMcps(scope: NativeConfigScope, directory?: string | null) {
  const path = configPathForTarget(scope, directory)
  const config = readJsoncFile<JsonRecord>(path)
  const mcp = config.mcp
  if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp)) return []
  const metadata = readManagedMcpMetadata(scope, directory)
  return Object.entries(mcp)
    .map(([name, value]) => parseCustomMcpEntry(name, value, scope, metadata[name] || {}, directory))
    .filter((entry): entry is CustomMcpConfig => Boolean(entry))
}

function updateScopedMcpConfig(
  scope: NativeConfigScope,
  directory: string | null | undefined,
  updater: (mcp: Record<string, unknown>) => Record<string, unknown>,
) {
  const path = configPathForTarget(scope, directory)
  const config = readJsoncFile<JsonRecord>(path)
  const nextMcp = updater(
    config.mcp && typeof config.mcp === 'object' && !Array.isArray(config.mcp)
      ? { ...(config.mcp as Record<string, unknown>) }
      : {},
  )

  if (Object.keys(nextMcp).length === 0 && Object.keys(config).length === 0) {
    rmSync(path, { force: true })
    return
  }

  writeTopLevelObjectPropertyFile(path, 'mcp', Object.keys(nextMcp).length === 0 ? null : nextMcp)
}

function listFiles(root: string, current = root): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = []
  if (!existsSync(current)) return files

  for (const entry of readdirSync(current)) {
    const fullPath = join(current, entry)
    const stats = statSync(fullPath)
    if (stats.isDirectory()) {
      files.push(...listFiles(root, fullPath))
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
    writeFileSync(skillFile, canonicalContent)
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
  const entries = existsSync(root) ? readdirSync(root) : []
  const skills: CustomSkillConfig[] = []

  for (const entry of entries) {
    const skillRoot = join(root, entry)
    let stats
    try {
      stats = statSync(skillRoot)
    } catch {
      continue
    }
    if (!stats.isDirectory()) continue

    const skillFile = join(skillRoot, 'SKILL.md')
    if (!existsSync(skillFile)) continue

    const content = canonicalizeManagedSkillContent(entry, skillFile, readFileSync(skillFile, 'utf-8'))
    const toolIds = parseToolIdsFromFrontmatter(content)

    skills.push({
      scope,
      directory: scope === 'project' ? targetDirectory(scope, directory) : null,
      name: entry,
      content,
      files: listFiles(skillRoot),
      ...(toolIds.length > 0 ? { toolIds } : {}),
    })
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

function parseFrontmatter(content: string) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match?.[1]) return {}

  const root: Record<string, unknown> = {}
  const stack: Array<{ indent: number; value: Record<string, unknown> }> = [{ indent: -1, value: root }]

  for (const rawLine of match[1].split(/\r?\n/)) {
    if (!rawLine.trim()) continue
    const indent = rawLine.match(/^\s*/)?.[0].length || 0
    const line = rawLine.trim()
    const separator = line.indexOf(':')
    if (separator === -1) continue

    const key = line.slice(0, separator).trim().replace(/^['"]|['"]$/g, '')
    const rawValue = line.slice(separator + 1).trim()

    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) {
      stack.pop()
    }

    const parent = stack[stack.length - 1]!.value

    if (!rawValue) {
      const nested: Record<string, unknown> = {}
      parent[key] = nested
      stack.push({ indent, value: nested })
      continue
    }

    const quoted = rawValue.startsWith('"') || rawValue.startsWith('\'')
    if (quoted) {
      try {
        parent[key] = rawValue.startsWith('"')
          ? JSON.parse(rawValue)
          : rawValue.slice(1, -1)
      } catch {
        parent[key] = rawValue.replace(/^['"]|['"]$/g, '')
      }
      continue
    }

    if (rawValue === 'true') {
      parent[key] = true
      continue
    }
    if (rawValue === 'false') {
      parent[key] = false
      continue
    }
    if (rawValue === 'null') {
      parent[key] = null
      continue
    }

    parent[key] = rawValue
  }

  return root
}

function deriveSkillNamesFromPermission(permission: unknown) {
  if (!permission || typeof permission !== 'object' || Array.isArray(permission)) return []
  const skillRules = (permission as Record<string, unknown>).skill
  if (!skillRules || typeof skillRules !== 'object' || Array.isArray(skillRules)) return []
  return Object.entries(skillRules as Record<string, unknown>)
    .filter(([name, access]) => name !== '*' && (access === 'allow' || access === 'ask'))
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b))
}

function deriveToolIdsFromPermission(
  permission: unknown,
  scope: NativeConfigScope,
  directory?: string | null,
) {
  if (!permission || typeof permission !== 'object' || Array.isArray(permission)) return []

  const patterns = new Set(
    Object.entries(permission as Record<string, unknown>)
      .filter(([key, value]) => key !== 'skill' && key !== 'task' && (value === 'allow' || value === 'ask'))
      .map(([key]) => key),
  )

  const configuredToolIds = getConfiguredToolsFromConfig()
    .filter((tool) => getConfiguredToolPatterns(tool).some((pattern) => patterns.has(pattern)))
    .map((tool) => tool.id)

  const customMcpIds = [
    ...readScopedMcps('machine'),
    ...(scope === 'project' && directory ? readScopedMcps('project', directory) : []),
  ]
    .filter((mcp) => Array.from(patterns).some((pattern) => pattern === `mcp__${mcp.name}__*` || pattern.startsWith(`mcp__${mcp.name}__`)))
    .map((mcp) => mcp.name)

  return Array.from(new Set([...configuredToolIds, ...customMcpIds])).sort((a, b) => a.localeCompare(b))
}

// Deny entries written into the permission map by `buildCustomAgentPermission`
// are always user-chosen — the deny-everything registry is not serialized to
// disk, so any explicit 'deny' we see here came from the agent builder's
// per-tool exclusion picker. We round-trip it back onto the draft so editing
// an agent preserves its narrowed scope.
function deriveDeniedToolPatternsFromPermission(permission: unknown) {
  if (!permission || typeof permission !== 'object' || Array.isArray(permission)) return []
  return Object.entries(permission as Record<string, unknown>)
    .filter(([key, value]) => key !== 'skill' && key !== 'task' && value === 'deny')
    .map(([key]) => key)
    .sort((a, b) => a.localeCompare(b))
}

function agentMetaPath(root: string, name: string) {
  return join(root, `${name}${getSidecarJsonSuffix()}`)
}

function agentMarkdownPath(root: string, name: string, enabled: boolean) {
  return join(root, enabled ? `${name}.md` : `${name}.disabled.md`)
}

function readManagedAgentMetadata(root: string, name: string): ManagedAgentMetadata {
  const path = agentMetaPath(root, name)
  if (!existsSync(path)) return {}
  try {
    const value = readJsoncFile<JsonRecord>(path)
    return {
      color: typeof value.color === 'string' ? value.color as AgentColor : undefined,
      avatar: typeof value.avatar === 'string' && value.avatar.length > 0 ? value.avatar : undefined,
    }
  } catch (error) {
    log('error', `Custom agent metadata load failed for ${name}: ${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
}

function serializeCustomAgentMarkdown(agent: CustomAgentConfig, permission: Record<string, unknown>) {
  const frontmatterLines = [
    '---',
    `description: ${JSON.stringify(agent.description)}`,
    'mode: subagent',
    'permission:',
  ]

  for (const [key, rawValue] of Object.entries(permission)) {
    if (rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
      frontmatterLines.push(`  ${key}:`)
      for (const [nestedKey, nestedValue] of Object.entries(rawValue as Record<string, unknown>)) {
        frontmatterLines.push(`    ${JSON.stringify(nestedKey)}: ${String(nestedValue)}`)
      }
      continue
    }
    frontmatterLines.push(`  ${key}: ${String(rawValue)}`)
  }

  frontmatterLines.push('---', '', agent.instructions.trim())
  return `${frontmatterLines.join('\n').trimEnd()}\n`
}

function readScopedAgents(scope: NativeConfigScope, directory?: string | null) {
  const root = ensureDirectory(agentsDirForTarget(scope, directory))
  const entries = existsSync(root) ? readdirSync(root) : []
  const agents: CustomAgentConfig[] = []

  for (const entry of entries) {
    if (!entry.endsWith('.md') && !entry.endsWith('.disabled.md')) continue
    if (entry.endsWith(getSidecarJsonSuffix())) continue

    const fullPath = join(root, entry)
    let stats
    try {
      stats = statSync(fullPath)
    } catch {
      continue
    }
    if (!stats.isFile()) continue

    const enabled = entry.endsWith('.md') && !entry.endsWith('.disabled.md')
    const name = basename(entry, enabled ? '.md' : '.disabled.md')
    const content = readFileSync(fullPath, 'utf-8')
    const metadata = readManagedAgentMetadata(root, name)
    const frontmatter = parseFrontmatter(content)
    const permission = frontmatter.permission
    const derivedSkillNames = deriveSkillNamesFromPermission(permission)
    const derivedToolIds = deriveToolIdsFromPermission(permission, scope, directory)
    const derivedDenies = deriveDeniedToolPatternsFromPermission(permission)

    agents.push({
      scope,
      directory: scope === 'project' ? targetDirectory(scope, directory) : null,
      name,
      // `parseFrontmatter` is already called above and handles the
      // "description is the first key" case correctly. The old regex
      // helper required a newline before the key and silently dropped
      // the description when it was the first frontmatter field —
      // which is exactly how the UI writer serializes it, so every
      // saved agent lost its description on reload and failed
      // validation downstream.
      description: typeof frontmatter.description === 'string' ? frontmatter.description : '',
      instructions: content.replace(/^---[\s\S]*?---\n?/, '').trim(),
      skillNames: derivedSkillNames,
      toolIds: derivedToolIds,
      enabled,
      color: metadata.color || 'accent',
      avatar: metadata.avatar || null,
      ...(derivedDenies.length > 0 ? { deniedToolPatterns: derivedDenies } : {}),
    })
  }

  return agents
}

export function readSkillBundleDirectory(directory: string, target: ScopedArtifactRef): CustomSkillConfig {
  const root = resolve(directory)
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error('Select a valid skill bundle directory.')
  }

  const skillFile = join(root, 'SKILL.md')
  if (!existsSync(skillFile) || !statSync(skillFile).isFile()) {
    throw new Error('The selected directory does not contain a SKILL.md file.')
  }

  const rawContent = readFileSync(skillFile, 'utf-8')
  const importedName = normalizeSkillBundleName(
    extractSkillFrontmatterName(rawContent)
      || basename(root),
  )

  if (!importedName) {
    throw new Error('Could not derive a valid skill id from this directory name.')
  }

  const content = writeSkillNameIntoFrontmatter(rawContent, importedName)
  assertValidOpenCodeSkillBundle({ name: importedName, content }, 'Imported skill bundle')

  return {
    scope: target.scope,
    directory: target.scope === 'project' ? targetDirectory(target.scope, target.directory) : null,
    name: importedName,
    content,
    files: listFiles(root),
  }
}

export function listCustomMcps(context?: RuntimeContextOptions) {
  const projectDirectory = resolveProjectDirectory(context?.directory)
  const entries = [
    ...readScopedMcps('machine'),
    ...(projectDirectory ? readScopedMcps('project', projectDirectory) : []),
  ]
  return mergeByName(entries)
}

export function saveCustomMcp(mcp: CustomMcpConfig) {
  updateScopedMcpConfig(mcp.scope, mcp.directory, (current) => ({
    ...current,
    [mcp.name]: serializeCustomMcp(mcp),
  }))
  writeManagedMcpMetadata(mcp.scope, mcp.directory, (current) => {
    const next = { ...current }
    const label = mcp.label?.trim() || undefined
    const description = mcp.description?.trim() || undefined
    if (!label && !description) {
      delete next[mcp.name]
      return next
    }
    next[mcp.name] = { label, description }
    return next
  })
  return true
}

export function removeCustomMcp(target: ScopedArtifactRef) {
  updateScopedMcpConfig(target.scope, target.directory, (current) => {
    const next = { ...current }
    delete next[target.name]
    return next
  })
  writeManagedMcpMetadata(target.scope, target.directory, (current) => {
    const next = { ...current }
    delete next[target.name]
    return next
  })
  return true
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
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  // `toolIds` is stored inside SKILL.md frontmatter so the bundle stays
  // self-contained — no sidecar to drift. The form's selection wins over
  // whatever the user typed into the raw YAML, so we reconcile here.
  let contentToWrite = writeSkillNameIntoFrontmatter(skill.content, skill.name)
  contentToWrite = skill.toolIds !== undefined
    ? writeToolIdsIntoFrontmatter(contentToWrite, skill.toolIds)
    : contentToWrite
  assertValidOpenCodeSkillBundle({ name: skill.name, content: contentToWrite }, 'Custom skill bundle')
  writeFileSync(join(root, 'SKILL.md'), contentToWrite)

  for (const file of skill.files || []) {
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

  return true
}

export function removeCustomSkill(target: ScopedArtifactRef) {
  rmSync(join(skillsDirForTarget(target.scope, target.directory), target.name), { recursive: true, force: true })
  return true
}

export function listCustomAgents(context?: RuntimeContextOptions) {
  const projectDirectory = resolveProjectDirectory(context?.directory)
  const entries = [
    ...readScopedAgents('machine'),
    ...(projectDirectory ? readScopedAgents('project', projectDirectory) : []),
  ]
  return mergeByName(entries)
}

export function saveCustomAgent(agent: CustomAgentConfig, permission: Record<string, unknown>) {
  const root = ensureDirectory(agentsDirForTarget(agent.scope, agent.directory))
  rmSync(agentMarkdownPath(root, agent.name, true), { force: true })
  rmSync(agentMarkdownPath(root, agent.name, false), { force: true })
  writeFileSync(
    agentMarkdownPath(root, agent.name, agent.enabled),
    serializeCustomAgentMarkdown(agent, permission),
  )
  writeJsonFile(agentMetaPath(root, agent.name), {
    color: agent.color,
    ...(agent.avatar ? { avatar: agent.avatar } : {}),
  })
  return true
}

export function removeCustomAgent(target: ScopedArtifactRef) {
  const root = ensureDirectory(agentsDirForTarget(target.scope, target.directory))
  rmSync(agentMarkdownPath(root, target.name, true), { force: true })
  rmSync(agentMarkdownPath(root, target.name, false), { force: true })
  rmSync(agentMetaPath(root, target.name), { force: true })
  return true
}
