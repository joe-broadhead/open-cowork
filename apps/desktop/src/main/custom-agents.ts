import { getEnabledIntegrationBundles } from './plugin-manager'
import { loadSettings } from './settings'
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
} from './custom-agents-utils'

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
  return buildCustomAgentCatalog({
    enabledBundles: getEnabledIntegrationBundles(),
    customSkills: settings.customSkills || [],
    settings: settings as unknown as SettingsLike,
  })
}

export function getCustomAgentSummaries(settings = loadSettings()): CustomAgentSummary[] {
  return summarizeCustomAgents({
    settings: settings as unknown as SettingsLike,
    enabledBundles: getEnabledIntegrationBundles(),
  })
}

export function getRuntimeCustomAgents(settings = loadSettings()): RuntimeCustomAgent[] {
  return buildRuntimeCustomAgents({
    settings: settings as unknown as SettingsLike,
    enabledBundles: getEnabledIntegrationBundles(),
  })
}
