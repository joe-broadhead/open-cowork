import type { CustomAgentIssue, RuntimeContextOptions } from '@open-cowork/shared'
import { getRuntimeCatalogSnapshot, invalidateRuntimeCatalogSnapshotCache } from './runtime-catalog-snapshot.ts'
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

export function invalidateCustomAgentCatalogCache() {
  invalidateRuntimeCatalogSnapshotCache()
}

export async function getCustomAgentCatalog(options?: RuntimeContextOptions): Promise<CustomAgentCatalog> {
  const snapshot = await getRuntimeCatalogSnapshot(options)
  return buildCustomAgentCatalog({
    builtinTools: snapshot.builtinTools,
    builtinSkills: snapshot.builtinSkills,
    runtimeTools: snapshot.runtimeTools,
    availableSkills: snapshot.availableSkills,
    customMcps: snapshot.customMcps || [],
    customSkills: snapshot.customSkills || [],
    state: {
      customMcps: snapshot.customMcps,
      customSkills: snapshot.customSkills,
      customAgents: snapshot.customAgents,
    } satisfies CustomAgentCatalogState,
  })
}

export async function getCustomAgentSummaries(options?: RuntimeContextOptions): Promise<CustomAgentSummary[]> {
  return (await getRuntimeCatalogSnapshot(options)).customAgentSummaries
}
