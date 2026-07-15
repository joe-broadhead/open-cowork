import {
  isMcpPermissionRulePattern,
  validateCustomAgentDraft,
  VALID_CUSTOM_AGENT_NAME,
} from '@open-cowork/shared'
import type {
  AgentCatalog,
  AgentCatalogSkill,
  AgentCatalogTool,
  AgentColor,
  CustomAgentConfig,
  CustomAgentIssue,
  CustomAgentPermissionKey,
  CustomAgentPermissionOverride,
} from '@open-cowork/shared'
import { getBrandName } from '../../helpers/brand.ts'

// Pure helpers for the agent builder. Kept separate from the React
// components so they're unit-testable, importable from both the list
// grid + the builder page, and easy to reason about.

export const VALID_AGENT_NAME = VALID_CUSTOM_AGENT_NAME

export { isMcpPermissionRulePattern }

// Two-letter initials from an agent name. Splits on hyphens and spaces so
// "sales-analyst" → "SA", "analyst" → "AN", "x" → "X". Used by the
// gradient avatar everywhere an agent is rendered.
export function agentInitials(label: string): string {
  const trimmed = (label || '').trim()
  if (!trimmed) return 'A'
  const parts = trimmed.split(/[\s-]+/).filter(Boolean)
  if (parts.length >= 2) {
    return (parts[0]![0]! + parts[1]![0]!).toUpperCase()
  }
  const only = parts[0]!
  return only.length >= 2
    ? (only[0]! + only[1]!).toUpperCase()
    : only[0]!.toUpperCase()
}

// Map the semantic AgentColor token to a concrete CSS color var. Single
// source of truth — every avatar / pill / stat tile goes through this.
export function agentTone(color?: AgentColor | string | null): string {
  switch (color) {
    case 'success': return 'var(--color-green)'
    case 'warning': return 'var(--color-amber)'
    case 'info': return 'var(--color-info)'
    case 'primary': return 'var(--color-text)'
    case 'secondary': return 'var(--color-text-secondary)'
    case 'accent':
    default: return 'var(--color-accent)'
  }
}

// Identity hue for avatars. Unlike agentTone (which can map to neutral text
// tokens), this ALWAYS returns a saturated colour, so every coworker has a
// visible identity on the graphite field — 'primary'/'secondary' agents used to
// render grey here, which was the root of the sterile/cheap feeling. Identity
// colour is the one designed splash of colour on the monochrome page; it lives
// only on the avatar tile (and the card's hover spine that echoes it).
export function agentChroma(color?: AgentColor | string | null): string {
  switch (color) {
    case 'success': return 'var(--color-green)'
    case 'warning': return 'var(--color-amber)'
    case 'info': return 'var(--color-info)'
    case 'secondary': return 'color-mix(in srgb, var(--color-accent) 70%, var(--color-info))'
    case 'primary':
    case 'accent':
    default: return 'var(--color-accent)'
  }
}

// Three effective scopes derived from selected tools:
//   read-only  — nothing the agent can do writes anywhere
//   standard   — one or two write-capable permission families
//   powerful   — three or more write-capable permission families (broad blast radius)
// The goal is to teach users that "more write authority = bigger footprint"
// without showing a permissions dialog.
export type AgentScope = 'read-only' | 'standard' | 'powerful'

const WRITE_PERMISSION_FAMILIES = new Set<CustomAgentPermissionKey>(['edit', 'bash', 'task', 'external_directory', 'mcp'])

function permissionFamilyForPattern(pattern: string): CustomAgentPermissionKey | null {
  if (pattern === 'bash') return 'bash'
  if (pattern === 'task') return 'task'
  if (pattern === 'external_directory') return 'external_directory'
  if (pattern === 'edit' || pattern === 'write' || pattern === 'apply_patch') return 'edit'
  if (pattern.startsWith('mcp__')) return 'mcp'
  return null
}

function writeFamiliesForTool(tool: AgentCatalogTool): string[] {
  if (!tool.supportsWrite) return []
  const families = new Set<string>()
  for (const pattern of tool.patterns) {
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

export function computeAgentScope(
  toolIds: string[],
  catalog: AgentCatalog,
  permissionOverrides: CustomAgentPermissionOverride[] = [],
): AgentScope {
  const writeFamilies = new Set<string>()
  for (const tool of toolIds
    .map((id) => catalog.tools.find((entry) => entry.id === id))
    .filter((entry): entry is AgentCatalogTool => Boolean(entry))) {
    for (const family of writeFamiliesForTool(tool)) writeFamilies.add(family)
  }
  for (const override of permissionOverrides) {
    if (!WRITE_PERMISSION_FAMILIES.has(override.key)) continue
    if (overrideGrantsWriteAccess(override)) {
      writeFamilies.add(override.key)
    } else if (override.action === 'deny') {
      writeFamilies.delete(override.key)
    }
  }
  const writeCount = writeFamilies.size
  if (writeCount === 0) return 'read-only'
  if (writeCount <= 2) return 'standard'
  return 'powerful'
}

export function scopeLabel(scope: AgentScope): string {
  return scope === 'read-only' ? 'Read only' : scope === 'standard' ? 'Standard' : 'Powerful'
}

export function scopeTone(scope: AgentScope): string {
  return scope === 'read-only'
    ? 'var(--color-green)'
    : scope === 'standard'
      ? 'var(--color-info)'
      : 'var(--color-amber)'
}

// When a user attaches a skill that references tools not currently in the
// agent's selected capabilities, surface an actionable hint. Returns the tool ids the
// skill needs that the agent doesn't have.
export function resolveMissingSkillTools(
  skillName: string,
  selectedToolIds: string[],
  catalog: AgentCatalog,
): string[] {
  const skill = catalog.skills.find((entry) => entry.name === skillName)
  if (!skill || !skill.toolIds) return []
  const selected = new Set(selectedToolIds)
  return skill.toolIds.filter((toolId) => !selected.has(toolId))
}

// Renderer-local template shape — a partial CustomAgentConfig plus UI
// metadata. Templates never round-trip through IPC; they're just seeds.
export interface AgentTemplate {
  id: string
  label: string
  description: string
  color: AgentColor
  mode?: CustomAgentConfig['mode']
  instructions: string
  temperature?: number | null
  steps?: number | null
  // Desired tool / skill ids. May reference entries that aren't in the
  // live catalog — applyTemplate filters missing ones rather than
  // erroring.
  toolIds?: string[]
  skillNames?: string[]
}

export function applyTemplate(
  template: AgentTemplate,
  catalog: AgentCatalog,
): Partial<CustomAgentConfig> {
  const availableToolIds = new Set(catalog.tools.map((tool) => tool.id))
  const availableSkillNames = new Set(catalog.skills.map((skill) => skill.name))
  return {
    description: template.description,
    instructions: template.instructions,
    color: template.color,
    mode: template.mode || 'subagent',
    toolIds: (template.toolIds || []).filter((id) => availableToolIds.has(id)),
    skillNames: (template.skillNames || []).filter((name) => availableSkillNames.has(name)),
    temperature: template.temperature ?? null,
    steps: template.steps ?? null,
  }
}

type AgentDraftIssue = CustomAgentIssue

const PERMISSION_LABELS: Record<CustomAgentPermissionKey, string> = {
  web: 'Web access',
  edit: 'Edit files',
  bash: 'Run commands',
  task: 'Delegate work',
  external_directory: 'External directories',
  mcp: 'MCP tools',
}

function validatePermissionOverrideRules(draft: CustomAgentConfig): AgentDraftIssue[] {
  const issues: AgentDraftIssue[] = []
  for (const override of draft.permissionOverrides || []) {
    for (const [index, rule] of (override.rules || []).entries()) {
      const pattern = rule.pattern.trim()
      if (!pattern) {
        issues.push({
          code: `permission_rule_pattern_required_${override.key}_${index}`,
          message: `${PERMISSION_LABELS[override.key]} permission rule pattern is required.`,
        })
        continue
      }
      if (override.key === 'mcp' && !isMcpPermissionRulePattern(pattern)) {
        issues.push({
          code: `permission_rule_pattern_invalid_mcp_${index}`,
          message: 'MCP tools permission rule pattern must be an MCP tool pattern like mcp__server__tool.',
        })
      }
    }
  }
  return issues
}

export function validateAgentDraft(params: {
  draft: CustomAgentConfig
  reservedNames: string[]
  existingNames: string[]
  projectTargetDirectory: string | null
  availableToolIds: string[]
  availableSkillNames: string[]
}): AgentDraftIssue[] {
  return [
    ...validateCustomAgentDraft({
      name: params.draft.name,
      description: params.draft.description,
      scope: params.draft.scope,
      directory: params.draft.scope === 'project' ? params.projectTargetDirectory : null,
      reservedNames: params.reservedNames,
      siblingNames: params.existingNames,
      availableToolIds: params.availableToolIds,
      availableSkillNames: params.availableSkillNames,
      toolIds: params.draft.toolIds,
      skillNames: params.draft.skillNames,
      brandName: getBrandName(),
    }),
    ...validatePermissionOverrideRules(params.draft),
  ]
}

export function linkedSkillNamesForTool(
  catalog: AgentCatalog,
  toolId: string,
): string[] {
  return catalog.skills
    .filter((skill) => (skill.toolIds || []).includes(toolId))
    .map((skill) => skill.name)
}

// Built-in agents reference native OpenCode tools (websearch, webfetch,
// bash, read, write, …) that aren't in the Cowork product catalog because
// they aren't user-pickable for custom agents. When we render a built-in
// in the read-only builder, we want these tools to show as proper tiles
// instead of "missing" warnings. This helper returns an augmented catalog
// with synthetic native-tool entries added for anything in `nativeToolIds`
// that isn't already known.
//
// Pure — produces a new catalog; does not mutate the input.
export function augmentCatalogForBuiltIn(
  catalog: AgentCatalog,
  nativeToolIds: string[],
): AgentCatalog {
  const existing = new Set(catalog.tools.map((tool) => tool.id))
  const extras: AgentCatalogTool[] = []
  for (const id of nativeToolIds) {
    if (existing.has(id)) continue
    extras.push({
      id,
      name: humanizeNativeToolId(id),
      icon: nativeToolIcon(id),
      description: 'Native OpenCode tool — always available to this built-in agent.',
      supportsWrite: isNativeWriteTool(id),
      source: 'builtin',
      patterns: [id],
    })
  }
  if (extras.length === 0) return catalog
  return { ...catalog, tools: [...catalog.tools, ...extras] }
}

function humanizeNativeToolId(id: string): string {
  if (id === 'websearch') return 'Web Search'
  if (id === 'webfetch') return 'Web Fetch'
  if (id === 'todowrite') return 'Todo Write'
  if (id === 'apply_patch') return 'Apply Patch'
  return id
    .split(/[_-]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function nativeToolIcon(id: string): string {
  // Map common native tool ids to a best-guess PluginIcon key. Unknown
  // ids fall back to the generic tool glyph.
  if (id === 'websearch' || id === 'webfetch') return 'web'
  if (id === 'bash') return 'terminal'
  if (id === 'read' || id === 'write' || id === 'edit') return 'file'
  if (id === 'task') return 'task'
  if (id === 'todowrite') return 'todo'
  if (id === 'grep' || id === 'glob') return 'search'
  return 'tool'
}

function isNativeWriteTool(id: string): boolean {
  return id === 'write' || id === 'edit' || id === 'bash' || id === 'apply_patch' || id === 'todowrite'
}

// Compiled static preview shown below the builder — mirrors what the
// main process will eventually hand to OpenCode.
export interface CompiledAgentPreview {
  title: string
  mentionAs: string
  scope: AgentScope
  instructions: string
  selectedTools: AgentCatalogTool[]
  selectedSkills: AgentCatalogSkill[]
  missingTools: string[]
  missingSkills: string[]
}

export function compileAgentPreview(
  draft: CustomAgentConfig,
  catalog: AgentCatalog,
): CompiledAgentPreview {
  const toolMap = new Map(catalog.tools.map((tool) => [tool.id, tool]))
  const skillMap = new Map(catalog.skills.map((skill) => [skill.name, skill]))
  const selectedTools = draft.toolIds
    .map((id) => toolMap.get(id))
    .filter((tool): tool is AgentCatalogTool => Boolean(tool))
  const selectedSkills = draft.skillNames
    .map((name) => skillMap.get(name))
    .filter((skill): skill is AgentCatalogSkill => Boolean(skill))
  const missingTools = draft.toolIds.filter((id) => !toolMap.has(id))
  const missingSkills = draft.skillNames.filter((name) => !skillMap.has(name))
  const trimmedName = draft.name.trim() || 'new-agent'
  return {
    title: trimmedName,
    mentionAs: `@${trimmedName}`,
    scope: computeAgentScope(draft.toolIds, catalog, draft.permissionOverrides),
    instructions: draft.instructions.trim() || 'No instructions yet — add guidance to shape tone, priorities, and output.',
    selectedTools,
    selectedSkills,
    missingTools,
    missingSkills,
  }
}

// Derived meter attributes used by compact agent cards. The primary builder
// summary uses the deterministic shared capability profile.
export interface AgentAttributes {
  breadth: number  // 0..5 — skills coverage
  range: number    // 0..5 — tool count (reach)
  autonomy: number // 0..5 — how many tool iterations the agent may chain
}

function clamp05(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0
  if (value > 5) return 5
  return Math.round(value)
}

// Skills / tools map to the 0..5 segment meter via a fixed cap — the
// first few picks matter most; a specialist with one skill shouldn't
// look empty. Autonomy comes from the `steps` inference override; an
// unset steps value implies the session default, which we treat as the
// middle of the scale.
export function computeAgentAttributes(params: {
  skillCount: number
  toolCount: number
  steps: number | null | undefined
}): AgentAttributes {
  // Breadth — 0 skills = 0, 1 = 2, 2 = 3, 3 = 4, 4+ = 5. Rapidly
  // diminishing returns past three.
  const breadth = params.skillCount === 0
    ? 0
    : params.skillCount === 1
      ? 2
      : params.skillCount === 2
        ? 3
        : params.skillCount === 3
          ? 4
          : 5
  // Range — same curve on tool count.
  const range = params.toolCount === 0
    ? 0
    : params.toolCount === 1
      ? 2
      : params.toolCount === 2
        ? 3
        : params.toolCount === 3
          ? 4
          : 5
  // Autonomy — step cap buckets. No cap = inherits session default = 3.
  const autonomy = typeof params.steps !== 'number'
    ? 3
    : params.steps < 5
      ? 1
      : params.steps < 10
        ? 2
        : params.steps < 20
          ? 3
          : params.steps < 40
            ? 4
            : 5
  return {
    breadth: clamp05(breadth),
    range: clamp05(range),
    autonomy: clamp05(autonomy),
  }
}
