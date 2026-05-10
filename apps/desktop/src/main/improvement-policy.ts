import type {
  AppSettings,
  ImprovementPolicyDiagnostics,
} from '@open-cowork/shared'

export interface ImprovementProposalPolicyScope {
  agentName?: string | null
  projectId?: string | null
  crewId?: string | null
}

function normalizePolicyKey(value?: string | null) {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized || null
}

function hasEnabledKey(map: Record<string, boolean>, value?: string | null) {
  const key = normalizePolicyKey(value)
  return Boolean(key && map[key] === true)
}

function countEnabledKeys(map: Record<string, boolean>) {
  return Object.values(map).filter(Boolean).length
}

export function isImprovementProposalEnabledForScope(
  settings: AppSettings,
  scope: ImprovementProposalPolicyScope = {},
) {
  if (!settings.improvementProposalsEnabled) return false
  if (hasEnabledKey(settings.improvementProposalsDisabledAgents, scope.agentName)) return false
  if (hasEnabledKey(settings.improvementProposalsDisabledProjects, scope.projectId)) return false
  if (hasEnabledKey(settings.improvementProposalsDisabledCrews, scope.crewId)) return false
  return true
}

export function buildImprovementPolicyDiagnostics(settings: AppSettings): ImprovementPolicyDiagnostics {
  return {
    proposalsEnabled: settings.improvementProposalsEnabled,
    disabledAgentCount: countEnabledKeys(settings.improvementProposalsDisabledAgents),
    disabledProjectCount: countEnabledKeys(settings.improvementProposalsDisabledProjects),
    disabledCrewCount: countEnabledKeys(settings.improvementProposalsDisabledCrews),
  }
}
