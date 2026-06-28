import type {
  CapabilitySkill,
  CapabilityTool,
  CustomAgentConfig,
} from '@open-cowork/shared'

function suggestAgentId(value: string) {
  return `${value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'new'}-agent`
}

export function buildAgentSeedFromTool(tool: CapabilityTool): Partial<CustomAgentConfig> {
  return {
    name: suggestAgentId(tool.id),
    description: tool.description,
    toolIds: [tool.id],
    instructions: '',
    skillNames: [],
    enabled: true,
    color: 'accent',
  }
}

export function buildAgentSeedFromSkill(skill: CapabilitySkill): Partial<CustomAgentConfig> {
  return {
    name: suggestAgentId(skill.name),
    description: skill.description,
    toolIds: [...(skill.toolIds || [])],
    instructions: '',
    skillNames: [skill.name],
    enabled: true,
    color: 'accent',
  }
}
