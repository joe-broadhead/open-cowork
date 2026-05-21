import type { RuntimeContextOptions } from '@open-cowork/shared'
import {
  getConfiguredAgentsFromConfig,
  getConfiguredSkillsFromConfig,
  getConfiguredToolsFromConfig,
} from './config-loader.ts'
import { summarizeCustomAgents, type CustomAgentCatalogSkill, type CustomAgentSummary } from './custom-agents-utils.ts'
import { listEffectiveSkills } from './effective-skills.ts'
import { measureAsyncPerf } from './perf-metrics.ts'
import { getRuntimeHomeDir, resolveProjectDirectory } from './runtime-paths.ts'
import { currentRuntimeToolCacheGeneration } from './runtime-tool-cache.ts'
import { listRuntimeToolsForContext, toRuntimeToolMetadata, type RuntimeToolMetadata } from './runtime-tools.ts'
import { getEffectiveSettings } from './settings.ts'
import { listCustomAgents, listCustomMcps, listCustomSkills } from './native-customizations.ts'

const RUNTIME_CATALOG_SNAPSHOT_TTL_MS = 30_000
const RUNTIME_CATALOG_SNAPSHOT_MAX_ENTRIES = 64

type RuntimeCatalogSnapshotCacheEntry = {
  expiresAt: number
  value?: RuntimeCatalogSnapshot
  promise?: Promise<RuntimeCatalogSnapshot>
}

export type RuntimeCatalogSnapshot = {
  context: RuntimeContextOptions | undefined
  builtinTools: ReturnType<typeof getConfiguredToolsFromConfig>
  builtinSkills: ReturnType<typeof getConfiguredSkillsFromConfig>
  customMcps: ReturnType<typeof listCustomMcps>
  customSkills: ReturnType<typeof listCustomSkills>
  customAgents: ReturnType<typeof listCustomAgents>
  runtimeTools: RuntimeToolMetadata[]
  availableSkills: CustomAgentCatalogSkill[]
  customAgentSummaries: CustomAgentSummary[]
  toolAgentNames: Map<string, string[]>
  skillAgentNames: Map<string, string[]>
}

let runtimeCatalogSnapshotGeneration = 0
const runtimeCatalogSnapshotCache = new Map<string, RuntimeCatalogSnapshotCacheEntry>()

function humanize(value: string) {
  return value
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function normalizeContext(options?: RuntimeContextOptions): RuntimeContextOptions | undefined {
  const directory = resolveProjectDirectory(options?.directory)
  return directory ? { directory } : undefined
}

function snapshotCacheKey(options?: RuntimeContextOptions) {
  const settings = getEffectiveSettings()
  const directory = resolveProjectDirectory(options?.directory) || getRuntimeHomeDir()
  return JSON.stringify({
    generation: runtimeCatalogSnapshotGeneration,
    runtimeToolGeneration: currentRuntimeToolCacheGeneration(),
    directory,
    provider: settings.effectiveProviderId || '',
    model: settings.effectiveModel || '',
  })
}

function rememberSnapshotEntry(key: string, entry: RuntimeCatalogSnapshotCacheEntry) {
  runtimeCatalogSnapshotCache.set(key, entry)
  while (runtimeCatalogSnapshotCache.size > RUNTIME_CATALOG_SNAPSHOT_MAX_ENTRIES) {
    const oldestKey = runtimeCatalogSnapshotCache.keys().next().value
    if (typeof oldestKey !== 'string') break
    runtimeCatalogSnapshotCache.delete(oldestKey)
  }
}

function uniqueSortedLabels(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b))
}

function buildAgentRelationshipMaps(
  configuredAgents: ReturnType<typeof getConfiguredAgentsFromConfig>,
  customAgentSummaries: CustomAgentSummary[],
) {
  const toolAgentNames = new Map<string, string[]>()
  const skillAgentNames = new Map<string, string[]>()

  const addToolAgent = (toolId: string, label: string) => {
    toolAgentNames.set(toolId, [...(toolAgentNames.get(toolId) || []), label])
  }
  const addSkillAgent = (skillName: string, label: string) => {
    skillAgentNames.set(skillName, [...(skillAgentNames.get(skillName) || []), label])
  }

  for (const agent of configuredAgents) {
    const label = agent.label || agent.name
    for (const toolId of agent.toolIds || []) addToolAgent(toolId, label)
    for (const skillName of agent.skillNames || []) addSkillAgent(skillName, label)
  }

  for (const agent of customAgentSummaries) {
    if (!agent.enabled || !agent.valid) continue
    const label = humanize(agent.name)
    for (const toolId of agent.toolIds || []) addToolAgent(toolId, label)
    for (const skillName of agent.skillNames || []) addSkillAgent(skillName, label)
  }

  return {
    toolAgentNames: new Map(Array.from(toolAgentNames.entries()).map(([key, values]) => [key, uniqueSortedLabels(values)])),
    skillAgentNames: new Map(Array.from(skillAgentNames.entries()).map(([key, values]) => [key, uniqueSortedLabels(values)])),
  }
}

async function buildRuntimeCatalogSnapshot(options?: RuntimeContextOptions): Promise<RuntimeCatalogSnapshot> {
  return measureAsyncPerf('catalog.snapshot.build', async () => {
    const context = normalizeContext(options)
    const [
      effectiveSkills,
      runtimeToolEntries,
    ] = await Promise.all([
      listEffectiveSkills(context),
      listRuntimeToolsForContext(context),
    ])
    const builtinTools = getConfiguredToolsFromConfig()
    const builtinSkills = getConfiguredSkillsFromConfig()
    const customMcps = listCustomMcps(context)
    const customSkills = listCustomSkills(context)
    const customAgents = listCustomAgents(context)
    const runtimeTools = runtimeToolEntries
      .map(toRuntimeToolMetadata)
      .filter((tool): tool is RuntimeToolMetadata => Boolean(tool))
    const availableSkills = effectiveSkills.map((skill) => ({
      name: skill.name,
      label: skill.label,
      description: skill.description,
      source: skill.source,
      origin: skill.origin,
      scope: skill.scope,
      location: skill.location,
      toolIds: skill.toolIds,
    }))
    const customAgentSummaries = summarizeCustomAgents({
      availableSkills,
      state: {
        customMcps,
        customSkills,
        customAgents,
      },
      builtinTools,
      builtinSkills,
      runtimeTools,
    })
    const relationships = buildAgentRelationshipMaps(getConfiguredAgentsFromConfig(), customAgentSummaries)

    return {
      context,
      builtinTools,
      builtinSkills,
      customMcps,
      customSkills,
      customAgents,
      runtimeTools,
      availableSkills,
      customAgentSummaries,
      ...relationships,
    }
  }, {
    slowThresholdMs: 150,
    slowData: { context: options?.directory ? 'project' : 'global' },
  })
}

export function invalidateRuntimeCatalogSnapshotCache() {
  runtimeCatalogSnapshotGeneration += 1
  runtimeCatalogSnapshotCache.clear()
}

export async function getRuntimeCatalogSnapshot(options?: RuntimeContextOptions): Promise<RuntimeCatalogSnapshot> {
  const key = snapshotCacheKey(options)
  const now = Date.now()
  const cached = runtimeCatalogSnapshotCache.get(key)
  if (cached?.value && cached.expiresAt > now) return cached.value
  if (cached?.promise) return await cached.promise

  const promise = buildRuntimeCatalogSnapshot(options)
  rememberSnapshotEntry(key, { expiresAt: now + RUNTIME_CATALOG_SNAPSHOT_TTL_MS, promise })
  try {
    const value = await promise
    rememberSnapshotEntry(key, { expiresAt: Date.now() + RUNTIME_CATALOG_SNAPSHOT_TTL_MS, value })
    return value
  } catch (error) {
    runtimeCatalogSnapshotCache.delete(key)
    throw error
  }
}
