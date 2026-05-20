import { getConfiguredSkillsFromConfig, getConfiguredToolsFromConfig } from './config-loader.ts'
import type { CustomAgentIssue, RuntimeContextOptions } from '@open-cowork/shared'
import { listCustomAgents, listCustomMcps, listCustomSkills } from './native-customizations.ts'
import { listEffectiveSkills } from './effective-skills.ts'
import { listRuntimeToolsForContext, toRuntimeToolMetadata } from './runtime-tools.ts'
import { getEffectiveSettings } from './settings.ts'
import {
  buildCustomAgentCatalog,
  buildRuntimeCustomAgents,
  normalizeCustomAgent,
  summarizeCustomAgents,
  validateCustomAgent,
  CUSTOM_AGENT_COLORS,
  RESERVED_AGENT_NAMES,
  type CustomAgentCatalog,
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

const CUSTOM_AGENT_CATALOG_CACHE_TTL_MS = 30_000
const CUSTOM_AGENT_CATALOG_CACHE_MAX_ENTRIES = 64

type AgentCatalogCacheEntry<T> = {
  expiresAt: number
  value?: T
  promise?: Promise<T>
}

let customAgentCatalogCacheGeneration = 0
const customAgentCatalogCache = new Map<string, AgentCatalogCacheEntry<CustomAgentCatalog>>()
const customAgentSummaryCache = new Map<string, AgentCatalogCacheEntry<CustomAgentSummary[]>>()

export function invalidateCustomAgentCatalogCache() {
  customAgentCatalogCacheGeneration += 1
  customAgentCatalogCache.clear()
  customAgentSummaryCache.clear()
}

function cacheKeyForContext(options?: RuntimeContextOptions) {
  const settings = getEffectiveSettings()
  return JSON.stringify({
    generation: customAgentCatalogCacheGeneration,
    directory: options?.directory || null,
    provider: settings.effectiveProviderId || '',
    model: settings.effectiveModel || '',
  })
}

async function getCachedAgentCatalog<T>(
  cache: Map<string, AgentCatalogCacheEntry<T>>,
  key: string,
  load: () => Promise<T>,
) {
  const now = Date.now()
  const cached = cache.get(key)
  if (cached?.value !== undefined && cached.expiresAt > now) return cached.value
  if (cached?.promise) return await cached.promise

  const remember = (entry: AgentCatalogCacheEntry<T>) => {
    cache.set(key, entry)
    while (cache.size > CUSTOM_AGENT_CATALOG_CACHE_MAX_ENTRIES) {
      const oldestKey = cache.keys().next().value
      if (typeof oldestKey !== 'string') break
      cache.delete(oldestKey)
    }
  }

  const promise = load()
  remember({ expiresAt: now + CUSTOM_AGENT_CATALOG_CACHE_TTL_MS, promise })
  try {
    const value = await promise
    remember({ expiresAt: Date.now() + CUSTOM_AGENT_CATALOG_CACHE_TTL_MS, value })
    return value
  } catch (error) {
    if (cache.get(key)?.promise === promise) cache.delete(key)
    throw error
  }
}

function getCustomAgentState(options?: RuntimeContextOptions): CustomAgentCatalogState {
  return {
    customMcps: listCustomMcps(options),
    customSkills: listCustomSkills(options),
    customAgents: listCustomAgents(options),
  }
}

export async function getCustomAgentCatalog(options?: RuntimeContextOptions): Promise<CustomAgentCatalog> {
  return getCachedAgentCatalog(customAgentCatalogCache, cacheKeyForContext(options), () =>
    buildCustomAgentCatalogForContext(options))
}

async function buildCustomAgentCatalogForContext(options?: RuntimeContextOptions): Promise<CustomAgentCatalog> {
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
  return getCachedAgentCatalog(customAgentSummaryCache, cacheKeyForContext(options), () =>
    buildCustomAgentSummariesForContext(options))
}

async function buildCustomAgentSummariesForContext(options?: RuntimeContextOptions): Promise<CustomAgentSummary[]> {
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
