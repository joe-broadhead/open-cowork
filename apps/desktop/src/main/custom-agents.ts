import { getConfiguredSkillsFromConfig, getConfiguredToolsFromConfig } from './config-loader.ts'
import type { RuntimeContextOptions } from '@open-cowork/shared'
import { listCustomAgents, listCustomMcps, listCustomSkills } from './native-customizations.ts'
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

export function getCustomAgentCatalog(options?: RuntimeContextOptions): CustomAgentCatalog {
  const state = getCustomAgentState(options)
  return buildCustomAgentCatalog({
    builtinTools: getConfiguredToolsFromConfig(),
    builtinSkills: getConfiguredSkillsFromConfig(),
    customMcps: state.customMcps || [],
    customSkills: state.customSkills || [],
    state,
  })
}

export function getCustomAgentSummaries(options?: RuntimeContextOptions): CustomAgentSummary[] {
  const state = getCustomAgentState(options)
  return summarizeCustomAgents({
    state,
    builtinTools: getConfiguredToolsFromConfig(),
    builtinSkills: getConfiguredSkillsFromConfig(),
  })
}
