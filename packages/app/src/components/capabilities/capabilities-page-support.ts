export type Tab = 'map' | 'relationships' | 'tools' | 'skills'
export const CAPABILITY_RELATIONSHIP_FEATURE_GATE_KEY = 'open-cowork.feature.capabilityRelationshipGraph'

export type Selection =
  | { type: 'tool'; id: string }
  | { type: 'skill'; name: string }
  | null

function storageOrNull(storage?: Storage | null) {
  if (storage) return storage
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function isCapabilityRelationshipGraphEnabled(storage?: Storage | null) {
  const target = storageOrNull(storage)
  if (!target) return false
  try {
    return target.getItem(CAPABILITY_RELATIONSHIP_FEATURE_GATE_KEY) === 'true'
  } catch {
    return false
  }
}

export {
  buildCapabilityMapGroups,
  buildCapabilityMapSections,
  buildCapabilityToolSections,
  capabilitySkillTier,
  capabilityToolTier,
  linkedSkillsForTool,
  linkedToolsForSkill,
  mergedRuntimeToolset,
  prettyKind,
  prettySkillKind,
  prettySkillSource,
  safeText,
  skillMatchesCapabilityQuery,
  stripFrontmatter,
  toolMatchesCapabilityQuery,
} from './capability-map-model.ts'
export type {
  CapabilityLinkedTool,
  CapabilityMapGroup,
  CapabilityMapSection,
  CapabilityMapTier,
  CapabilityToolSection,
} from './capability-map-model.ts'
export { buildCapabilityRelationshipRows } from './capability-relationship-model.ts'
export type { CapabilityRelationshipRow } from './capability-relationship-model.ts'
export { buildAgentSeedFromSkill, buildAgentSeedFromTool } from './capability-agent-seeds.ts'
