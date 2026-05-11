export const COWORK_GOVERNANCE_SCHEMA_VERSION = 1

export type GovernanceSubjectKind = 'agent' | 'crew'
export type GovernanceLifecycleState = 'draft' | 'review' | 'approved' | 'active' | 'paused' | 'retired'
export type GovernanceScopeKind = 'system' | 'machine' | 'project' | 'workspace_profile'
export type GovernanceDependencyKind =
  | 'agent'
  | 'tool'
  | 'skill'
  | 'memory'
  | 'credential'
  | 'channel'
  | 'sop'
  | 'eval_suite'
  | 'workspace_profile'
export type GovernanceDependencySource = 'direct' | 'transitive'
export type GovernanceOwnerKind = 'user' | 'group' | 'system'
export type GovernanceMemoryBoundaryKind = 'none' | 'session' | 'agent' | 'crew' | 'workspace'
export type GovernanceIncidentControlKind =
  | 'pause_agent'
  | 'retire_agent'
  | 'pause_crew'
  | 'retire_crew'
  | 'export_audit'

export interface GovernanceOwner {
  kind: GovernanceOwnerKind
  id: string
  displayName: string
}

export interface GovernanceScope {
  kind: GovernanceScopeKind
  id: string
  label: string
  directory?: string | null
}

export interface GovernanceDependency {
  kind: GovernanceDependencyKind
  id: string
  label: string
  source: GovernanceDependencySource
  required: boolean
}

export interface GovernanceMemoryBoundary {
  kind: GovernanceMemoryBoundaryKind
  id: string | null
  label: string
}

export interface GovernanceIncidentControl {
  kind: GovernanceIncidentControlKind
  label: string
  available: boolean
  requiresConfirmation: boolean
  reason?: string | null
}

export interface GovernanceRegistrySubject {
  schemaVersion: number
  subjectKind: GovernanceSubjectKind
  subjectId: string
  name: string
  displayName: string
  description: string
  owner: GovernanceOwner
  lifecycle: GovernanceLifecycleState
  scope: GovernanceScope
  memoryBoundary: GovernanceMemoryBoundary
  evalSuiteId: string | null
  offboardingPath: string
  dependencies: GovernanceDependency[]
  incidentControls: GovernanceIncidentControl[]
}

export interface GovernanceDependencyIndexEntry {
  dependency: GovernanceDependency
  subjectIds: string[]
}

export interface GovernanceRegistryPayload {
  schemaVersion: number
  generatedAt: string
  subjects: GovernanceRegistrySubject[]
  dependencyIndex: GovernanceDependencyIndexEntry[]
}
