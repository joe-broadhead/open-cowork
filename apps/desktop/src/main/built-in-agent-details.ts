import type { BuiltInAgentDetail } from '@open-cowork/shared'

import {
  getConfiguredAgentsFromConfig,
  getConfiguredToolsFromConfig,
} from './config-loader.ts'
import { configuredToolLabels } from './capability-catalog.ts'
import { createConfiguredAgentPrompt } from './agent-prompts.ts'
import { getBuiltInAgentOverride } from './built-in-agent-overrides.ts'
import {
  configuredAgentConfiguredToolIds,
  configuredAgentNativeToolIds,
  configuredToolAccess,
  getNativeToolIdsForBuiltInAgent,
  nativeToolLabels,
} from './agent-tool-access.ts'

function getConfiguredBuiltInAgentDetails(): BuiltInAgentDetail[] {
  return getConfiguredAgentsFromConfig().map((agent) => ({
    name: agent.name,
    label: agent.label || agent.name,
    source: 'open-cowork' as const,
    mode: agent.mode || 'subagent',
    surface: 'chat' as const,
    hidden: agent.hidden === true,
    disabled: false,
    color: agent.color || 'accent',
    description: agent.description,
    instructions: createConfiguredAgentPrompt(agent, configuredToolAccess(agent)),
    skills: [...(agent.skillNames || [])],
    toolAccess: configuredToolAccess(agent),
    nativeToolIds: configuredAgentNativeToolIds(agent),
    configuredToolIds: configuredAgentConfiguredToolIds(agent),
    model: agent.model ?? null,
    variant: agent.variant ?? null,
    temperature: typeof agent.temperature === 'number' ? agent.temperature : null,
    top_p: typeof agent.top_p === 'number' ? agent.top_p : null,
    steps: typeof agent.steps === 'number' ? agent.steps : null,
  }))
}

function applyBuiltInDetailOverride(detail: BuiltInAgentDetail): BuiltInAgentDetail {
  const override = getBuiltInAgentOverride(detail.name)
  if (!override) return detail
  return {
    ...detail,
    hidden: override.hidden === true ? true : detail.hidden,
    disabled: override.disable === true,
    description: override.description ?? detail.description,
    color: override.color ?? detail.color,
    model: override.model ?? detail.model ?? null,
    variant: override.variant ?? detail.variant ?? null,
    temperature: typeof override.temperature === 'number' ? override.temperature : detail.temperature ?? null,
    top_p: typeof override.top_p === 'number' ? override.top_p : detail.top_p ?? null,
    steps: typeof override.steps === 'number' ? override.steps : detail.steps ?? null,
  }
}

export function listBuiltInAgentDetails(): BuiltInAgentDetail[] {
  const configuredToolIds = getConfiguredToolsFromConfig().map((tool) => tool.id)
  const buildNativeToolIds = getNativeToolIdsForBuiltInAgent('build')
  const planNativeToolIds = getNativeToolIdsForBuiltInAgent('plan')
  const generalNativeToolIds = getNativeToolIdsForBuiltInAgent('general')
  const exploreNativeToolIds = getNativeToolIdsForBuiltInAgent('explore')

  const coreDetails: BuiltInAgentDetail[] = [
    {
      name: 'build',
      label: 'Build',
      source: 'opencode',
      mode: 'primary',
      surface: 'chat',
      hidden: false,
      disabled: false,
      color: 'primary',
      description: 'Default full-access agent for building, editing, and shipping work.',
      instructions: '',
      skills: [],
      toolAccess: [...nativeToolLabels(buildNativeToolIds), ...configuredToolLabels(configuredToolIds)],
      nativeToolIds: buildNativeToolIds,
      configuredToolIds,
    },
    {
      name: 'plan',
      label: 'Plan',
      source: 'opencode',
      mode: 'primary',
      surface: 'chat',
      hidden: false,
      disabled: false,
      color: 'warning',
      description: 'Read-only planning and audit agent for decomposition, review, and recommendations.',
      instructions: '',
      skills: [],
      toolAccess: nativeToolLabels(planNativeToolIds),
      nativeToolIds: planNativeToolIds,
      configuredToolIds: [],
    },
    {
      name: 'general',
      label: 'General',
      source: 'opencode',
      mode: 'subagent',
      surface: 'chat',
      hidden: false,
      disabled: false,
      color: 'secondary',
      description: 'General-purpose delegated agent for focused subproblems.',
      instructions: '',
      skills: [],
      toolAccess: [...nativeToolLabels(generalNativeToolIds), ...configuredToolLabels(configuredToolIds)],
      nativeToolIds: generalNativeToolIds,
      configuredToolIds,
    },
    {
      name: 'explore',
      label: 'Explore',
      source: 'opencode',
      mode: 'subagent',
      surface: 'chat',
      hidden: false,
      disabled: false,
      color: 'accent',
      description: 'Read-only codebase and file-system investigation agent.',
      instructions: '',
      skills: [],
      toolAccess: nativeToolLabels(exploreNativeToolIds),
      nativeToolIds: exploreNativeToolIds,
      configuredToolIds: [],
    },
    {
      name: 'cowork-exec',
      label: 'Cowork Exec',
      source: 'open-cowork',
      mode: 'primary',
      surface: 'automation',
      hidden: true,
      disabled: false,
      color: 'info',
      description: 'Hidden automation supervisor for scheduled work and execution readiness.',
      instructions: 'Automation-only supervisor. Hidden from the normal chat picker.',
      skills: [],
      toolAccess: [...nativeToolLabels(buildNativeToolIds), ...configuredToolLabels(configuredToolIds)],
      nativeToolIds: buildNativeToolIds,
      configuredToolIds,
    },
  ]

  return [
    ...coreDetails.map(applyBuiltInDetailOverride),
    ...getConfiguredBuiltInAgentDetails(),
  ]
}
