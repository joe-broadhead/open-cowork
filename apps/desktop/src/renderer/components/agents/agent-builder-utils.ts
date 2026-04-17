import type {
  AgentCatalog,
  AgentCatalogSkill,
  AgentCatalogTool,
  AgentColor,
  CustomAgentConfig,
  CustomAgentSummary,
} from '@open-cowork/shared'

// Pure helpers for the agent builder. Kept separate from the React
// components so they're unit-testable, importable from both the list
// grid + the builder page, and easy to reason about.

export const VALID_AGENT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

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

// Three effective scopes derived from the tool loadout:
//   read-only  — nothing the agent can do writes anywhere
//   standard   — one or two write-capable tools (normal working set)
//   powerful   — three or more write-capable tools (broad blast radius)
// The goal is to teach users that "more tools = bigger footprint" without
// showing a permissions dialog.
export type AgentScope = 'read-only' | 'standard' | 'powerful'

export function computeAgentScope(toolIds: string[], catalog: AgentCatalog): AgentScope {
  const writeCount = toolIds
    .map((id) => catalog.tools.find((tool) => tool.id === id))
    .filter((tool): tool is AgentCatalogTool => Boolean(tool))
    .filter((tool) => tool.supportsWrite)
    .length
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
// agent's loadout, surface an actionable hint. Returns the tool ids the
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
    toolIds: (template.toolIds || []).filter((id) => availableToolIds.has(id)),
    skillNames: (template.skillNames || []).filter((name) => availableSkillNames.has(name)),
    temperature: template.temperature ?? null,
    steps: template.steps ?? null,
  }
}

// Local-validation shape for the builder. Mirrors the draft-level checks
// the old form had, but scoped here so the builder only owns layout.
export interface AgentDraftIssue {
  code:
    | 'name-missing'
    | 'name-invalid'
    | 'name-reserved'
    | 'name-conflict'
    | 'description-missing'
    | 'project-directory-missing'
    | 'missing-refs'
  message: string
}

export function validateAgentDraft(params: {
  draft: CustomAgentConfig
  isExisting: boolean
  reservedNames: string[]
  existingNames: string[]
  projectTargetDirectory: string | null
  missingToolCount: number
  missingSkillCount: number
}): AgentDraftIssue[] {
  const issues: AgentDraftIssue[] = []
  const normalized = params.draft.name.trim().toLowerCase()
  if (!normalized) {
    issues.push({ code: 'name-missing', message: 'Give the agent an id so it can be mentioned in chat.' })
  } else if (!VALID_AGENT_NAME.test(normalized)) {
    issues.push({ code: 'name-invalid', message: 'Use lowercase letters, numbers, and hyphens only for the agent id.' })
  }
  if (normalized && params.reservedNames.includes(normalized)) {
    issues.push({ code: 'name-reserved', message: `"${normalized}" is reserved by Open Cowork or OpenCode.` })
  }
  if (!params.isExisting && normalized && params.existingNames.includes(normalized)) {
    issues.push({ code: 'name-conflict', message: `A custom agent named "${normalized}" already exists.` })
  }
  if (!params.draft.description.trim()) {
    issues.push({ code: 'description-missing', message: 'Add a short description so Open Cowork knows when to use this agent.' })
  }
  if (params.draft.scope === 'project' && !params.projectTargetDirectory) {
    issues.push({ code: 'project-directory-missing', message: 'Choose a project directory for this project-scoped agent.' })
  }
  if (params.missingToolCount > 0 || params.missingSkillCount > 0) {
    issues.push({ code: 'missing-refs', message: 'Remove unavailable tools or skills before saving this agent.' })
  }
  return issues
}

export function linkedSkillNamesForTool(
  catalog: AgentCatalog,
  toolId: string,
): string[] {
  return catalog.skills
    .filter((skill) => (skill.toolIds || []).includes(toolId))
    .map((skill) => skill.name)
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
    scope: computeAgentScope(draft.toolIds, catalog),
    instructions: draft.instructions.trim() || 'No instructions yet — add guidance to shape tone, priorities, and output.',
    selectedTools,
    selectedSkills,
    missingTools,
    missingSkills,
  }
}

// Used by the list grid to collapse a built-in / custom / runtime agent
// into the stats the card needs.
export interface AgentCardStats {
  model: string
  temperature: string
  stepCap: string
  skillsCount: number
  toolsCount: number
  scope: AgentScope
}

export function describeBuiltInStats(
  agent: { model?: string | null; temperature?: number | null; steps?: number | null; skills: string[]; toolAccess: string[] },
): AgentCardStats {
  return {
    model: agent.model ? agent.model.split('/').pop()! : 'Session default',
    temperature: typeof agent.temperature === 'number' ? agent.temperature.toFixed(1) : '—',
    stepCap: typeof agent.steps === 'number' ? String(agent.steps) : '—',
    skillsCount: agent.skills.length,
    toolsCount: agent.toolAccess.length,
    scope: 'read-only',
  }
}

export function describeCustomStats(
  agent: CustomAgentSummary,
  catalog: AgentCatalog,
): AgentCardStats {
  return {
    model: agent.model ? agent.model.split('/').pop()! : 'Session default',
    temperature: typeof agent.temperature === 'number' ? agent.temperature.toFixed(1) : '—',
    stepCap: typeof agent.steps === 'number' ? String(agent.steps) : '—',
    skillsCount: agent.skillNames.length,
    toolsCount: agent.toolIds.length,
    scope: computeAgentScope(agent.toolIds, catalog),
  }
}
