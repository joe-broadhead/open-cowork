import type {
  AgentCatalog,
  CapabilitySkill,
  CapabilityTool,
} from '@open-cowork/shared'
import type { RuntimeCustomAgent } from '../../apps/desktop/src/main/custom-agents-utils.ts'

export const DOWNSTREAM_SKILL_COUNT = 60
export const DOWNSTREAM_TOOL_COUNT = 18
export const DOWNSTREAM_AGENT_COUNT = 12

function padded(index: number) {
  return String(index + 1).padStart(2, '0')
}

export function createDownstreamCatalogFixture() {
  const tools: CapabilityTool[] = Array.from({ length: DOWNSTREAM_TOOL_COUNT }, (_, index) => {
    const id = `tool-${padded(index)}`
    return {
      id,
      name: `Tool ${padded(index)}`,
      description: `Downstream MCP tool ${padded(index)} for catalog stress profiling.`,
      kind: 'mcp',
      source: index % 4 === 0 ? 'custom' : 'builtin',
      origin: index % 4 === 0 ? 'custom' : 'open-cowork',
      namespace: id,
      patterns: [`mcp__${id}__*`, `${id}_*`],
      availableTools: [
        { id: `mcp__${id}__read`, description: `Read via ${id}.` },
        { id: `mcp__${id}__write`, description: `Write via ${id}.` },
      ],
      agentNames: index % 3 === 0 ? [`agent-${padded(index % DOWNSTREAM_AGENT_COUNT)}`] : [],
    }
  })

  const skills: CapabilitySkill[] = Array.from({ length: DOWNSTREAM_SKILL_COUNT }, (_, index) => {
    const primaryTool = tools[index % tools.length]!
    const secondaryTool = tools[(index + 5) % tools.length]!
    return {
      name: `skill-${padded(index)}`,
      label: `Skill ${padded(index)}`,
      description: `Downstream skill ${padded(index)} linked to ${primaryTool.name} and ${secondaryTool.name}.`,
      source: index % 5 === 0 ? 'custom' : 'builtin',
      origin: index % 5 === 0 ? 'custom' : 'open-cowork',
      scope: index % 5 === 0 ? 'machine' : null,
      toolIds: [primaryTool.id, secondaryTool.id],
      agentNames: [`agent-${padded(index % DOWNSTREAM_AGENT_COUNT)}`],
    }
  })

  const agentCatalog: AgentCatalog = {
    tools: tools.map((tool, index) => ({
      id: tool.id,
      name: tool.name,
      icon: index % 2 === 0 ? 'tool' : 'database',
      description: tool.description,
      supportsWrite: index % 3 === 0,
      source: tool.source,
      patterns: tool.patterns,
    })),
    skills: skills.map((skill) => ({
      name: skill.name,
      label: skill.label,
      description: skill.description,
      source: skill.source,
      origin: skill.origin,
      scope: skill.scope,
      toolIds: skill.toolIds,
    })),
    reservedNames: ['build', 'plan', 'general', 'explore', 'cowork-exec'],
    colors: ['accent', 'primary', 'secondary', 'success', 'warning', 'info'],
  }

  const customAgents: RuntimeCustomAgent[] = Array.from({ length: DOWNSTREAM_AGENT_COUNT }, (_, index) => {
    const tool = tools[index % tools.length]!
    const skill = skills[index % skills.length]!
    return {
      name: `agent-${padded(index)}`,
      description: `Downstream specialist ${padded(index)}.`,
      instructions: `Use ${skill.label} and ${tool.name} for focused work.`,
      skillNames: [skill.name],
      toolNames: [tool.name],
      writeAccess: index % 3 === 0,
      color: index % 2 === 0 ? 'accent' : 'info',
      allowPatterns: [`mcp__${tool.id}__read`],
      askPatterns: index % 3 === 0 ? [`mcp__${tool.id}__write`] : [],
      deniedPatterns: [],
      disabled: false,
    }
  })

  const allToolPatterns = tools.flatMap((tool) => tool.patterns)
  const allowPatterns = tools.flatMap((tool, index) => (index % 2 === 0 ? tool.patterns : []))
  const askPatterns = tools.flatMap((tool, index) => (index % 2 === 1 ? tool.patterns : []))

  return {
    tools,
    skills,
    agentCatalog,
    customAgents,
    skillNames: skills.map((skill) => skill.name),
    allToolPatterns,
    allowPatterns,
    askPatterns,
  }
}
