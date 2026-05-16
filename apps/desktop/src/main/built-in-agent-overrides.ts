import { getAppConfig, type BuiltInAgentOverrideConfig } from './config-loader.ts'

export type BuiltInAgentName = 'build' | 'plan' | 'general' | 'explore' | 'executive-assistant' | 'autoresearch'
type OverridableBuiltInAgentName = Exclude<BuiltInAgentName, 'executive-assistant' | 'autoresearch'>

function isOverridableBuiltInAgentName(name: string): name is OverridableBuiltInAgentName {
  return name === 'build' || name === 'plan' || name === 'general' || name === 'explore'
}

export function getBuiltInAgentOverride(name: string): BuiltInAgentOverrideConfig | null {
  if (!isOverridableBuiltInAgentName(name)) return null
  const overrides = getAppConfig().builtInAgents
  if (!overrides || typeof overrides !== 'object') return null
  const entry = overrides[name]
  return entry && typeof entry === 'object' ? entry : null
}
