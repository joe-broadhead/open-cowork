import type {
  BuiltInAgentDetail,
  CustomAgentSummary,
  RuntimeAgentDescriptor,
} from '@open-cowork/shared'

export type AgentVisual = {
  avatar: string | null
  color: string | null
}

export function buildAgentVisualMap(input: {
  runtimeAgents?: RuntimeAgentDescriptor[]
  builtinAgents?: BuiltInAgentDetail[]
  customAgents?: CustomAgentSummary[]
}): Record<string, AgentVisual> {
  const map: Record<string, AgentVisual> = {}

  for (const agent of input.runtimeAgents || []) {
    if (!agent.name) continue
    map[agent.name] = {
      avatar: null,
      color: agent.color || null,
    }
  }

  for (const agent of input.builtinAgents || []) {
    if (!agent.name) continue
    map[agent.name] = {
      avatar: agent.avatar || null,
      color: agent.color || null,
    }
  }

  for (const agent of input.customAgents || []) {
    if (!agent.name) continue
    map[agent.name] = {
      avatar: agent.avatar || null,
      color: agent.color || null,
    }
  }

  return map
}
