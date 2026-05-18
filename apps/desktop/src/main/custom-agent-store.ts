import {
  basename,
  join,
} from 'path'
import { type Dirent, readdirSync, rmSync } from 'fs'
import {
  VALID_CUSTOM_AGENT_NAME,
  type AgentColor,
  type CustomAgentConfig,
  type RuntimeContextOptions,
  type ScopedArtifactRef,
} from '@open-cowork/shared'
import { getConfiguredToolPatterns, getConfiguredToolsFromConfig, getSidecarJsonSuffix } from './config-loader.ts'
import {
  readJsoncFile,
  writeJsonFile,
} from './jsonc.ts'
import { log } from './logger.ts'
import { writeFileAtomic } from './fs-atomic.ts'
import { readTextFileCheckedSync } from './fs-read.ts'
import {
  resolveProjectDirectory,
  type NativeConfigScope,
} from './runtime-paths.ts'
import { assertCustomAgentContentLimits } from './custom-content-limits.ts'
import {
  agentsDirForTarget,
  ensureDirectory,
  mergeByName,
  readStringArray,
  resolveContainedPath,
  targetDirectory,
  type JsonRecord,
} from './custom-store-common.ts'
import { readScopedMcps } from './custom-mcp-store.ts'
import { createAttachedSkillDirective } from './agent-prompts.ts'

type ManagedAgentMetadata = {
  color?: AgentColor
  // Optional data URI for a user-uploaded avatar. See the comment on
  // CustomAgentConfig.avatar in packages/shared/src/index.ts — stored
  // inline in the JSON sidecar so runtime-project-overlay picks it up
  // for free along with the agent's .md + .opencowork.json pair.
  avatar?: string
  // The Markdown `permission:` block remains the OpenCode-facing runtime
  // contract. These UI selections are duplicated in the Open Cowork sidecar
  // because some SDK-native tools (for example websearch/webfetch/bash) cannot
  // be reliably reverse-mapped from permission keys without a live SDK tool
  // catalog. Older files that lack these fields fall back to derivation below.
  skillNames?: string[]
  toolIds?: string[]
  deniedToolPatterns?: string[]
  model?: string | null
  variant?: string | null
  temperature?: number | null
  top_p?: number | null
  steps?: number | null
  options?: Record<string, unknown> | null
}

const RUNTIME_DIRECTIVE_START = '<!-- open-cowork:runtime-directive:start -->'
const RUNTIME_DIRECTIVE_END = '<!-- open-cowork:runtime-directive:end -->'

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const runtimeDirectivePattern = new RegExp(
  `${escapeRegExp(RUNTIME_DIRECTIVE_START)}[\\s\\S]*?${escapeRegExp(RUNTIME_DIRECTIVE_END)}\\s*`,
  'g',
)

function splitMarkdownFrontmatter(content: string) {
  const match = content.match(/^(---\r?\n[\s\S]*?\r?\n---)(?:\r?\n)?([\s\S]*)$/)
  if (!match) {
    return { frontmatter: '', body: content }
  }
  return {
    frontmatter: match[1] || '',
    body: match[2] || '',
  }
}

function splitInlineYamlMappingEntries(value: string) {
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null

  const inner = trimmed.slice(1, -1).trim()
  if (!inner) return []

  const entries: string[] = []
  let current = ''
  let quote: '"' | '\'' | null = null
  let depth = 0
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index]
    if (quote) {
      current += char
      if (char === quote && inner[index - 1] !== '\\') quote = null
      continue
    }
    if (char === '"' || char === '\'') {
      quote = char
      current += char
      continue
    }
    if (char === '{' || char === '[') {
      depth += 1
      current += char
      continue
    }
    if (char === '}' || char === ']') {
      depth = Math.max(0, depth - 1)
      current += char
      continue
    }
    if (char === ',' && depth === 0) {
      if (current.trim()) entries.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  if (current.trim()) entries.push(current.trim())
  return entries
}

function inlineYamlMappingKey(entry: string) {
  let quote: '"' | '\'' | null = null
  let depth = 0
  for (let index = 0; index < entry.length; index += 1) {
    const char = entry[index]
    if (quote) {
      if (char === quote && entry[index - 1] !== '\\') quote = null
      continue
    }
    if (char === '"' || char === '\'') {
      quote = char
      continue
    }
    if (char === '{' || char === '[') {
      depth += 1
      continue
    }
    if (char === '}' || char === ']') {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (char === ':' && depth === 0) {
      return entry.slice(0, index).trim().replace(/^['"]|['"]$/g, '')
    }
  }
  return ''
}

function parseYamlKeyLine(line: string, key: string, indent: string) {
  const match = line.match(/^(\s*)(['"]?)([^'":]+)\2\s*:(.*)$/)
  if (!match || match[1] !== indent || match[3]?.trim() !== key) return null
  return match[4]?.trim() ?? ''
}

function stripRuntimeDirective(markdown: string) {
  return markdown.replace(runtimeDirectivePattern, '').trim()
}

function createRuntimeDirective(skillNames: string[]) {
  const names = Array.from(new Set(skillNames.map((name) => name.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b))
  if (names.length === 0) return ''
  return [
    RUNTIME_DIRECTIVE_START,
    createAttachedSkillDirective(names),
    RUNTIME_DIRECTIVE_END,
  ].join('\n')
}

function renderAgentInstructionsForRuntime(instructions: string, skillNames: string[]) {
  const cleanInstructions = stripRuntimeDirective(instructions)
  const directive = createRuntimeDirective(skillNames)
  return [directive, cleanInstructions]
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n')
}

function readAgentInstructionsFromMarkdown(content: string) {
  return stripRuntimeDirective(splitMarkdownFrontmatter(content).body)
}

function ensureSkillWildcardDeny(frontmatter: string, skillNames: string[]) {
  if (skillNames.length === 0 || !frontmatter) return frontmatter
  const lines = frontmatter.split(/\r?\n/)
  const skillLineIndex = lines.findIndex((line) => parseYamlKeyLine(line, 'skill', '  ') !== null)
  if (skillLineIndex === -1) return frontmatter
  const skillLineValue = parseYamlKeyLine(lines[skillLineIndex] || '', 'skill', '  ') || ''
  const inlineEntries = splitInlineYamlMappingEntries(skillLineValue)
  if (inlineEntries) {
    if (inlineEntries.some((entry) => inlineYamlMappingKey(entry) === '*')) return frontmatter
    const nextLines = [...lines]
    nextLines.splice(skillLineIndex, 1, '  skill:', '    "*": deny', ...inlineEntries.map((entry) => `    ${entry}`))
    return nextLines.join('\n')
  }

  let index = skillLineIndex + 1
  while (index < lines.length && lines[index]?.startsWith('    ')) {
    const trimmed = lines[index]!.trim()
    if (/^['"]?\*['"]?\s*:/.test(trimmed)) return frontmatter
    index += 1
  }

  const nextLines = [...lines]
  nextLines.splice(skillLineIndex + 1, 0, '    "*": deny')
  return nextLines.join('\n')
}

function ensureTaskDefaultDeny(frontmatter: string) {
  if (!frontmatter) return frontmatter
  const lines = frontmatter.split(/\r?\n/)
  const permissionLineIndex = lines.findIndex((line) => parseYamlKeyLine(line, 'permission', '') !== null)
  if (permissionLineIndex === -1) {
    let closingIndex = -1
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (lines[index] === '---') {
        closingIndex = index
        break
      }
    }
    if (closingIndex <= 0) return frontmatter
    const nextLines = [...lines]
    nextLines.splice(closingIndex, 0, 'permission:', '  task: deny')
    return nextLines.join('\n')
  }
  const permissionLineValue = parseYamlKeyLine(lines[permissionLineIndex] || '', 'permission', '') || ''
  const inlineEntries = splitInlineYamlMappingEntries(permissionLineValue)
  if (inlineEntries) {
    const hasTask = inlineEntries.some((entry) => inlineYamlMappingKey(entry) === 'task')
    const nextLines = [...lines]
    nextLines.splice(
      permissionLineIndex,
      1,
      'permission:',
      ...inlineEntries.map((entry) => `  ${entry}`),
      ...(hasTask ? [] : ['  task: deny']),
    )
    return nextLines.join('\n')
  }
  if (permissionLineValue) return frontmatter

  let index = permissionLineIndex + 1
  while (index < lines.length && lines[index]?.startsWith('  ')) {
    const trimmed = lines[index]!.trim()
    if (/^['"]?task['"]?\s*:/.test(trimmed)) return frontmatter
    index += 1
  }

  const nextLines = [...lines]
  nextLines.splice(permissionLineIndex + 1, 0, '  task: deny')
  return nextLines.join('\n')
}

function applyCustomAgentPermissionDefaults(frontmatter: string, skillNames: string[]) {
  return ensureSkillWildcardDeny(ensureTaskDefaultDeny(frontmatter), skillNames)
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
      .filter(([key, value]) => key !== 'skill' && (value === 'allow' || value === 'ask'))
      .map(([key]) => key),
  )

  const configuredToolIds = getConfiguredToolsFromConfig()
    .filter((tool) => getConfiguredToolPatterns(tool).some((pattern) => patterns.has(pattern)))
    .map((tool) => tool.id)

  // Back-compat for custom agents saved before we duplicated the exact
  // builder selections into the Open Cowork sidecar. SDK-native tools
  // such as `websearch` / `webfetch` are represented as direct permission
  // keys, not MCP patterns, so there is nothing to reverse-map through
  // configured tool metadata.
  const nativeToolIds = Array.from(patterns)
    .filter((pattern) => !pattern.startsWith('mcp__') && /^[a-z][a-z0-9_-]*$/.test(pattern))

  const customMcpIds = [
    ...readScopedMcps('machine'),
    ...(scope === 'project' && directory ? readScopedMcps('project', directory) : []),
  ]
    .filter((mcp) => Array.from(patterns).some((pattern) => pattern === `mcp__${mcp.name}__*` || pattern.startsWith(`mcp__${mcp.name}__`)))
    .map((mcp) => mcp.name)

  return Array.from(new Set([...configuredToolIds, ...nativeToolIds, ...customMcpIds])).sort((a, b) => a.localeCompare(b))
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

function pushOptionalStringFrontmatter(lines: string[], key: string, value: string | null | undefined) {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed) return
  lines.push(`${key}: ${JSON.stringify(trimmed)}`)
}

function pushOptionalNumberFrontmatter(lines: string[], key: string, value: number | null | undefined, options?: { integer?: boolean }) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return
  const next = options?.integer ? Math.round(value) : value
  if (options?.integer && next <= 0) return
  lines.push(`${key}: ${String(next)}`)
}

function pushOptionalOptionsFrontmatter(lines: string[], value: Record<string, unknown> | null | undefined) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0) return
  lines.push(`options: ${JSON.stringify(value)}`)
}

function agentMetaPath(root: string, name: string) {
  return resolveContainedPath(root, `${name}${getSidecarJsonSuffix()}`, 'Custom agent metadata')
}

function agentMarkdownPath(root: string, name: string, enabled: boolean) {
  return resolveContainedPath(root, enabled ? `${name}.md` : `${name}.disabled.md`, 'Custom agent markdown')
}

function assertValidCustomAgentName(name: string) {
  const trimmed = name.trim()
  if (name === trimmed && VALID_CUSTOM_AGENT_NAME.test(trimmed)) return
  throw new Error('Custom agent id must use 1-64 lowercase letters, numbers, and single hyphens only.')
}

function assertSafeCustomAgentRemovalName(name: string) {
  if (!name || name.includes('\0') || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error('Custom agent id must be a single managed file name.')
  }
  if (Buffer.byteLength(name, 'utf8') > 256) {
    throw new Error('Custom agent id is too large.')
  }
}

function readManagedAgentMetadata(root: string, name: string): ManagedAgentMetadata {
  const path = agentMetaPath(root, name)
  try {
    const value = readJsoncFile<JsonRecord>(path)
    return {
      color: typeof value.color === 'string' ? value.color as AgentColor : undefined,
      avatar: typeof value.avatar === 'string' && value.avatar.length > 0 ? value.avatar : undefined,
      skillNames: readStringArray(value.skillNames),
      toolIds: readStringArray(value.toolIds),
      deniedToolPatterns: readStringArray(value.deniedToolPatterns),
      model: typeof value.model === 'string' && value.model.trim() ? value.model.trim() : null,
      variant: typeof value.variant === 'string' && value.variant.trim() ? value.variant.trim() : null,
      temperature: typeof value.temperature === 'number' && Number.isFinite(value.temperature) ? value.temperature : null,
      top_p: typeof value.top_p === 'number' && Number.isFinite(value.top_p) ? value.top_p : null,
      steps: typeof value.steps === 'number' && Number.isFinite(value.steps) && value.steps > 0 ? Math.round(value.steps) : null,
      options: value.options && typeof value.options === 'object' && !Array.isArray(value.options)
        ? value.options as Record<string, unknown>
        : null,
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
  ]
  pushOptionalStringFrontmatter(frontmatterLines, 'color', agent.color)
  pushOptionalStringFrontmatter(frontmatterLines, 'model', agent.model)
  pushOptionalStringFrontmatter(frontmatterLines, 'variant', agent.variant)
  pushOptionalNumberFrontmatter(frontmatterLines, 'temperature', agent.temperature)
  pushOptionalNumberFrontmatter(frontmatterLines, 'top_p', agent.top_p)
  pushOptionalNumberFrontmatter(frontmatterLines, 'steps', agent.steps, { integer: true })
  pushOptionalOptionsFrontmatter(frontmatterLines, agent.options)
  frontmatterLines.push('permission:')

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

  frontmatterLines.push('---')
  const frontmatter = applyCustomAgentPermissionDefaults(frontmatterLines.join('\n'), agent.skillNames || [])
  return `${[frontmatter, renderAgentInstructionsForRuntime(agent.instructions, agent.skillNames || [])]
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n')}\n`
}

function readScopedAgents(scope: NativeConfigScope, directory?: string | null) {
  const root = ensureDirectory(agentsDirForTarget(scope, directory))
  const entries = readdirSync(root, { withFileTypes: true })
  const agents: CustomAgentConfig[] = []

  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.endsWith('.md') && !entry.name.endsWith('.disabled.md')) continue
    if (entry.name.endsWith(getSidecarJsonSuffix())) continue

    const fullPath = join(root, entry.name)
    let content: string
    try {
      content = readTextFileCheckedSync(fullPath).content
    } catch {
      continue
    }

    const enabled = entry.name.endsWith('.md') && !entry.name.endsWith('.disabled.md')
    const name = basename(entry.name, enabled ? '.md' : '.disabled.md')
    const metadata = readManagedAgentMetadata(root, name)
    const frontmatter = parseFrontmatter(content)
    const permission = frontmatter.permission
    const derivedSkillNames = deriveSkillNamesFromPermission(permission)
    const derivedToolIds = deriveToolIdsFromPermission(permission, scope, directory)
    const derivedDenies = deriveDeniedToolPatternsFromPermission(permission)
    const skillNames = metadata.skillNames ?? derivedSkillNames
    const toolIds = metadata.toolIds ?? derivedToolIds
    const deniedToolPatterns = metadata.deniedToolPatterns ?? derivedDenies

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
      instructions: readAgentInstructionsFromMarkdown(content),
      skillNames,
      toolIds,
      enabled,
      color: metadata.color || 'accent',
      avatar: metadata.avatar || null,
      model: metadata.model ?? null,
      variant: metadata.variant ?? null,
      temperature: metadata.temperature ?? null,
      top_p: metadata.top_p ?? null,
      steps: metadata.steps ?? null,
      options: metadata.options ?? null,
      ...(deniedToolPatterns.length > 0 ? { deniedToolPatterns } : {}),
    })
  }

  return agents
}

export function listCustomAgents(context?: RuntimeContextOptions) {
  const projectDirectory = resolveProjectDirectory(context?.directory)
  const entries = [
    ...readScopedAgents('machine'),
    ...(projectDirectory ? readScopedAgents('project', projectDirectory) : []),
  ]
  return mergeByName(entries)
}

function syncScopedAgentRuntimeGuidance(scope: NativeConfigScope, directory?: string | null) {
  let root: string
  let entries: Dirent[]
  try {
    root = ensureDirectory(agentsDirForTarget(scope, directory))
    entries = readdirSync(root, { withFileTypes: true })
  } catch (err) {
    log('agents', `Skipped ${scope} custom-agent runtime guidance sync: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.endsWith('.md') && !entry.name.endsWith('.disabled.md')) continue
    if (entry.name.endsWith(getSidecarJsonSuffix())) continue

    const fullPath = join(root, entry.name)
    let content: string
    try {
      content = readTextFileCheckedSync(fullPath).content
    } catch {
      continue
    }

    const enabled = entry.name.endsWith('.md') && !entry.name.endsWith('.disabled.md')
    const name = basename(entry.name, enabled ? '.md' : '.disabled.md')
    const metadata = readManagedAgentMetadata(root, name)
    const frontmatter = parseFrontmatter(content)
    const skillNames = metadata.skillNames ?? deriveSkillNamesFromPermission(frontmatter.permission)
    const { frontmatter: frontmatterBlock } = splitMarkdownFrontmatter(content)
    const runtimeFrontmatter = applyCustomAgentPermissionDefaults(frontmatterBlock, skillNames)
    const runtimeBody = renderAgentInstructionsForRuntime(readAgentInstructionsFromMarkdown(content), skillNames)
    const nextContent = `${runtimeFrontmatter ? `${runtimeFrontmatter}\n\n` : ''}${runtimeBody}`.trimEnd() + '\n'
    if (nextContent !== content) {
      try {
        writeFileAtomic(fullPath, nextContent)
      } catch (err) {
        log('agents', `Skipped runtime guidance rewrite for ${fullPath}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
}

export function syncCustomAgentRuntimeGuidance(context?: RuntimeContextOptions) {
  const projectDirectory = resolveProjectDirectory(context?.directory)
  syncScopedAgentRuntimeGuidance('machine')
  if (projectDirectory) {
    syncScopedAgentRuntimeGuidance('project', projectDirectory)
  }
}

export function saveCustomAgent(agent: CustomAgentConfig, permission: Record<string, unknown>) {
  assertCustomAgentContentLimits(agent)
  assertValidCustomAgentName(agent.name)
  const root = ensureDirectory(agentsDirForTarget(agent.scope, agent.directory))
  writeFileAtomic(
    agentMarkdownPath(root, agent.name, agent.enabled),
    serializeCustomAgentMarkdown(agent, permission),
  )
  writeJsonFile(agentMetaPath(root, agent.name), {
    color: agent.color,
    skillNames: Array.from(new Set((agent.skillNames || []).map((name) => name.trim()).filter(Boolean))),
    toolIds: Array.from(new Set((agent.toolIds || []).map((id) => id.trim()).filter(Boolean))),
    deniedToolPatterns: Array.from(new Set((agent.deniedToolPatterns || []).map((pattern) => pattern.trim()).filter(Boolean))),
    ...(agent.avatar ? { avatar: agent.avatar } : {}),
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.variant ? { variant: agent.variant } : {}),
    ...(typeof agent.temperature === 'number' && Number.isFinite(agent.temperature) ? { temperature: agent.temperature } : {}),
    ...(typeof agent.top_p === 'number' && Number.isFinite(agent.top_p) ? { top_p: agent.top_p } : {}),
    ...(typeof agent.steps === 'number' && Number.isFinite(agent.steps) && agent.steps > 0 ? { steps: Math.round(agent.steps) } : {}),
    ...(agent.options && typeof agent.options === 'object' && Object.keys(agent.options).length > 0 ? { options: agent.options } : {}),
  })
  rmSync(agentMarkdownPath(root, agent.name, !agent.enabled), { force: true })
  return true
}

export function removeCustomAgent(target: ScopedArtifactRef) {
  assertSafeCustomAgentRemovalName(target.name)
  const root = ensureDirectory(agentsDirForTarget(target.scope, target.directory))
  rmSync(agentMarkdownPath(root, target.name, true), { force: true })
  rmSync(agentMarkdownPath(root, target.name, false), { force: true })
  rmSync(agentMetaPath(root, target.name), { force: true })
  return true
}
