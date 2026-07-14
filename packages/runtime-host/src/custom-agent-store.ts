import { readJsoncFile, writeJsonFile } from './jsonc.js'
import { writeFileAtomic, readTextFileCheckedSync } from '@open-cowork/shared/node'
import {
  basename,
  join,
} from 'node:path'
import { existsSync, type Dirent, readdirSync, rmSync, statSync } from 'node:fs'
import {
  isMcpPermissionRulePattern,
  VALID_CUSTOM_AGENT_NAME,
  type AgentColor,
  type CustomAgentConfig,
  type CustomAgentMode,
  type CustomAgentPermissionAction,
  type CustomAgentPermissionKey,
  type CustomAgentPermissionOverride,
  type CustomAgentPermissionRule,
  type RuntimeContextOptions,
  type ScopedArtifactRef,
} from '@open-cowork/shared'
import { getConfiguredToolPatterns, getConfiguredToolsFromConfig, getSidecarJsonSuffix } from './config-loader-core.js'
import { log } from '@open-cowork/shared/node'
import {
  resolveProjectDirectory,
  type NativeConfigScope,
} from './runtime-paths.js'
import { assertCustomAgentContentLimits } from './custom-content-limits.js'
import {
  agentsDirForTarget,
  ensureDirectory,
  mergeByName,
  readStringArray,
  resolveContainedPath,
  targetDirectory,
  type JsonRecord,
} from './custom-store-common.js'
import { readScopedMcps } from './custom-mcp-store.js'
import { createAttachedSkillDirective } from './agent-prompts.js'
import {
  buildCustomAgentCatalog,
  buildCustomAgentPermissionFromCatalog,
} from './custom-agents-utils.js'

type ManagedAgentMetadata = {
  color?: AgentColor
  // Optional data URI for a user-uploaded avatar. See the comment on
  // CustomAgentConfig.avatar in packages/shared/src/index.ts — stored
  // inline in the JSON sidecar so runtime-project-overlay picks it up
  // for free along with the agent's .md + .opencowork.json pair.
  avatar?: string
  mode?: CustomAgentMode
  // The Markdown `permission:` block remains the OpenCode-facing runtime
  // contract. These UI selections are duplicated in the Open Cowork sidecar
  // because some SDK-native tools (for example websearch/webfetch/bash) cannot
  // be reliably reverse-mapped from permission keys without a live SDK tool
  // catalog. Older files that lack these fields fall back to derivation below.
  skillNames?: string[]
  toolIds?: string[]
  deniedToolPatterns?: string[]
  permissionOverrides?: CustomAgentPermissionOverride[]
  model?: string | null
  variant?: string | null
  temperature?: number | null
  top_p?: number | null
  steps?: number | null
  options?: Record<string, unknown> | null
}

type AgentMarkdownCandidate = {
  fullPath: string
  name: string
  enabled: boolean
  mtimeMs: number
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

function readAgentMode(value: unknown): CustomAgentMode {
  return value === 'primary' ? 'primary' : 'subagent'
}

function readOptionalStringFrontmatter(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readOptionalNumberFrontmatter(value: unknown, options?: { integer?: boolean }) {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value.trim())
      : Number.NaN
  if (!Number.isFinite(numeric)) return null
  const next = options?.integer ? Math.round(numeric) : numeric
  if (options?.integer && next <= 0) return null
  return next
}

function readOptionalOptionsFrontmatter(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function readPermissionOverrides(value: unknown): CustomAgentPermissionOverride[] | undefined {
  if (!Array.isArray(value)) return undefined
  const next: CustomAgentPermissionOverride[] = []
  for (const rawEntry of value) {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) continue
    const entry = rawEntry as Record<string, unknown>
    const key = entry.key
    if (
      key !== 'web' &&
      key !== 'edit' &&
      key !== 'bash' &&
      key !== 'task' &&
      key !== 'external_directory' &&
      key !== 'mcp'
    ) continue
    const action = entry.action === 'allow' || entry.action === 'ask' || entry.action === 'deny'
      ? entry.action
      : 'deny'
    const rules = Array.isArray(entry.rules)
      ? entry.rules.flatMap((rawRule) => {
          if (!rawRule || typeof rawRule !== 'object' || Array.isArray(rawRule)) return []
          const rule = rawRule as Record<string, unknown>
          const pattern = typeof rule.pattern === 'string' ? rule.pattern.trim() : ''
          if (!pattern || /[\r\n\0]/.test(pattern)) return []
          const ruleAction = rule.action === 'allow' || rule.action === 'ask' || rule.action === 'deny'
            ? rule.action
            : 'deny'
          return [{ pattern, action: ruleAction as CustomAgentPermissionOverride['action'] }]
        })
      : []
    next.push({
      key,
      action,
      ...(rules.length > 0 ? { rules } : {}),
    })
  }
  return next
}

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
  const separator = yamlKeyValueSeparator(entry)
  if (separator === -1) return ''
  return yamlKey(entry.slice(0, separator))
}

function parseYamlScalar(rawValue: string) {
  const quoted = rawValue.startsWith('"') || rawValue.startsWith('\'')
  if (quoted) {
    try {
      return rawValue.startsWith('"')
        ? JSON.parse(rawValue)
        : rawValue.slice(1, -1)
    } catch {
      return rawValue.replace(/^['"]|['"]$/g, '')
    }
  }
  if (rawValue === 'true') return true
  if (rawValue === 'false') return false
  if (rawValue === 'null') return null
  return rawValue
}

function parseInlineYamlMapping(value: string) {
  const entries = splitInlineYamlMappingEntries(value)
  if (!entries) return null
  const next: Record<string, unknown> = {}
  for (const entry of entries) {
    const separator = yamlKeyValueSeparator(entry)
    if (separator === -1) continue
    next[yamlKey(entry.slice(0, separator))] = parseYamlScalar(entry.slice(separator + 1).trim())
  }
  return next
}

function yamlKeyValueSeparator(entry: string) {
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
      return index
    }
  }
  return -1
}

function yamlKey(rawKey: string) {
  const trimmed = rawKey.trim()
  if (trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return trimmed.replace(/^"|"$/g, '')
    }
  }
  if (trimmed.startsWith('\'')) return trimmed.slice(1, -1)
  return trimmed
}

function permissionYamlKey(key: string) {
  return /^[A-Za-z0-9_./-]+$/.test(key) && !key.startsWith('*')
    ? key
    : JSON.stringify(key)
}

function parseYamlKeyLine(line: string, key: string, indent: string) {
  const actualIndent = line.match(/^\s*/)?.[0] || ''
  if (actualIndent !== indent) return null
  const content = line.slice(actualIndent.length)
  const separator = yamlKeyValueSeparator(content)
  if (separator === -1) return null
  if (yamlKey(content.slice(0, separator)) !== key) return null
  return content.slice(separator + 1).trim()
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
    const separator = yamlKeyValueSeparator(line)
    if (separator === -1) continue

    const key = yamlKey(line.slice(0, separator))
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

    const inlineMap = parseInlineYamlMapping(rawValue)
    if (inlineMap) {
      parent[key] = inlineMap
      continue
    }

    parent[key] = parseYamlScalar(rawValue)
  }

  return root
}

function agentMarkdownCandidate(root: string, entry: Dirent): AgentMarkdownCandidate | null {
  if (!entry.isFile()) return null
  if (!entry.name.endsWith('.md') && !entry.name.endsWith('.disabled.md')) return null
  if (entry.name.endsWith(getSidecarJsonSuffix())) return null

  const enabled = entry.name.endsWith('.md') && !entry.name.endsWith('.disabled.md')
  const name = basename(entry.name, enabled ? '.md' : '.disabled.md')
  const fullPath = join(root, entry.name)
  try {
    return {
      fullPath,
      name,
      enabled,
      mtimeMs: statSync(fullPath).mtimeMs,
    }
  } catch {
    return null
  }
}

function currentAgentMarkdownCandidates(root: string, entries: Dirent[]) {
  const byName = new Map<string, AgentMarkdownCandidate>()
  for (const entry of entries) {
    const candidate = agentMarkdownCandidate(root, entry)
    if (!candidate) continue
    const existing = byName.get(candidate.name)
    if (
      !existing
      || candidate.mtimeMs > existing.mtimeMs
      || (candidate.mtimeMs === existing.mtimeMs && !candidate.enabled && existing.enabled)
    ) {
      byName.set(candidate.name, candidate)
    }
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name))
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

  // OpenCode-native agent files can be edited outside the builder. SDK-native
  // tools such as `websearch` / `webfetch` are represented as direct permission
  // keys, not MCP patterns, so expose those direct keys as selected tools.
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

const PERMISSION_ACTION_RANK: Record<CustomAgentPermissionAction, number> = {
  deny: 0,
  ask: 1,
  allow: 2,
}

function readPermissionActionValue(value: unknown): CustomAgentPermissionAction | null {
  return value === 'allow' || value === 'ask' || value === 'deny' ? value : null
}

function strongestPermissionAction(actions: Array<CustomAgentPermissionAction | null | undefined>) {
  let strongest: CustomAgentPermissionAction | null = null
  for (const action of actions) {
    if (!action) continue
    if (!strongest || PERMISSION_ACTION_RANK[action] > PERMISSION_ACTION_RANK[strongest]) {
      strongest = action
    }
  }
  return strongest
}

function readPermissionRuleMap(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function rulesFromPermissionMap(
  value: unknown,
  filterPattern?: (pattern: string) => boolean,
): CustomAgentPermissionRule[] {
  const map = readPermissionRuleMap(value)
  if (!map) return []
  return Object.entries(map).flatMap(([pattern, rawAction]) => {
    if (pattern === '*') return []
    if (!pattern || /[\r\n\0]/.test(pattern)) return []
    if (filterPattern && !filterPattern(pattern)) return []
    const action = readPermissionActionValue(rawAction)
    return action ? [{ pattern, action }] : []
  })
}

function overrideFromDirectKeys(
  key: CustomAgentPermissionKey,
  permission: Record<string, unknown>,
  permissionKeys: string[],
): CustomAgentPermissionOverride | null {
  const entries = permissionKeys.flatMap((permissionKey) => {
    const action = readPermissionActionValue(permission[permissionKey])
    return action ? [{ pattern: permissionKey, action }] : []
  })
  if (entries.length === 0) return null
  const uniformAction = strongestPermissionAction(entries.map((entry) => entry.action))
  const coversWholeFamily = entries.length === permissionKeys.length
  const hasMixedActions = entries.some((entry) => entry.action !== uniformAction)
  if (coversWholeFamily && uniformAction && !hasMixedActions) return { key, action: uniformAction }
  return {
    key,
    action: 'deny',
    rules: entries,
  }
}

function overrideFromRuleMap(
  key: Extract<CustomAgentPermissionKey, 'task' | 'external_directory'>,
  value: unknown,
): CustomAgentPermissionOverride | null {
  const directAction = readPermissionActionValue(value)
  if (directAction) return { key, action: directAction }

  const map = readPermissionRuleMap(value)
  if (!map) return null
  const rules = rulesFromPermissionMap(map)
  const explicitDefault = readPermissionActionValue(map['*'])
  if (!explicitDefault && rules.length === 0) return null
  const action = explicitDefault || 'deny'
  return {
    key,
    action,
    ...(rules.length > 0 ? { rules } : {}),
  }
}

function deriveMcpPermissionOverride(permission: Record<string, unknown>): CustomAgentPermissionOverride | null {
  const rules = Object.entries(permission).flatMap(([pattern, rawAction]) => {
    if (pattern === 'mcp__*') return []
    if (!isMcpPermissionRulePattern(pattern)) return []
    const action = readPermissionActionValue(rawAction)
    return action ? [{ pattern, action }] : []
  })
  const explicitDefault = readPermissionActionValue(permission['mcp__*'])
  if (!explicitDefault && rules.length === 0) return null
  const action = explicitDefault || 'deny'
  return {
    key: 'mcp',
    action,
    ...(rules.length > 0 ? { rules } : {}),
  }
}

function derivePermissionOverridesFromPermission(permission: unknown) {
  if (!permission || typeof permission !== 'object' || Array.isArray(permission)) return []
  const record = permission as Record<string, unknown>
  const overrides = [
    overrideFromDirectKeys('web', record, ['codesearch', 'webfetch', 'websearch']),
    overrideFromDirectKeys('edit', record, ['edit', 'write', 'apply_patch']),
    overrideFromDirectKeys('bash', record, ['bash']),
    overrideFromRuleMap('task', record.task),
    overrideFromRuleMap('external_directory', record.external_directory),
    deriveMcpPermissionOverride(record),
  ].filter((entry): entry is CustomAgentPermissionOverride => Boolean(entry))

  return overrides.sort((a, b) => a.key.localeCompare(b.key))
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
      mode: value.mode === 'primary' || value.mode === 'subagent' ? value.mode : undefined,
      skillNames: readStringArray(value.skillNames),
      toolIds: readStringArray(value.toolIds),
      deniedToolPatterns: readStringArray(value.deniedToolPatterns),
      permissionOverrides: readPermissionOverrides(value.permissionOverrides),
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
    `mode: ${readAgentMode(agent.mode)}`,
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
      frontmatterLines.push(`  ${permissionYamlKey(key)}:`)
      for (const [nestedKey, nestedValue] of Object.entries(rawValue as Record<string, unknown>)) {
        frontmatterLines.push(`    ${JSON.stringify(nestedKey)}: ${String(nestedValue)}`)
      }
      continue
    }
    frontmatterLines.push(`  ${permissionYamlKey(key)}: ${String(rawValue)}`)
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

  for (const candidate of currentAgentMarkdownCandidates(root, entries)) {
    let content: string
    try {
      content = readTextFileCheckedSync(candidate.fullPath).content
    } catch {
      continue
    }

    const { enabled, name } = candidate
    const metadata = readManagedAgentMetadata(root, name)
    const frontmatter = parseFrontmatter(content)
    const permission = frontmatter.permission
    const derivedSkillNames = deriveSkillNamesFromPermission(permission)
    const derivedToolIds = deriveToolIdsFromPermission(permission, scope, directory)
    const derivedDenies = deriveDeniedToolPatternsFromPermission(permission)
    const derivedPermissionOverrides = derivePermissionOverridesFromPermission(permission)
    const skillNames = metadata.skillNames ?? derivedSkillNames
    const toolIds = metadata.toolIds ?? derivedToolIds
    const deniedToolPatterns = metadata.deniedToolPatterns ?? derivedDenies
    const permissionOverrides = metadata.permissionOverrides ?? derivedPermissionOverrides
    const mode = metadata.mode ?? readAgentMode(frontmatter.mode)

    agents.push({
      scope,
      directory: scope === 'project' ? targetDirectory(scope, directory) : null,
      mode,
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
      model: metadata.model ?? readOptionalStringFrontmatter(frontmatter.model),
      variant: metadata.variant ?? readOptionalStringFrontmatter(frontmatter.variant),
      temperature: metadata.temperature ?? readOptionalNumberFrontmatter(frontmatter.temperature),
      top_p: metadata.top_p ?? readOptionalNumberFrontmatter(frontmatter.top_p),
      steps: metadata.steps ?? readOptionalNumberFrontmatter(frontmatter.steps, { integer: true }),
      options: metadata.options ?? readOptionalOptionsFrontmatter(frontmatter.options),
      ...(deniedToolPatterns.length > 0 ? { deniedToolPatterns } : {}),
      ...(permissionOverrides.length > 0 ? { permissionOverrides } : {}),
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

  const projectDirectory = scope === 'project' ? targetDirectory(scope, directory) : null
  const customMcps = [
    ...readScopedMcps('machine'),
    ...(projectDirectory ? readScopedMcps('project', projectDirectory) : []),
  ]
  const catalog = buildCustomAgentCatalog({
    customMcps,
    customSkills: [],
    state: {
      customMcps,
      customSkills: [],
      customAgents: [],
    },
  })

  for (const candidate of currentAgentMarkdownCandidates(root, entries)) {
    let content: string
    try {
      content = readTextFileCheckedSync(candidate.fullPath).content
    } catch {
      continue
    }

    const { name } = candidate
    const metadataPath = agentMetaPath(root, name)
    const metadataExists = existsSync(metadataPath)
    const metadata = readManagedAgentMetadata(root, name)
    const frontmatter = parseFrontmatter(content)
    const skillNames = metadata.skillNames ?? deriveSkillNamesFromPermission(frontmatter.permission)
    const toolIds = metadata.toolIds ?? deriveToolIdsFromPermission(frontmatter.permission, scope, projectDirectory)
    const deniedToolPatterns = metadata.deniedToolPatterns ?? deriveDeniedToolPatternsFromPermission(frontmatter.permission)
    const permissionOverrides = metadata.permissionOverrides ?? derivePermissionOverridesFromPermission(frontmatter.permission)
    const agent = {
      scope,
      directory: projectDirectory,
      mode: metadata.mode ?? readAgentMode(frontmatter.mode),
      name,
      description: typeof frontmatter.description === 'string' ? frontmatter.description : '',
      instructions: readAgentInstructionsFromMarkdown(content),
      skillNames,
      toolIds,
      enabled: candidate.enabled,
      color: metadata.color || 'accent' as const,
      avatar: metadata.avatar || null,
      model: metadata.model ?? readOptionalStringFrontmatter(frontmatter.model),
      variant: metadata.variant ?? readOptionalStringFrontmatter(frontmatter.variant),
      temperature: metadata.temperature ?? readOptionalNumberFrontmatter(frontmatter.temperature),
      top_p: metadata.top_p ?? readOptionalNumberFrontmatter(frontmatter.top_p),
      steps: metadata.steps ?? readOptionalNumberFrontmatter(frontmatter.steps, { integer: true }),
      options: metadata.options ?? readOptionalOptionsFrontmatter(frontmatter.options),
      ...(deniedToolPatterns.length > 0 ? { deniedToolPatterns } : {}),
      ...(permissionOverrides.length > 0 ? { permissionOverrides } : {}),
    }
    const nextContent = serializeCustomAgentMarkdown(agent, buildCustomAgentPermissionFromCatalog(agent, catalog))
    if (nextContent !== content) {
      try {
        if (!metadataExists) {
          writeJsonFile(metadataPath, {
            color: agent.color,
            mode: readAgentMode(agent.mode),
            skillNames: Array.from(new Set(skillNames)),
            toolIds: Array.from(new Set(toolIds)),
            deniedToolPatterns: Array.from(new Set(deniedToolPatterns)),
            ...(permissionOverrides.length > 0 ? { permissionOverrides } : {}),
            ...(agent.model ? { model: agent.model } : {}),
            ...(agent.variant ? { variant: agent.variant } : {}),
            ...(typeof agent.temperature === 'number' && Number.isFinite(agent.temperature) ? { temperature: agent.temperature } : {}),
            ...(typeof agent.top_p === 'number' && Number.isFinite(agent.top_p) ? { top_p: agent.top_p } : {}),
            ...(typeof agent.steps === 'number' && Number.isFinite(agent.steps) && agent.steps > 0 ? { steps: Math.round(agent.steps) } : {}),
            ...(agent.options && typeof agent.options === 'object' && Object.keys(agent.options).length > 0 ? { options: agent.options } : {}),
          })
        }
        writeFileAtomic(candidate.fullPath, nextContent)
      } catch (err) {
        log('agents', `Skipped runtime guidance rewrite for ${candidate.fullPath}: ${err instanceof Error ? err.message : String(err)}`)
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
    mode: readAgentMode(agent.mode),
    skillNames: Array.from(new Set((agent.skillNames || []).map((name) => name.trim()).filter(Boolean))),
    toolIds: Array.from(new Set((agent.toolIds || []).map((id) => id.trim()).filter(Boolean))),
    deniedToolPatterns: Array.from(new Set((agent.deniedToolPatterns || []).map((pattern) => pattern.trim()).filter(Boolean))),
    ...(agent.permissionOverrides ? { permissionOverrides: agent.permissionOverrides } : {}),
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
