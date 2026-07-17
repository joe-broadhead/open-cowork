import type { CustomAgentIssue } from './custom-content.js'

export const VALID_CUSTOM_AGENT_NAME = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/

const isPermissionAlnum = (code: number) =>
  (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)

function startsWithMcpPrefix(value: string) {
  return value.length >= 5 && value.slice(0, 5).toLowerCase() === 'mcp__'
}

function isModernMcpPermissionRulePattern(pattern: string) {
  if (!startsWithMcpPrefix(pattern)) return false
  const n = pattern.length
  let i = 5
  if (i >= n || !isPermissionAlnum(pattern.charCodeAt(i))) return false
  while (i < n) {
    while (i < n) {
      const code = pattern.charCodeAt(i)
      if (!isPermissionAlnum(code) && code !== 45 /* - */) break
      i += 1
    }
    if (i + 1 < n && pattern.charCodeAt(i) === 95 /* _ */ && pattern.charCodeAt(i + 1) === 95 /* _ */) {
      const toolStart = i + 2
      if (toolStart >= n) return false
      return pattern.indexOf('/', toolStart) === -1
    }
    if (i < n && pattern.charCodeAt(i) === 95 /* _ */) {
      i += 1
      if (i >= n) return false
      const code = pattern.charCodeAt(i)
      if (!isPermissionAlnum(code) && code !== 45 /* - */) return false
      continue
    }
    return false
  }
  return false
}

/** Native OpenCode tools that contain `_` but are not MCP tools. */
const NATIVE_UNDERSCORE_TOOL_IDS = new Set([
  'apply_patch',
  'todo_write',
  'todowrite',
])

/**
 * OpenCode 1.18+ MCP tool ids: `${server}_${tool}` (e.g. `time-keep_current_time`,
 * `charts_*`). Accept these alongside Claude-style `mcp__server__tool` patterns.
 */
function isOpenCodeMcpPermissionRulePattern(pattern: string) {
  // Claude-style mcp__… patterns are handled separately; do not re-parse them here.
  if (!pattern || startsWithMcpPrefix(pattern)) return false
  if (pattern.includes('/') || pattern.includes('\\')) return false
  if (NATIVE_UNDERSCORE_TOOL_IDS.has(pattern.toLowerCase())) return false
  // server_* namespace wildcard
  if (/^[a-z0-9][a-z0-9_-]*_\*$/i.test(pattern)) return true
  // server_tool (tool segment may include _ and * wildcards)
  return /^[a-z0-9][a-z0-9_-]*_[a-z0-9*][a-z0-9_*-]*$/i.test(pattern)
}

export function isMcpPermissionRulePattern(pattern: string) {
  return isModernMcpPermissionRulePattern(pattern) || isOpenCodeMcpPermissionRulePattern(pattern)
}

export type CustomAgentDraftValidationInput = {
  name: string
  description: string
  scope: 'machine' | 'project'
  directory?: string | null
  reservedNames?: string[]
  siblingNames?: string[]
  availableToolIds?: string[]
  availableSkillNames?: string[]
  toolIds?: string[]
  skillNames?: string[]
  brandName?: string
}

export function validateCustomAgentDraft(input: CustomAgentDraftValidationInput): CustomAgentIssue[] {
  const brandName = input.brandName || 'Open Cowork'
  const name = (input.name || '').trim().toLowerCase()
  const description = (input.description || '').trim()
  const reservedNames = new Set((input.reservedNames || []).map((entry) => entry.trim().toLowerCase()).filter(Boolean))
  const siblingNames = new Set((input.siblingNames || []).map((entry) => entry.trim().toLowerCase()).filter(Boolean))
  const availableToolIds = new Set(input.availableToolIds || [])
  const availableSkillNames = new Set(input.availableSkillNames || [])
  const issues: CustomAgentIssue[] = []

  if (!name) {
    issues.push({
      code: 'missing_name',
      message: 'Give the agent an id so it can be mentioned in chat.',
    })
  } else if (!VALID_CUSTOM_AGENT_NAME.test(name)) {
    issues.push({
      code: 'invalid_name',
      message: 'Use lowercase letters, numbers, and hyphens only for the agent id.',
    })
  }

  if (name && reservedNames.has(name)) {
    issues.push({
      code: 'reserved_name',
      message: `"${name}" is reserved by ${brandName} or OpenCode.`,
    })
  }

  if (name && siblingNames.has(name)) {
    issues.push({
      code: 'duplicate_name',
      message: `A custom agent named "${name}" already exists.`,
    })
  }

  if (!description) {
    issues.push({
      code: 'missing_description',
      message: `Add a short description so ${brandName} knows when to use this agent.`,
    })
  }

  if (input.scope === 'project' && !input.directory) {
    issues.push({
      code: 'missing_project_directory',
      message: 'Choose a project directory for this project-scoped agent.',
    })
  }

  for (const toolId of input.toolIds || []) {
    if (!availableToolIds.has(toolId)) {
      issues.push({
        code: 'missing_tool',
        message: `The tool "${toolId}" is no longer available.`,
      })
    }
  }

  for (const skillName of input.skillNames || []) {
    if (!availableSkillNames.has(skillName)) {
      issues.push({
        code: 'missing_skill',
        message: `The skill "${skillName}" is not currently available.`,
      })
    }
  }

  return issues
}
