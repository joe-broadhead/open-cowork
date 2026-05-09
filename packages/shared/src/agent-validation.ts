import type { CustomAgentIssue } from './custom-content.js'

export const VALID_CUSTOM_AGENT_NAME = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/

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
