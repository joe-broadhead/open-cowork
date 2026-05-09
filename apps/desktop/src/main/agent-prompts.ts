import type { AgentConfig } from '@opencode-ai/sdk/v2'
import type { ConfiguredAgent } from './config-loader.ts'
import type { RuntimeCustomAgent } from './custom-agents-utils.ts'
import { getBrandName } from './config-loader.ts'

// Fields a caller (built-in template, configured agent, or custom agent) can
// forward to the SDK AgentConfig beyond prompt/permission/mode/color. All
// optional; unset fields fall back to session defaults.
export type InferenceOverrides = {
  model?: string | null
  variant?: string | null
  temperature?: number | null
  top_p?: number | null
  steps?: number | null
  options?: Record<string, unknown> | null
}

export type DelegationPromptAgent = {
  name: string
  description: string
  source: 'custom' | 'configured' | 'builtin'
}

export function applyInferenceOverrides<T extends AgentConfig>(agent: T, overrides: InferenceOverrides | null | undefined): T {
  if (!overrides) return agent
  const next: AgentConfig = { ...agent }
  if (overrides.model) next.model = overrides.model
  if (overrides.variant) next.variant = overrides.variant
  if (typeof overrides.temperature === 'number') next.temperature = overrides.temperature
  if (typeof overrides.top_p === 'number') next.top_p = overrides.top_p
  if (typeof overrides.steps === 'number') next.steps = overrides.steps
  if (overrides.options && typeof overrides.options === 'object') {
    next.options = {
      ...(typeof next.options === 'object' && next.options ? next.options : {}),
      ...overrides.options,
    }
  }
  return next as T
}

export function createAttachedSkillDirective(skillNames: string[]) {
  if (skillNames.length === 0) {
    return 'No predefined skills are attached to this agent.'
  }
  const skillToolCalls = skillNames
    .map((name) => `- Call \`skill\` with \`{"name":"${name}"}\`.`)
    .join('\n')

  return [
    `Attached skills: ${skillNames.join(', ')}`,
    'Mandatory first action: before any explanation, health check, search, SQL, chart, MCP call, or final answer, load every attached skill through the native OpenCode `skill` tool.',
    skillToolCalls,
    'After the skill tool calls complete, follow the loaded instructions as the source of truth for this agent workflow.',
    'Do not claim a skill is unavailable unless the `skill` tool call fails; if loading fails, say which skill failed and continue with the selected tools.',
  ].join('\n')
}

export function createCustomAgentPrompt(agent: RuntimeCustomAgent) {
  const skillLine = agent.skillNames.length > 0
    ? createAttachedSkillDirective(agent.skillNames)
    : 'No predefined skills are available. Work from your instructions and allowed tools only.'
  const toolLine = agent.toolNames.length > 0
    ? `Allowed tools: ${agent.toolNames.join(', ')}`
    : 'No specific tools are attached to this agent.'

  return [
    `You are ${agent.description}.`,
    `You are a user-defined ${getBrandName()} agent running inside the OpenCode agent system.`,
    skillLine,
    toolLine,
    agent.writeAccess
      ? 'Some selected tools can create or update external resources. Those write actions require explicit user approval when invoked.'
      : 'Your selected tools are read-only. Do not attempt writes or side effects.',
    'Do not create nested subtasks.',
    'Return concise structured outputs that the parent agent can merge into the main thread.',
    '',
    'Custom instructions:',
    agent.instructions || 'Follow the mission and selected skills faithfully.',
  ].join('\n')
}

export function createConfiguredAgentPrompt(agent: ConfiguredAgent, attachedTools: string[]) {
  const skillLine = agent.skillNames?.length
    ? createAttachedSkillDirective(agent.skillNames)
    : 'No predefined skills are attached to this agent.'
  const toolLine = attachedTools.length > 0
    ? `Attached tools: ${attachedTools.join(', ')}`
    : 'No dedicated tools are attached to this agent.'

  return [
    `You are ${agent.label || agent.name}.`,
    agent.description,
    toolLine,
    skillLine,
    `You are a built-in ${getBrandName()} agent running inside the OpenCode agent system.`,
    'Do not create nested subtasks unless the parent explicitly delegates work to you.',
    'Return concise structured outputs that the parent agent can merge into the main thread.',
    '',
    'Instructions:',
    agent.instructions || 'Follow the mission and selected skills faithfully.',
  ].join('\n')
}

export function createPrimaryAgentPrompt(options: {
  role: 'build' | 'plan'
  delegatedAgents: DelegationPromptAgent[]
}) {
  const roleLabel = options.role === 'build' ? 'delivery' : 'planning'
  const catalog = options.delegatedAgents.length > 0
    ? options.delegatedAgents
      .map((agent) => `- ${agent.name} (${agent.source}): ${agent.description}`)
      .join('\n')
    : '- No specialist subagents are currently available.'

  return [
    `You are the primary ${getBrandName()} ${roleLabel} agent running inside the OpenCode agent system.`,
    'You own the parent thread: understand the user goal, coordinate work, keep todos accurate, and merge delegated outputs into one response.',
    'Use delegation selectively when the request clearly benefits from specialist context, parallel work, or an explicit user @mention.',
    'For small, direct, or clarification-only requests, stay in the parent thread instead of delegating just because a specialist exists.',
    'If the user explicitly @mentions a subagent, delegate the main substantive branch to that subagent unless it is unavailable or the request is impossible for it.',
    'If a custom or configured specialist subagent clearly matches the domain, prefer delegating the specialist branch once the goal and scope are clear.',
    'Prefer custom user-defined specialist agents over generic agents when their description is a closer fit for the task.',
    'Keep the parent thread focused on orchestration, approvals, and synthesis when delegation is active; otherwise answer directly.',
    '',
    'Available delegated agents:',
    catalog,
  ].join('\n')
}

export function mergeBuiltInPrompt(defaultPrompt: string | undefined, overrideInstructions: string | undefined) {
  const prompt = (defaultPrompt || '').trim()
  const override = (overrideInstructions || '').trim()
  if (!prompt) return override || undefined
  if (!override) return prompt
  return [
    prompt,
    '',
    'Additional built-in instructions:',
    override,
  ].join('\n')
}
