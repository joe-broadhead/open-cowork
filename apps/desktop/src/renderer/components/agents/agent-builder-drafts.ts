import type {
  AgentColor,
  BuiltInAgentDetail,
  CustomAgentConfig,
  CustomAgentSummary,
  RuntimeAgentDescriptor,
} from '@open-cowork/shared'
import { getBrandName } from '../../helpers/brand.ts'

export type BuilderTarget =
  | { kind: 'new'; seed?: Partial<CustomAgentConfig> | null }
  | { kind: 'custom'; agent: CustomAgentSummary }
  | { kind: 'builtin'; agent: BuiltInAgentDetail }
  | { kind: 'runtime'; agent: RuntimeAgentDescriptor }

export function blankAgentDraft(seed?: Partial<CustomAgentConfig> | null): CustomAgentConfig {
  return {
    scope: seed?.scope || 'machine',
    directory: seed?.scope === 'project' ? seed.directory || null : null,
    name: seed?.name || '',
    description: seed?.description || '',
    instructions: seed?.instructions || '',
    skillNames: Array.from(new Set(seed?.skillNames || [])),
    toolIds: Array.from(new Set(seed?.toolIds || [])),
    enabled: seed?.enabled ?? true,
    color: seed?.color || 'accent',
    avatar: seed?.avatar ?? null,
    model: seed?.model ?? null,
    variant: seed?.variant ?? null,
    temperature: seed?.temperature ?? null,
    top_p: seed?.top_p ?? null,
    steps: seed?.steps ?? null,
    options: seed?.options ?? null,
    deniedToolPatterns: Array.from(new Set(seed?.deniedToolPatterns || [])),
  }
}

export function draftFromCustomAgent(agent: CustomAgentSummary): CustomAgentConfig {
  return {
    scope: agent.scope,
    directory: agent.directory ?? null,
    name: agent.name,
    description: agent.description,
    instructions: agent.instructions,
    skillNames: [...agent.skillNames],
    toolIds: [...agent.toolIds],
    enabled: agent.enabled,
    color: agent.color,
    avatar: agent.avatar ?? null,
    model: agent.model ?? null,
    variant: agent.variant ?? null,
    temperature: agent.temperature ?? null,
    top_p: agent.top_p ?? null,
    steps: agent.steps ?? null,
    options: agent.options ?? null,
    deniedToolPatterns: [...(agent.deniedToolPatterns || [])],
  }
}

export function draftFromBuiltInAgent(agent: BuiltInAgentDetail): CustomAgentConfig {
  // Built-ins expose tools across overlapping arrays. Merge the native
  // OpenCode tool ids and Cowork-configured MCP ids so the loadout mirrors
  // the effective agent surface shown elsewhere in the catalog.
  const instructions = agent.instructions.trim()
    ? agent.instructions
    : agent.source === 'opencode'
      ? `This agent uses OpenCode's native built-in prompt and behavior. ${getBrandName()} only shapes its tool access, visibility, and UI metadata — the instructions aren't editable here.`
      : agent.instructions

  return {
    scope: 'machine',
    directory: null,
    name: agent.name,
    description: agent.description,
    instructions,
    skillNames: [...agent.skills],
    toolIds: Array.from(new Set([...agent.nativeToolIds, ...agent.configuredToolIds])),
    enabled: !agent.disabled,
    color: (agent.color as AgentColor) || 'accent',
    model: agent.model ?? null,
    variant: agent.variant ?? null,
    temperature: agent.temperature ?? null,
    top_p: agent.top_p ?? null,
    steps: agent.steps ?? null,
    options: agent.options ?? null,
  }
}

export function draftFromRuntimeAgent(agent: RuntimeAgentDescriptor): CustomAgentConfig {
  return {
    scope: 'machine',
    directory: null,
    name: agent.name,
    description: agent.description || '',
    instructions: '',
    skillNames: [],
    toolIds: [...(agent.toolIds || [])],
    enabled: !agent.disabled,
    color: (agent.color as AgentColor) || 'accent',
    model: agent.model ?? null,
    variant: null,
    temperature: null,
    top_p: null,
    steps: agent.steps ?? null,
    options: null,
  }
}

export function buildInitialAgentDraft(target: BuilderTarget): CustomAgentConfig {
  if (target.kind === 'new') return blankAgentDraft(target.seed)
  if (target.kind === 'custom') return draftFromCustomAgent(target.agent)
  if (target.kind === 'builtin') return draftFromBuiltInAgent(target.agent)
  return draftFromRuntimeAgent(target.agent)
}
