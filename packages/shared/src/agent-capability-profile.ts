import type { CustomAgentConfig } from './custom-content.js'
import type { ProviderModelDescriptor } from './providers.js'

export const AGENT_CAPABILITY_AXIS_IDS = [
  'reach',
  'skills',
  'context',
  'autonomy',
  'precision',
] as const

export type AgentCapabilityAxisId = typeof AGENT_CAPABILITY_AXIS_IDS[number]

export interface AgentCapabilityAxis {
  id: AgentCapabilityAxisId
  label: string
  value: number
  weight: number
  raw: string
  description: string
}

export interface AgentCapabilityProfile {
  axes: AgentCapabilityAxis[]
  score: number
  label: 'Minimal' | 'Focused' | 'Broad' | 'Comprehensive'
}

export type AgentCapabilityProfileInput = Pick<
  CustomAgentConfig,
  'toolIds' | 'skillNames' | 'steps' | 'temperature'
>

export const AGENT_CAPABILITY_WEIGHTS: Record<AgentCapabilityAxisId, number> = {
  reach: 0.24,
  skills: 0.24,
  context: 0.20,
  autonomy: 0.16,
  precision: 0.16,
}

const AXIS_META: Record<AgentCapabilityAxisId, Pick<AgentCapabilityAxis, 'label' | 'description'>> = {
  reach: {
    label: 'Reach',
    description: 'External surfaces this agent can touch.',
  },
  skills: {
    label: 'Skills',
    description: 'Specialized methods available to this agent.',
  },
  context: {
    label: 'Context',
    description: 'Selected model context window from provider metadata.',
  },
  autonomy: {
    label: 'Autonomy',
    description: 'Independent runway before returning.',
  },
  precision: {
    label: 'Precision',
    description: 'Output determinism from temperature.',
  },
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function scoreModelContextWindow(contextWindow: number | null | undefined): number {
  if (!contextWindow || !Number.isFinite(contextWindow)) return 3
  if (contextWindow <= 16_000) return 1
  if (contextWindow <= 64_000) return 2
  if (contextWindow <= 200_000) return 3
  if (contextWindow <= 500_000) return 4
  return 5
}

export function formatAgentCapabilityContext(contextWindow: number | null | undefined): string {
  if (!contextWindow || !Number.isFinite(contextWindow)) return 'unknown context'
  if (contextWindow >= 1_000_000) return `${Number((contextWindow / 1_000_000).toFixed(1))}M ctx`
  if (contextWindow >= 1_000) return `${Math.round(contextWindow / 1_000)}K ctx`
  return `${contextWindow} ctx`
}

function capabilityLabel(score: number): AgentCapabilityProfile['label'] {
  if (score >= 75) return 'Comprehensive'
  if (score >= 50) return 'Broad'
  if (score >= 25) return 'Focused'
  return 'Minimal'
}

export function computeAgentCapabilityProfile(
  config: AgentCapabilityProfileInput,
  model?: Pick<ProviderModelDescriptor, 'limit' | 'contextLength'> | null,
): AgentCapabilityProfile {
  const toolCount = config.toolIds.length
  const skillCount = config.skillNames.length
  const steps = clamp(typeof config.steps === 'number' && Number.isFinite(config.steps) ? config.steps : 20, 5, 60)
  const temperature = clamp(
    typeof config.temperature === 'number' && Number.isFinite(config.temperature) ? config.temperature : 0.5,
    0,
    1,
  )
  const contextWindow = model?.limit?.context ?? model?.contextLength ?? null

  const values: Record<AgentCapabilityAxisId, { value: number; raw: string }> = {
    reach: {
      value: Math.min(5, toolCount),
      raw: `${toolCount} tool${toolCount === 1 ? '' : 's'}`,
    },
    skills: {
      value: Math.min(5, skillCount),
      raw: `${skillCount} skill${skillCount === 1 ? '' : 's'}`,
    },
    context: {
      value: scoreModelContextWindow(contextWindow),
      raw: formatAgentCapabilityContext(contextWindow),
    },
    autonomy: {
      value: clamp(((steps - 5) / 55) * 5, 0, 5),
      raw: `${steps} steps`,
    },
    precision: {
      value: clamp((1 - temperature) * 5, 0, 5),
      raw: `temp ${temperature.toFixed(2)}`,
    },
  }

  const axes = AGENT_CAPABILITY_AXIS_IDS.map((id) => ({
    id,
    label: AXIS_META[id].label,
    description: AXIS_META[id].description,
    value: Number(values[id].value.toFixed(4)),
    raw: values[id].raw,
    weight: AGENT_CAPABILITY_WEIGHTS[id],
  }))
  const weighted = axes.reduce((sum, axis) => sum + (axis.value / 5) * axis.weight, 0)
  const score = Math.round(weighted * 100)

  return {
    axes,
    score,
    label: capabilityLabel(score),
  }
}
