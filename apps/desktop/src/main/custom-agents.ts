import { getConfiguredSkillsFromConfig, getConfiguredToolsFromConfig } from './config-loader.ts'
import { loadSettings } from './settings.ts'
import { listCustomSkills } from './custom-skills.ts'
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
  type SettingsLike,
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

export function getCustomAgentCatalog(settings = loadSettings()): CustomAgentCatalog {
  const customSkills = listCustomSkills()
  return buildCustomAgentCatalog({
    builtinTools: getConfiguredToolsFromConfig(),
    builtinSkills: getConfiguredSkillsFromConfig(),
    customMcps: settings.customMcps || [],
    customSkills,
    settings: { ...settings, customSkills } as unknown as SettingsLike,
  })
}

export function getCustomAgentSummaries(settings = loadSettings()): CustomAgentSummary[] {
  const customSkills = listCustomSkills()
  return summarizeCustomAgents({
    settings: { ...settings, customSkills } as unknown as SettingsLike,
    builtinTools: getConfiguredToolsFromConfig(),
    builtinSkills: getConfiguredSkillsFromConfig(),
  })
}

export function getRuntimeCustomAgents(settings = loadSettings()): RuntimeCustomAgent[] {
  const customSkills = listCustomSkills()
  return buildRuntimeCustomAgents({
    settings: { ...settings, customSkills } as unknown as SettingsLike,
    builtinTools: getConfiguredToolsFromConfig(),
    builtinSkills: getConfiguredSkillsFromConfig(),
  })
}
