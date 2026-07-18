import type { OpenCodeUsageReport } from '../opencode-usage.js'
import type { HeartbeatStatus } from '../heartbeat.js'
import type { ServiceHealthReport } from '../service-health.js'
import type { AlphaHealthSummary } from '../alpha-health.js'
import type { OperatorSafetyReport } from '../operator-safety.js'
import type { ObservabilitySloResult, SupportOperationsContract, TraceCorrelationIndex } from '../observability-contract.js'
import type { ClaimRegistryReport } from '../claim-registry.js'
import type { RunExplanation } from '../product-onboarding.js'
import type { MissionAgentTeamSummary, MissionChannelSummary, RunThroughputPoint } from '../mission-data.js'
import {
  buildMissionControlSourceSummary,
  type MissionControlSourceContract,
  type MissionControlSourceAvailability,
  type MissionControlWindowOptionMap,
  type MissionControlDataPlaneV2,
  type OperationsCockpitSummary,
} from '../mission-control-view-model.js'

export interface DashboardView {
  headline: string
  activeTasks: any[]
  attentionTasks: any[]
  recentDoneTasks: any[]
  visibleTasks: any[]
  events: any[]
  archivedCount: number
  activeSessions: any[]
  recentSessions: any[]
  roadmaps: Array<any & { totalTasks: number; doneTasks: number; blockedTasks: number; runningTasks: number; progress: number }>
  projectBindings: any[]
  environments: any[]
  supervisors: any[]
  supervisorObservability: any
  requestCount: number
  usage: OpenCodeUsageReport
  heartbeat: HeartbeatStatus
  serviceHealth: ServiceHealthReport
  alphaHealth: AlphaHealthSummary
  readiness: any
  governance: any
  operator: OperatorSafetyReport
  operationsCockpit: OperationsCockpitSummary
  releaseCockpit: ClaimRegistryReport
  runExplanations: RunExplanation[]
  alerts: any[]
  metrics: any
  profiles: Record<string, any>
  runs: any[]
  promotionScorecards: any[]
  promotionDecisions: any[]
  throughput: RunThroughputPoint[]
  channels: MissionChannelSummary
  agentTeams: MissionAgentTeamSummary
  agentFactory: AgentFactoryView
  arena: ArenaView
  workGraph: WorkGraphView
  sourceDiagnostics: Array<{ source: string; available: boolean; summary: string }>
  sourceContracts: DashboardSourceContract[]
  sourceSummary: ReturnType<typeof buildMissionControlSourceSummary>
  dataPlane: MissionControlDataPlaneV2
  traceCorrelation?: TraceCorrelationIndex
  observabilitySlo: ObservabilitySloResult[]
  supportOperations?: SupportOperationsContract
  windows: Record<string, DashboardSourceContract>
  windowQuery?: string
  pipeline: string[]
  counts: {
    pending: number
    running: number
    done: number
    blocked: number
    paused: number
    cancelled: number
    attention: number
    alerts: number
    environments: number
    retainedEnvironments: number
    cleanupFailedEnvironments: number
    healthAttention: number
    alphaBlockers: number
  }
}

export type DashboardSourceContract = MissionControlSourceContract

export interface AgentFactoryProfileView {
  name: string
  version: string
  revision?: string
  lastUpdatedAt?: string
  description?: string
  agent: string
  model: string
  role: string
  skills: string[]
  mcpServers: string[]
  tools: string[]
  capabilities: string[]
  permissionCounts: Record<'allow' | 'ask' | 'deny', number>
  allowedPermissions: string[]
  riskyPermissions: string[]
  environment: string
  budget: {
    maxTokens: number
    contractTokens?: number
    maxCostUsd?: number
    maxRuntimeMs?: number
    retryLimit?: number
    humanGate?: string
  }
  outputContract: string
  promotion: PromotionProjectionView
  validation: 'valid' | 'warning' | 'blocked'
  warnings: string[]
  runStats: { total: number; active: number; failed: number; lastStatus?: string }
}

export interface AgentFactoryTeamView {
  name: string
  description?: string
  revision: string
  version?: string
  lastUpdatedAt?: string
  promotion: PromotionProjectionView
  validation: 'valid' | 'warning' | 'blocked'
  warnings: string[]
  roles: Array<{ stage: string; profile: string; agent?: string; model?: string; role?: string }>
  capabilityRequirements: Array<{ stage: string; capabilities: string[] }>
  qualitySpecDefaultKeys: string[]
  references: { roadmaps: number; tasks: number; activeTasks: number; recentRuns: number }
}

export interface PromotionProjectionView {
  state: string
  scorecardId?: string
  recommendation?: string
  sourceKind?: string
  sourceId?: string
  sourceVersion?: string
  decisionId?: string
  rollback?: any
  regression?: any
  updatedAt?: string
}

export interface AgentFactoryView {
  profiles: AgentFactoryProfileView[]
  teams: AgentFactoryTeamView[]
  blueprints: any[]
  blueprintSources: any[]
  invalidReferences: MissionAgentTeamSummary['invalidReferences']
  scorecards: any[]
  decisions: any[]
  blueprintGates: any[]
  totals: {
    profiles: number
    teams: number
    blueprints: number
    blockedProfiles: number
    deprecatedProfiles: number
    blockedTeams: number
    warnings: number
    scorecards: number
    blueprintGates: number
  }
}

export interface ArenaEvidenceView {
  scorecard: any
  subject: string
  scoreLabel: string
  scorePct?: number
  failedMetrics: any[]
  artifacts: unknown[]
}

export interface ArenaComparisonView {
  key: string
  label: string
  rows: ArenaEvidenceView[]
}

export interface ArenaRunView {
  id: string
  status: string
  passed: boolean
  sourceLabel: string
  inputLabel: string
  candidateLabel: string
  candidateHref: string
  version: string
  scoreLabel: string
  conclusion: string
  recommendation: string
  promotionOutcome: string
  regressionLabel: string
  gateResult: string
  failedMetrics: any[]
  thresholds: any[]
  artifacts: unknown[]
  evidence: unknown[]
  updatedAt?: string
  createdAt?: string
  scorecard: any
  decision?: any
}

export interface PromotionHistoryEntryView {
  id: string
  subjectLabel: string
  subjectHref: string
  version: string
  event: string
  gateResult: string
  reviewer: string
  rollbackEligibility: string
  sourceLabel: string
  timestamp?: string
  statusClass: string
}

export interface ArenaView {
  runs: ArenaRunView[]
  evidence: ArenaEvidenceView[]
  comparisons: ArenaComparisonView[]
  promotionHistory: PromotionHistoryEntryView[]
  source: {
    available: boolean
    partial: boolean
    scorecards: number
    decisions: number
  }
  totals: {
    runs: number
    passed: number
    failed: number
    artifacts: number
    comparisons: number
    history: number
  }
}

export interface WorkGraphNode {
  id: string
  kind: string
  label: string
  status: string
  severity: 'critical' | 'warning' | 'info' | 'ok'
  source: string
  href: string
  updatedAt?: string
  alias?: string
  summary?: string
  redacted?: boolean
}

export interface WorkGraphEdge {
  from: string
  to: string
  kind: string
  source: string
  status: string
  severity: WorkGraphNode['severity']
  reason: string
}

export interface WorkGraphView {
  nodes: WorkGraphNode[]
  edges: WorkGraphEdge[]
  attentionEdges: WorkGraphEdge[]
  selected?: WorkGraphNode
  sources: Array<{ name: string; route: string; available: boolean; count: number }>
  window: {
    nodes: DashboardSourceContract
    edges: DashboardSourceContract
  }
  stats: {
    channels: number
    sessions: number
    projects: number
    initiatives: number
    issues: number
    runs: number
    supervisors: number
    gates: number
    alerts: number
    blocked: number
  }
}

type WorkGraphSourceAvailability = MissionControlSourceAvailability
type DashboardWindowOptionMap = MissionControlWindowOptionMap

export type { WorkGraphSourceAvailability, DashboardWindowOptionMap }
