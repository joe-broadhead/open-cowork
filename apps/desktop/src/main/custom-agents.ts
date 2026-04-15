import { getConfiguredSkillsFromConfig, getConfiguredToolsFromConfig } from './config-loader.ts'
import type { RuntimeContextOptions } from '@open-cowork/shared'
import { listCustomAgents, listCustomMcps, listCustomSkills } from './native-customizations.ts'
import { listEffectiveSkills } from './effective-skills.ts'
import { listRuntimeToolsForContext, toRuntimeToolMetadata } from './runtime-tools.ts'
import {
  buildCustomAgentCatalog,
  buildRuntimeCustomAgents,
  normalizeCustomAgent,
  summarizeCustomAgents,
  validateCustomAgent,
  CUSTOM_AGENT_COLORS,
  RESERVED_AGENT_NAMES,
  type CustomAgentCatalog,
  type CustomAgentIssue,
  type CustomAgentSummary,
  type RuntimeCustomAgent,
  type CustomAgentCatalogState,
} from './custom-agents-utils.ts'

export {
  buildCustomAgentCatalog,
  buildRuntimeCustomAgents,
  normalizeCustomAgent,
  summarizeCustomAgents,
  validateCustomAgent,
  CUSTOM_AGENT_COLORS,
  RESERVED_AGENT_NAMES,
}

export type {
  CustomAgentCatalog,
  CustomAgentIssue,
  CustomAgentSummary,
  RuntimeCustomAgent,
}

function getCustomAgentState(options?: RuntimeContextOptions): CustomAgentCatalogState {
  return {
    customMcps: listCustomMcps(options),
    customSkills: listCustomSkills(options),
    customAgents: listCustomAgents(options),
  }
}

export async function getCustomAgentCatalog(options?: RuntimeContextOptions): Promise<CustomAgentCatalog> {
  const state = getCustomAgentState(options)
  const runtimeTools = (await listRuntimeToolsForContext(options))
    .map(toRuntimeToolMetadata)
    .filter((tool): tool is NonNullable<typeof tool> => Boolean(tool))
  const availableSkills = (await listEffectiveSkills(options)).map((skill) => ({
    name: skill.name,
    label: skill.label,
    description: skill.description,
    source: skill.source,
    origin: skill.origin,
    scope: skill.scope,
    location: skill.location,
    toolIds: skill.toolIds,
  }))
  return buildCustomAgentCatalog({
    builtinTools: getConfiguredToolsFromConfig(),
    builtinSkills: getConfiguredSkillsFromConfig(),
    runtimeTools,
    availableSkills,
    customMcps: state.customMcps || [],
    customSkills: state.customSkills || [],
    state,
  })
}

export async function getCustomAgentSummaries(options?: RuntimeContextOptions): Promise<CustomAgentSummary[]> {
  const state = getCustomAgentState(options)
  const runtimeTools = (await listRuntimeToolsForContext(options))
    .map(toRuntimeToolMetadata)
    .filter((tool): tool is NonNullable<typeof tool> => Boolean(tool))
  const availableSkills = (await listEffectiveSkills(options)).map((skill) => ({
    name: skill.name,
    label: skill.label,
    description: skill.description,
    source: skill.source,
    origin: skill.origin,
    scope: skill.scope,
    location: skill.location,
    toolIds: skill.toolIds,
  }))
  return summarizeCustomAgents({
    state,
    builtinTools: getConfiguredToolsFromConfig(),
    builtinSkills: getConfiguredSkillsFromConfig(),
    runtimeTools,
    availableSkills,
  })
}
