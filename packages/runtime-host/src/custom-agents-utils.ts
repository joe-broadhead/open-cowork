import {
  getBrandName,
  getConfiguredAgentsFromConfig,
  getConfiguredSkillsFromConfig,
  getConfiguredToolAllowPatterns,
  getConfiguredToolAskPatterns,
  getConfiguredToolsFromConfig,
  expandMcpToolPermissionPatterns,
  type ConfiguredSkill,
  type ConfiguredTool,
} from '@open-cowork/runtime-host/config'
import {
  validateCustomAgentDraft,
  type AgentColor,
  type CustomAgentIssue,
  type CustomAgentMode,
  type CustomAgentPermissionAction,
  type CustomAgentPermissionKey,
  type CustomAgentPermissionOverride,
  type CustomAgentPermissionRule,
} from '@open-cowork/shared'
import type { NativeConfigScope } from './runtime-paths.js'
import { humanizeToolId, nativeToolPermissionPatterns, nativeToolSupportsWrite } from './runtime-tools.js'
import { validateCustomAgentContentLimits } from './custom-content-limits.js'
import { getEffectiveSettings } from './settings.js'

export type CustomSkillLike = {
  name: string
  content: string
  label?: string
  description?: string
  toolIds?: string[]
  source?: 'builtin' | 'custom'
  origin?: 'open-cowork' | 'custom'
  scope?: NativeConfigScope | null
  location?: string | null
}

export type CustomAgentLike = {
  scope?: NativeConfigScope
  directory?: string | null
  name: string
  description: string
  instructions: string
  skillNames: string[]
  toolIds: string[]
  enabled: boolean
  color: AgentColor
  avatar?: string | null
  mode?: CustomAgentMode
  // Inference tuning forwarded to the SDK AgentConfig. Optional.
  model?: string | null
  variant?: string | null
  temperature?: number | null
  top_p?: number | null
  steps?: number | null
  options?: Record<string, unknown> | null
  // Specific tool patterns to deny even when the parent MCP is allowed.
  // See `CustomAgentConfig.deniedToolPatterns` for the full contract.
  deniedToolPatterns?: string[]
  permissionOverrides?: CustomAgentPermissionOverride[]
}

export type NormalizedCustomAgent = Omit<CustomAgentLike, 'scope' | 'directory'> & {
  scope: NativeConfigScope
  directory: string | null
}

export type CustomAgentCatalogState = {
  customMcps?: Array<{ name: string; label?: string; description?: string; permissionMode?: 'ask' | 'allow' }>
  customSkills: CustomSkillLike[]
  customAgents: CustomAgentLike[]
  [key: string]: unknown
}

export type CustomAgentCatalogTool = {
  id: string
  name: string
  icon: string
  description: string
  supportsWrite: boolean
  source: 'builtin' | 'custom'
  patterns: string[]
  allowPatterns: string[]
  askPatterns: string[]
}

export type CustomAgentCatalogSkill = {
  name: string
  label: string
  description: string
  source: 'builtin' | 'custom'
  origin?: 'open-cowork' | 'custom'
  scope?: NativeConfigScope | null
  location?: string | null
  toolIds?: string[]
}

export type CustomAgentCatalog = {
  tools: CustomAgentCatalogTool[]
  skills: CustomAgentCatalogSkill[]
  reservedNames: string[]
  colors: AgentColor[]
}

export type CustomAgentSummary = CustomAgentLike & {
  writeAccess: boolean
  valid: boolean
  issues: CustomAgentIssue[]
}

export type RuntimeCustomAgent = {
  name: string
  description: string
  instructions: string
  skillNames: string[]
  toolNames: string[]
  writeAccess: boolean
  color: AgentColor
  allowPatterns: string[]
  askPatterns: string[]
  deniedPatterns: string[]
  disabled: boolean
  mode: CustomAgentMode
  model?: string | null
  variant?: string | null
  temperature?: number | null
  top_p?: number | null
  steps?: number | null
  options?: Record<string, unknown> | null
}

export const CUSTOM_AGENT_COLORS: AgentColor[] = [
  'accent',
  'primary',
  'success',
  'info',
  'warning',
  'secondary',
]

export const RESERVED_AGENT_NAMES = [
  'plan',
  'explore',
  'build',
  'general',
  'title',
  'summary',
  'compaction',
  'cleo',
  'chief-of-staff',
  'executive-assistant',
  'autoresearch',
]

const BUILT_IN_NATIVE_AGENT_TOOLS: CustomAgentCatalogTool[] = [
  {
    id: 'task',
    name: 'Task Delegation',
    icon: 'task',
    description: 'Allow this agent to delegate work to another OpenCode agent.',
    supportsWrite: true,
    source: 'builtin',
    patterns: ['task'],
    allowPatterns: ['task'],
    askPatterns: [],
  },
]

function unique(values: string[]) {
  return Array.from(new Set(values))
}

const CUSTOM_AGENT_PERMISSION_KEYS = new Set<CustomAgentPermissionKey>([
  'web',
  'edit',
  'bash',
  'task',
  'external_directory',
  'mcp',
])

const WRITE_PERMISSION_FAMILIES = new Set<CustomAgentPermissionKey>([
  'edit',
  'bash',
  'task',
  'external_directory',
  'mcp',
])

function normalizePermissionAction(value: unknown): CustomAgentPermissionAction {
  return value === 'allow' || value === 'ask' || value === 'deny' ? value : 'deny'
}

function normalizePermissionMode(value: unknown): CustomAgentMode {
  return value === 'primary' ? 'primary' : 'subagent'
}

function permissionOverrideSupportsRules(key: CustomAgentPermissionKey) {
  return Boolean(key)
}

const PERMISSION_ACTION_RANK: Record<CustomAgentPermissionAction, number> = {
  deny: 0,
  ask: 1,
  allow: 2,
}

function clampPermissionAction(
  action: CustomAgentPermissionAction,
  maximum: CustomAgentPermissionAction | null,
): CustomAgentPermissionAction {
  if (!maximum) return action
  return PERMISSION_ACTION_RANK[action] <= PERMISSION_ACTION_RANK[maximum] ? action : maximum
}

const NON_MCP_PERMISSION_KEYS = new Set([
  'skill',
  'question',
  'task',
  'external_directory',
  'doom_loop',
  'todowrite',
  'codesearch',
  'webfetch',
  'websearch',
  'lsp',
  'bash',
  'edit',
  'write',
  'apply_patch',
  'read',
  'grep',
  'glob',
  'list',
])

const isAliasAlnum = (code: number) =>
  (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
const isAliasPrefixChar = (code: number) => isAliasAlnum(code) || code === 95 /* _ */ || code === 45 /* - */
const isAliasSuffixChar = (code: number) =>
  isAliasAlnum(code) || code === 95 /* _ */ || code === 42 /* * */ || code === 45 /* - */

// Linear (no-backtracking) equivalent of /^[a-z0-9][a-z0-9_-]*_(?:\*|[a-z0-9][a-z0-9_*-]*)$/i.
// That regex's two overlapping quantifiers around the '_' separator, anchored by $, are
// polynomial-ReDoS. Accepts: alnum start, a '_' separator, then a suffix that is exactly
// '*' or alnum-then-[a-z0-9_*-]. A bool result needs only that SOME valid separator exists.
function isLegacyAliasShape(key: string): boolean {
  const n = key.length
  if (n === 0 || !isAliasAlnum(key.charCodeAt(0))) return false
  let prefixEnd = 0
  while (prefixEnd < n && isAliasPrefixChar(key.charCodeAt(prefixEnd))) prefixEnd += 1
  for (let s = 1; s < prefixEnd; s += 1) {
    if (key.charCodeAt(s) !== 95 /* _ */) continue
    const start = s + 1
    if (start >= n) continue
    if (n - start === 1 && key.charCodeAt(start) === 42 /* * */) return true
    if (!isAliasAlnum(key.charCodeAt(start))) continue
    let suffixOk = true
    for (let i = start + 1; i < n; i += 1) {
      if (!isAliasSuffixChar(key.charCodeAt(i))) { suffixOk = false; break }
    }
    if (suffixOk) return true
  }
  return false
}

function isLegacyMcpAliasPermissionKey(key: string) {
  if (NON_MCP_PERMISSION_KEYS.has(key)) return false
  if (key.startsWith('repo_')) return false
  if (key.startsWith('mcp__')) return false
  return isLegacyAliasShape(key)
}

function isMcpPermissionRulePattern(pattern: string) {
  if (pattern.startsWith('mcp__')) {
    return /^mcp__[a-z0-9][a-z0-9-]*(?:_[a-z0-9-]+)*__[^/]+$/i.test(pattern)
  }
  return isLegacyMcpAliasPermissionKey(pattern)
}

function normalizePermissionRule(key: CustomAgentPermissionKey, rule: CustomAgentPermissionRule): CustomAgentPermissionRule | null {
  const pattern = typeof rule.pattern === 'string' ? rule.pattern.trim() : ''
  if (!pattern) return null
  if (/[\r\n\0]/.test(pattern)) return null
  if (key === 'mcp' && !isMcpPermissionRulePattern(pattern)) return null
  return {
    pattern,
    action: normalizePermissionAction(rule.action),
  }
}

function validatePermissionOverrideRules(overrides?: CustomAgentPermissionOverride[] | null): CustomAgentIssue[] {
  const issues: CustomAgentIssue[] = []
  if (!Array.isArray(overrides)) return issues
  for (const [overrideIndex, override] of overrides.entries()) {
    if (!override || override.key !== 'mcp') continue
    for (const [ruleIndex, rule] of (override.rules || []).entries()) {
      const pattern = typeof rule.pattern === 'string' ? rule.pattern.trim() : ''
      if (!pattern || /[\r\n\0]/.test(pattern)) continue
      if (isMcpPermissionRulePattern(pattern)) continue
      issues.push({
        code: `permission_rule_pattern_invalid_mcp_${overrideIndex}_${ruleIndex}`,
        message: 'MCP tools permission rule pattern must be an MCP tool pattern like mcp__server__tool or server_tool.',
      })
    }
  }
  return issues
}

export function normalizeCustomAgentPermissionOverrides(overrides?: CustomAgentPermissionOverride[] | null): CustomAgentPermissionOverride[] {
  if (!Array.isArray(overrides)) return []
  const byKey = new Map<CustomAgentPermissionKey, CustomAgentPermissionOverride>()
  for (const entry of overrides) {
    if (!entry || !CUSTOM_AGENT_PERMISSION_KEYS.has(entry.key)) continue
    const rules = permissionOverrideSupportsRules(entry.key)
      ? (entry.rules || [])
        .map((rule) => normalizePermissionRule(entry.key, rule))
        .filter((rule): rule is CustomAgentPermissionRule => Boolean(rule))
      : []
    byKey.set(entry.key, {
      key: entry.key,
      action: normalizePermissionAction(entry.action),
      ...(rules.length > 0 ? { rules } : {}),
    })
  }
  return Array.from(byKey.values()).sort((a, b) => a.key.localeCompare(b.key))
}

function humanize(value: string) {
  return value
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

// JavaScript line terminators: `.` never matches these and `^`/`$` (with the `m` flag) break on
// them. The frontmatter locators below use a literal `\n`, so a value ends at the first of these.
const FRONTMATTER_LINE_TERMINATOR = /[\n\r\u2028\u2029]/

// Linear-time replacement for the value half of the old frontmatter regex
// (`\s*["']?(.+?)["']?\s*(?:\n|$)` followed by `.trim()`), which had super-linear backtracking
// because the lazy `(.+?)` capture overlapped the trailing `\s*`. `tail` is everything after the
// `key:` literal; this returns the same trimmed value, or null when the old regex would not match.
function parseFrontmatterValue(tail: string): string | null {
  const isHorizontalWhitespace = (ch: string) => /\s/.test(ch) && !FRONTMATTER_LINE_TERMINATOR.test(ch)
  const isQuote = (ch: string) => ch === '"' || ch === "'"
  // Leading `\s*` skips all whitespace (newlines included) to the first non-whitespace char.
  let valueStart = -1
  for (let i = 0; i < tail.length; i++) {
    if (!/\s/.test(tail.charAt(i))) { valueStart = i; break }
  }
  if (valueStart === -1) {
    // Only whitespace remains: the old regex still matched (capturing a single whitespace char that
    // trims to '') as long as `.` had a non-line-terminator char to consume; otherwise no match.
    for (let i = 0; i < tail.length; i++) {
      if (!FRONTMATTER_LINE_TERMINATOR.test(tail.charAt(i))) return ''
    }
    return null
  }
  // The value lives on the line of that first non-whitespace char (`.` cannot cross a terminator).
  let lineEnd = tail.length
  for (let i = valueStart; i < tail.length; i++) {
    if (FRONTMATTER_LINE_TERMINATOR.test(tail.charAt(i))) { lineEnd = i; break }
  }
  const line = tail.slice(valueStart, lineEnd)
  // Optional single surrounding quote (matching the leading/trailing `["']?`), then trim.
  const start = line.length >= 2 && isQuote(line.charAt(0)) ? 1 : 0
  let trailing = line.length
  while (trailing > start && isHorizontalWhitespace(line.charAt(trailing - 1))) trailing--
  let end: number
  if (trailing <= start) end = start + 1
  else if (isQuote(line.charAt(trailing - 1)) && trailing - 1 >= start + 1) end = trailing - 1
  else end = trailing
  return line.slice(start, end).trim()
}

function extractFrontmatterDescription(content: string) {
  const match = content.match(/^---\n[\s\S]*?\ndescription:([\s\S]*)/m)
  if (!match) return null
  return parseFrontmatterValue(match[1] ?? '')
}

function extractFrontmatterName(content: string) {
  const match = content.match(/^---\n[\s\S]*?\n(?:title|name):([\s\S]*)/m)
  if (!match) return null
  return parseFrontmatterValue(match[1] ?? '')
}

export function normalizeCustomAgent(input: CustomAgentLike): NormalizedCustomAgent {
  const trimmedModel = typeof input.model === 'string' ? input.model.trim() : ''
  const trimmedVariant = typeof input.variant === 'string' ? input.variant.trim() : ''
  const trimmedAvatar = typeof input.avatar === 'string' ? input.avatar.trim() : ''
  return {
    scope: input.scope === 'project' ? 'project' : 'machine',
    directory: input.scope === 'project' ? input.directory || null : null,
    name: (input.name || '').trim().toLowerCase(),
    description: (input.description || '').trim(),
    instructions: (input.instructions || '').trim(),
    skillNames: unique((input.skillNames || []).map((value) => value.trim()).filter(Boolean)),
    toolIds: unique((input.toolIds || []).map((value) => value.trim()).filter(Boolean)),
    enabled: input.enabled !== false,
    color: CUSTOM_AGENT_COLORS.includes(input.color) ? input.color : 'accent',
    avatar: trimmedAvatar ? trimmedAvatar : null,
    mode: normalizePermissionMode(input.mode),
    model: trimmedModel ? trimmedModel : null,
    variant: trimmedVariant ? trimmedVariant : null,
    temperature: typeof input.temperature === 'number' && Number.isFinite(input.temperature) ? input.temperature : null,
    top_p: typeof input.top_p === 'number' && Number.isFinite(input.top_p) ? input.top_p : null,
    steps: typeof input.steps === 'number' && Number.isFinite(input.steps) && input.steps > 0 ? Math.round(input.steps) : null,
    options: input.options && typeof input.options === 'object' ? { ...input.options } : null,
    deniedToolPatterns: unique((input.deniedToolPatterns || []).map((value) => value.trim()).filter(Boolean)),
    permissionOverrides: normalizeCustomAgentPermissionOverrides(input.permissionOverrides),
  }
}

function buildBuiltinToolCatalogEntry(tool: ConfiguredTool): CustomAgentCatalogTool {
  const allowPatterns = getConfiguredToolAllowPatterns(tool)
  const askPatterns = getConfiguredToolAskPatterns(tool)
  const patterns = Array.from(new Set([
    ...allowPatterns,
    ...askPatterns,
    ...(tool.patterns || []),
  ]))

  return {
    id: tool.id,
    name: tool.name,
    icon: tool.icon || tool.id,
    description: tool.description,
    supportsWrite: tool.writeAccess === true || (tool.writeAccess !== false && askPatterns.length > 0),
    source: 'builtin',
    patterns,
    allowPatterns,
    askPatterns,
  }
}

function buildBuiltinSkillCatalogEntry(skill: ConfiguredSkill): CustomAgentCatalogSkill {
  return {
    name: skill.sourceName,
    label: skill.name,
    description: skill.description,
    source: 'builtin',
    origin: 'open-cowork',
    toolIds: [...(skill.toolIds || [])],
  }
}

export function buildCustomAgentCatalog(input: {
  builtinTools?: ConfiguredTool[]
  builtinSkills?: ConfiguredSkill[]
  runtimeTools?: Array<{ id: string; description: string }>
  availableSkills?: CustomAgentCatalogSkill[]
  customMcps: Array<{ name: string; label?: string; description?: string; permissionMode?: 'ask' | 'allow' }>
  customSkills: CustomSkillLike[]
  state: CustomAgentCatalogState
}): CustomAgentCatalog {
  const builtinTools = input.builtinTools || getConfiguredToolsFromConfig()
  const builtinSkills = input.builtinSkills || getConfiguredSkillsFromConfig()

  const tools = new Map<string, CustomAgentCatalogTool>(
    builtinTools
      .map(buildBuiltinToolCatalogEntry)
      .map((tool) => [tool.id, tool]),
  )

  for (const tool of BUILT_IN_NATIVE_AGENT_TOOLS) {
    tools.set(tool.id, tool)
  }

  for (const runtimeTool of input.runtimeTools || []) {
    if (!runtimeTool.id || tools.has(runtimeTool.id)) continue
    const supportsWrite = nativeToolSupportsWrite(runtimeTool.id)
    const permissionPatterns = nativeToolPermissionPatterns(runtimeTool.id)
    tools.set(runtimeTool.id, {
      id: runtimeTool.id,
      name: humanizeToolId(runtimeTool.id),
      icon: runtimeTool.id,
      description: runtimeTool.description,
      supportsWrite,
      source: 'builtin',
      patterns: [runtimeTool.id],
      allowPatterns: permissionPatterns.allowPatterns,
      askPatterns: permissionPatterns.askPatterns,
    })
  }

  for (const mcp of input.customMcps || []) {
    if (!mcp.name) continue
    const mcpPatterns = expandMcpToolPermissionPatterns([`mcp__${mcp.name}__*`])
    const permissionMode = mcp.permissionMode === 'allow' ? 'allow' : 'ask'
    tools.set(mcp.name, {
      id: mcp.name,
      name: mcp.label?.trim() || humanize(mcp.name),
      icon: mcp.name,
      description: mcp.description?.trim() || 'Custom MCP server',
      supportsWrite: true,
      source: 'custom',
      patterns: mcpPatterns,
      allowPatterns: permissionMode === 'allow' ? mcpPatterns : [],
      askPatterns: permissionMode === 'ask' ? mcpPatterns : [],
    })
  }

  const skills = new Map<string, CustomAgentCatalogSkill>()
  if (input.availableSkills && input.availableSkills.length > 0) {
    for (const skill of input.availableSkills) {
      skills.set(skill.name, skill)
    }
  } else {
    for (const skill of builtinSkills) {
      skills.set(skill.sourceName, buildBuiltinSkillCatalogEntry(skill))
    }

    for (const skill of input.customSkills) {
      skills.set(skill.name, {
        name: skill.name,
        label: skill.label || humanize(extractFrontmatterName(skill.content) || skill.name),
        description: skill.description || extractFrontmatterDescription(skill.content) || 'Custom skill',
        source: skill.source || 'custom',
        origin: skill.origin,
        scope: skill.scope || undefined,
        location: skill.location || undefined,
        toolIds: skill.toolIds,
      })
    }
  }

  return {
    tools: Array.from(tools.values()).sort((a, b) => a.name.localeCompare(b.name)),
    skills: Array.from(skills.values()).sort((a, b) => a.label.localeCompare(b.label)),
    reservedNames: unique([
      ...RESERVED_AGENT_NAMES,
      ...getConfiguredAgentsFromConfig().map((agent) => agent.name),
    ]).sort((a, b) => a.localeCompare(b)),
    colors: [...CUSTOM_AGENT_COLORS],
  }
}

export function validateCustomAgent(agent: CustomAgentLike, catalog: CustomAgentCatalog, siblingNames: string[] = []): CustomAgentIssue[] {
  const normalized = normalizeCustomAgent(agent)
  const issues: CustomAgentIssue[] = validatePermissionOverrideRules(agent.permissionOverrides)
  issues.push(...validateCustomAgentContentLimits(normalized))
  issues.push(...validateCustomAgentDraft({
    name: normalized.name,
    description: normalized.description,
    scope: normalized.scope,
    directory: normalized.directory,
    reservedNames: catalog.reservedNames,
    siblingNames,
    availableToolIds: catalog.tools.map((tool) => tool.id),
    availableSkillNames: catalog.skills.map((skill) => skill.name),
    toolIds: normalized.toolIds,
    skillNames: normalized.skillNames,
    brandName: getBrandName(),
  }))

  return issues
}

export function buildCustomAgentPermissionFromCatalog(agent: CustomAgentLike, catalog: CustomAgentCatalog) {
  const normalized = normalizeCustomAgent(agent)
  const selectedTools = catalog.tools.filter((tool) => normalized.toolIds.includes(tool.id))
  const allowPatterns = Array.from(new Set(selectedTools.flatMap((tool) => tool.allowPatterns)))
  const askPatterns = Array.from(new Set(selectedTools.flatMap((tool) => tool.askPatterns)))
  const deniedPatterns = Array.from(new Set((normalized.deniedToolPatterns || []).map((pattern) => pattern.trim()).filter(Boolean)))

  const permission: Record<string, unknown> = { task: 'deny' }
  if (normalized.skillNames.length > 0) {
    permission.skill = {
      '*': 'deny',
      ...Object.fromEntries(normalized.skillNames.map((name) => [name, 'allow'])),
    }
  }

  const permissionOverrides = normalized.permissionOverrides || []
  for (const pattern of allowPatterns) permission[pattern] = 'allow'
  for (const pattern of askPatterns) permission[pattern] = 'ask'
  applyCustomAgentPermissionDefaultOverrides(permission, permissionOverrides)
  applyCustomAgentPermissionRuleOverrides(permission, permissionOverrides)
  for (const pattern of deniedPatterns) permission[pattern] = 'deny'
  applyCustomAgentRuntimePermissionCeilings(permission)
  return permission
}

function applyCustomAgentPermissionDefaultOverrides(
  permission: Record<string, unknown>,
  overrides: CustomAgentPermissionOverride[],
) {
  for (const override of overrides) {
    if (override.key !== 'mcp' && override.key !== 'web' && (override.rules || []).length > 0 && !overrideUsesExactPermissionKeyRules(override)) {
      for (const key of permissionKeysForOverride(override.key)) {
        permission[key] = buildCappedPermissionRuleMap(key, override)
      }
      continue
    }
    const permissionKeys = override.key === 'mcp'
      ? mcpPermissionKeysForDefaultOverride(permission)
      : permissionKeysForOverride(override.key)
    for (const key of permissionKeys) {
      permission[key] = cappedPermissionActionForKey(key, override.action)
    }
  }
}

function applyCustomAgentPermissionRuleOverrides(
  permission: Record<string, unknown>,
  overrides: CustomAgentPermissionOverride[],
) {
  for (const override of overrides) {
    if (override.key !== 'mcp' && !overrideUsesExactPermissionKeyRules(override)) continue
    for (const rule of override.rules || []) {
      const patterns = override.key === 'mcp'
        ? expandMcpToolPermissionPatterns([rule.pattern])
        : [rule.pattern]
      for (const pattern of patterns) permission[pattern] = cappedPermissionActionForKey(pattern, rule.action)
    }
  }
}

function overrideUsesExactPermissionKeyRules(override: CustomAgentPermissionOverride) {
  const rules = override.rules || []
  if (rules.length === 0) return false
  const permissionKeys = new Set(permissionKeysForOverride(override.key))
  return rules.every((rule) => permissionKeys.has(rule.pattern))
}

function buildCappedPermissionRuleMap(permissionKey: string, override: CustomAgentPermissionOverride) {
  return {
    '*': cappedPermissionActionForKey(permissionKey, override.action),
    ...Object.fromEntries((override.rules || []).map((rule) => [
      rule.pattern,
      cappedPermissionActionForKey(permissionKey, rule.action),
    ])),
  }
}

function cappedPermissionActionForKey(
  permissionKey: string,
  action: CustomAgentPermissionAction,
): CustomAgentPermissionAction {
  return clampPermissionAction(action, maximumPermissionActionForKey(permissionKey))
}

function isPermissionAction(value: unknown): value is CustomAgentPermissionAction {
  return value === 'allow' || value === 'ask' || value === 'deny'
}

function applyCustomAgentRuntimePermissionCeilings(permission: Record<string, unknown>) {
  for (const [key, value] of Object.entries(permission)) {
    const maximum = maximumPermissionActionForKey(key)
    if (!maximum) continue
    if (isPermissionAction(value)) {
      permission[key] = clampPermissionAction(value, maximum)
      continue
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      permission[key] = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([pattern, action]) => [
        pattern,
        isPermissionAction(action) ? clampPermissionAction(action, maximum) : action,
      ]))
    }
  }
}

function maximumPermissionActionForKey(permissionKey: string): CustomAgentPermissionAction | null {
  const settings = getEffectiveSettings()
  if (permissionKey === 'mcp__*' || permissionKey.startsWith('mcp__') || isLegacyMcpAliasPermissionKey(permissionKey)) {
    return settings.mcpPermission
  }
  switch (permissionKey) {
    case 'codesearch':
    case 'webfetch':
      return settings.webPermission
    case 'websearch':
      return settings.webSearchEnabled ? settings.webPermission : 'deny'
    case 'bash':
      return settings.bashPermission
    case 'edit':
    case 'write':
    case 'apply_patch':
      return settings.fileWritePermission
    case 'task':
      return settings.taskPermission
    case 'external_directory':
      return settings.externalDirectoryPermission
    default:
      return null
  }
}

function permissionKeysForOverride(key: CustomAgentPermissionKey): string[] {
  switch (key) {
    case 'web':
      return ['codesearch', 'webfetch', 'websearch']
    case 'edit':
      return ['edit', 'write', 'apply_patch']
    case 'mcp':
      return ['mcp__*']
    default:
      return [key]
  }
}

function permissionFamilyForPattern(pattern: string): CustomAgentPermissionKey | null {
  if (pattern === 'bash') return 'bash'
  if (pattern === 'task') return 'task'
  if (pattern === 'external_directory') return 'external_directory'
  if (pattern === 'edit' || pattern === 'write' || pattern === 'apply_patch') return 'edit'
  if (pattern.startsWith('mcp__')) return 'mcp'
  if (isLegacyMcpAliasPermissionKey(pattern)) return 'mcp'
  return null
}

function writeFamiliesForTool(tool: CustomAgentCatalogTool): string[] {
  if (!tool.supportsWrite) return []
  const families = new Set<string>()
  for (const pattern of [...tool.patterns, ...tool.allowPatterns, ...tool.askPatterns]) {
    const family = permissionFamilyForPattern(pattern)
    if (family && WRITE_PERMISSION_FAMILIES.has(family)) families.add(family)
  }
  const fallbackFamily = permissionFamilyForPattern(tool.id)
  if (families.size === 0 && fallbackFamily && WRITE_PERMISSION_FAMILIES.has(fallbackFamily)) {
    families.add(fallbackFamily)
  }
  if (families.size === 0) families.add(`tool:${tool.id}`)
  return Array.from(families)
}

function overrideGrantsWriteAccess(override: CustomAgentPermissionOverride): boolean {
  return override.action === 'allow' ||
    override.action === 'ask' ||
    (override.rules || []).some((rule) => rule.action === 'allow' || rule.action === 'ask')
}

function legacyAliasForMcpPermissionPattern(pattern: string) {
  const match = pattern.match(/^mcp__([a-z0-9][a-z0-9_-]*)__([^/]+)$/i)
  if (!match?.[1] || !match[2]) return null
  return `${match[1]}_${match[2]}`
}

function mcpPermissionKeysForDefaultOverride(permission: Record<string, unknown>) {
  const keys = new Set(['mcp__*'])
  for (const key of Object.keys(permission)) {
    if (key.startsWith('mcp__')) {
      keys.add(key)
      const alias = legacyAliasForMcpPermissionPattern(key)
      if (alias) keys.add(alias)
    } else if (isLegacyMcpAliasPermissionKey(key)) {
      keys.add(key)
    }
  }
  return Array.from(keys)
}

function deriveWriteCapability(agent: CustomAgentLike, catalog: CustomAgentCatalog) {
  const toolMap = new Map(catalog.tools.map((tool) => [tool.id, tool]))
  const writeFamilies = new Set<string>()
  for (const tool of agent.toolIds
    .map((toolId) => toolMap.get(toolId))
    .filter((entry): entry is CustomAgentCatalogTool => Boolean(entry))) {
    for (const family of writeFamiliesForTool(tool)) writeFamilies.add(family)
  }
  for (const override of agent.permissionOverrides || []) {
    if (!WRITE_PERMISSION_FAMILIES.has(override.key)) continue
    if (overrideGrantsWriteAccess(override)) {
      writeFamilies.add(override.key)
    } else if (override.action === 'deny') {
      writeFamilies.delete(override.key)
    }
  }
  if (writeFamilies.size > 0) return true
  return (agent.permissionOverrides || []).some((override) => (
    (override.key === 'edit' || override.key === 'bash' || override.key === 'task' || override.key === 'external_directory' || override.key === 'mcp') &&
    (
      override.action === 'allow' ||
      override.action === 'ask' ||
      (override.rules || []).some((rule) => rule.action === 'allow' || rule.action === 'ask')
    )
  ))
}

export function summarizeCustomAgents(input: {
  state: CustomAgentCatalogState
  builtinTools?: ConfiguredTool[]
  builtinSkills?: ConfiguredSkill[]
  runtimeTools?: Array<{ id: string; description: string }>
  availableSkills?: CustomAgentCatalogSkill[]
}): CustomAgentSummary[] {
  const catalog = buildCustomAgentCatalog({
    builtinTools: input.builtinTools,
    builtinSkills: input.builtinSkills,
    runtimeTools: input.runtimeTools,
    availableSkills: input.availableSkills,
    customMcps: input.state.customMcps || [],
    customSkills: input.state.customSkills || [],
    state: input.state,
  })
  return summarizeCustomAgentsWithCatalog(input.state.customAgents || [], catalog)
}

function summarizeCustomAgentsWithCatalog(agents: CustomAgentLike[], catalog: CustomAgentCatalog): CustomAgentSummary[] {
  return agents.map((agent, index) => {
    const normalized = normalizeCustomAgent(agent)
    const siblingNames = agents
      .filter((_, siblingIndex) => siblingIndex !== index)
      .map((entry) => normalizeCustomAgent(entry).name)
    const issues = validateCustomAgent(agent, catalog, siblingNames)
    const writeAccess = deriveWriteCapability(normalized, catalog)
    return {
      ...normalized,
      writeAccess,
      valid: issues.length === 0,
      issues,
    }
  })
}

export function buildRuntimeCustomAgents(input: {
  state: CustomAgentCatalogState
  builtinTools?: ConfiguredTool[]
  builtinSkills?: ConfiguredSkill[]
  runtimeTools?: Array<{ id: string; description: string }>
  availableSkills?: CustomAgentCatalogSkill[]
}): RuntimeCustomAgent[] {
  const catalog = buildCustomAgentCatalog({
    builtinTools: input.builtinTools,
    builtinSkills: input.builtinSkills,
    runtimeTools: input.runtimeTools,
    availableSkills: input.availableSkills,
    customMcps: input.state.customMcps || [],
    customSkills: input.state.customSkills || [],
    state: input.state,
  })
  const summaries = summarizeCustomAgentsWithCatalog(input.state.customAgents || [], catalog)
  const toolNames = new Map(catalog.tools.map((tool) => [tool.id, tool.name]))

  return summaries
    .filter((agent) => agent.valid)
    .map((agent) => {
      const selectedTools = catalog.tools.filter((tool) => agent.toolIds.includes(tool.id))
      const allowPatterns = Array.from(new Set(selectedTools.flatMap((tool) => tool.allowPatterns)))
      const askPatterns = Array.from(new Set(selectedTools.flatMap((tool) => tool.askPatterns)))
      const deniedPatterns = Array.from(new Set(expandMcpToolPermissionPatterns(agent.deniedToolPatterns || [])))
      return {
        name: agent.name,
        description: agent.description,
        instructions: agent.instructions,
        skillNames: [...agent.skillNames],
        toolNames: agent.toolIds.map((toolId) => toolNames.get(toolId) || toolId),
        writeAccess: agent.writeAccess,
        color: agent.color,
        mode: agent.mode || 'subagent',
        allowPatterns,
        askPatterns,
        deniedPatterns,
        disabled: !agent.enabled,
        model: agent.model ?? null,
        variant: agent.variant ?? null,
        temperature: agent.temperature ?? null,
        top_p: agent.top_p ?? null,
        steps: agent.steps ?? null,
        options: agent.options ?? null,
      }
    })
}
