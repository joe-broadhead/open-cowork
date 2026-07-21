import type { EnvironmentRunRecord, EnvironmentSelector } from '../environments.js'
import type { HumanGateTimeoutAction } from '../config.js'
import type { RunStatus, StageResult, TaskQualitySpec, WorkflowDecision, WorkStatus } from '../workflow.js'
import type { RuntimeIsolationProfile, RuntimeIsolationProfileSummary, RuntimeLifecycleDiagnostic } from '../runtime-isolation.js'

export type { WorkStatus } from '../workflow.js'
export type { AuditLedgerRecord } from '../audit-ledger.js'

export type RoadmapStatus = 'active' | 'done' | 'blocked' | 'archived'
export type WorkDependencyType = 'blocks' | 'blocked_by' | 'parent' | 'child' | 'related' | 'duplicate'
export type ManualGate = 'approval_required' | 'credentials_required' | 'external_dependency' | 'waiting_for_user'
export type WorkTaskReadinessStatus = 'runnable' | 'blocked' | 'waiting' | 'scheduled' | 'paused' | 'running' | 'done'
export type HumanGateType = 'task_start' | 'stage_transition' | 'external_side_effect' | 'budget_exception' | 'destructive_action' | 'credential_use' | 'manual'
export type HumanGateStatus = 'pending' | 'approved' | 'rejected' | 'timed_out' | 'escalated' | 'consumed'
export type HumanGateDecision = 'approve' | 'reject'
export type HumanGateScope = 'once' | 'always'
export type AlertSeverity = 'info' | 'warning' | 'critical'
export type AlertStatus = 'active' | 'acknowledged' | 'resolved' | 'suppressed'
export type RoadmapSupervisorStatus = 'active' | 'paused' | 'blocked' | 'completed' | 'archived'
export type SupervisorWakeReason = 'schedule' | 'issue_completed' | 'gate_requested' | 'failure_alert' | 'manual_poke' | 'delegated_progress' | 'blocked_work' | 'stale_run' | 'channel_mention' | 'completion_proposal'
export type SupervisorWakeupReceiptStatus = 'leased' | 'completed' | 'failed'
export type TaskDispatchReceiptStatus = 'starting' | 'started' | 'failed'
export type ProjectBindingScope = 'global' | 'opencode' | 'telegram' | 'whatsapp' | 'discord'
export type ProjectNotificationMode = 'immediate' | 'digest' | 'muted'
export type RoadmapCompletionPolicy = 'manual' | 'assistant_proposes_user_approves' | 'auto_when_evidence_complete' | 'never_auto_complete'
export type RoadmapCompletionProposalStatus = 'pending' | 'approved' | 'rejected' | 'expired'

export const WORK_EVENT_TYPE_QUERY_LIMIT = 50_000
export const STORAGE_OPERATION_LOCK_NAME = '.storage-operation.lock'
export const STORAGE_OPERATION_LOCK_STALE_MS = 30 * 60 * 1000

export interface RoadmapQualitySpec {
  objective?: string
  acceptanceCriteria: string[]
  definitionOfDone: string[]
  evidenceRequirements: string[]
  requiredArtifacts: string[]
  residualRiskNotes: string[]
  completionPolicy: RoadmapCompletionPolicy
}

export interface RoadmapRecord {
  id: string
  title: string
  status: RoadmapStatus
  priority: 'HIGH' | 'MEDIUM' | 'LOW'
  agentTeam?: string
  environment?: EnvironmentSelector
  qualitySpec?: RoadmapQualitySpec
  createdAt: string
  updatedAt: string
}

export interface RoadmapSupervisorRecord {
  supervisorId: string
  roadmapId: string
  sessionId: string
  profile: string
  status: RoadmapSupervisorStatus
  isDefault: boolean
  cadence: Record<string, unknown>
  eventTriggers: Record<string, unknown>
  lastReviewedEventId?: number
  lastReviewAt?: string
  nextReviewAt?: string
  completionPolicy: Record<string, unknown>
  notificationPolicyRef?: string
  note?: string
  wakeLeaseOwner?: string
  wakeLeaseExpiresAt?: string
  lastWakeAt?: string
  lastWakeReason?: string
  lastWakeEventId?: number
  lastResultHash?: string
  lastResultAt?: string
  lastResultStatus?: string
  lastResultSummary?: string
  createdAt: string
  updatedAt: string
}

export interface RoadmapSupervisorWakeupRecord {
  supervisor: RoadmapSupervisorRecord
  reason: string
  wakeReason: SupervisorWakeReason
  wakeReasonDetail: string
  triggerEvents: WorkEventRecord[]
  cursorEventId: number
  windowKey: string
  idempotencyKey: string
  leaseOwner: string
  leaseExpiresAt: string
  receiptId?: string
  notificationPolicyRef?: string
}

export interface SupervisorWakeupReceiptRecord {
  id: string
  supervisorId: string
  roadmapId: string
  wakeReason: SupervisorWakeReason
  reasonDetail: string
  idempotencyKey: string
  windowKey: string
  cursorEventId: number
  triggerEventIds: number[]
  leaseOwner: string
  leaseExpiresAt: string
  status: SupervisorWakeupReceiptStatus
  summary?: string
  inspectedInputs: string[]
  changedObjectIds: string[]
  recommendation?: string
  nextAction?: string
  nextWakeAt?: string
  createdAt: string
  completedAt?: string
  updatedAt: string
}

export interface TaskDispatchReceiptRecord {
  id: string
  taskId: string
  stage: string
  profile?: string
  idempotencyKey: string
  leaseOwner: string
  leaseExpiresAt: string
  status: TaskDispatchReceiptStatus
  runId?: string
  sessionId?: string
  environment?: EnvironmentRunRecord
  promptSubmittedAt?: string
  failureReason?: string
  createdAt: string
  updatedAt: string
}

export type TaskDispatchAcquisitionKind = 'environment' | 'session'
export type TaskDispatchAcquisitionStatus = 'intent' | 'acquired' | 'released' | 'failed'

export interface TaskDispatchAcquisitionRecord {
  dispatchId: string
  taskId: string
  stage: string
  leaseOwner: string
  kind: TaskDispatchAcquisitionKind
  status: TaskDispatchAcquisitionStatus
  provider: string
  idempotencyKey: string
  resourceId?: string
  resource?: Record<string, unknown>
  metadata: Record<string, unknown>
  leadershipScope?: string
  leaderId?: string
  fencingToken?: string
  leaseExpiresAt: string
  dispatchStatus: TaskDispatchReceiptStatus
  createdAt: string
  updatedAt: string
  error?: string
}

export interface ProjectBindingRecord {
  id: string
  alias: string
  roadmapId: string
  sessionId: string
  scope: ProjectBindingScope
  provider?: string
  chatId?: string
  threadId?: string
  title?: string
  notificationMode: ProjectNotificationMode
  mutedUntil?: string
  quietHours: Record<string, unknown>
  lastDigestAt?: string
  createdAt: string
  updatedAt: string
}

export interface RoadmapCompletionProposalRecord {
  id: string
  roadmapId: string
  proposedBy?: string
  sessionId?: string
  evidence: string[]
  unresolvedRisks: string[]
  recommendation: string
  status: RoadmapCompletionProposalStatus
  decisionBy?: string
  decisionNote?: string
  expiresAt?: string
  createdAt: string
  updatedAt: string
}

export interface WorkTaskRecord {
  id: string
  roadmapId: string
  title: string
  description: string
  status: WorkStatus
  priority: 'HIGH' | 'MEDIUM' | 'LOW'
  agent: string
  agentTeam?: string
  stageProfiles?: Record<string, string>
  environment?: EnvironmentSelector
  pipeline: string[]
  currentStage?: string
  currentRunId?: string
  attempts: Record<string, number>
  note?: string
  earliestStartAt?: string
  deadlineAt?: string
  recurrence?: string
  manualGate?: ManualGate
  slaClass?: string
  qualitySpec?: TaskQualitySpec
  /**
   * Origin of the task for idempotent externally-triggered creation. Defaults to
   * ('manual', `manual:${id}`) — unique per call — so historical rows keep their
   * behavior. When a caller supplies an idempotency key the pair becomes the
   * dedupe identity backing the schema's UNIQUE(source_type, source_key).
   */
  sourceType?: string
  sourceKey?: string
  createdAt: string
  updatedAt: string
}

export interface WorkDependencyRecord {
  taskId: string
  dependsOnTaskId: string
  type: WorkDependencyType
  createdAt: string
}

export interface WorkTaskReadiness {
  status: WorkTaskReadinessStatus
  reason: string
  blockers: string[]
}

export interface RunRecord {
  id: string
  taskId: string
  stage: string
  sessionId: string
  profile: string
  agentTeam?: string
  agentTeamVersion?: string
  resolvedProfile?: string
  resolvedAgent?: string
  environment?: EnvironmentRunRecord
  runtimeProfile?: RuntimeIsolationProfile
  status: RunStatus
  attempt: number
  startedAt: string
  completedAt?: string
  leaseOwner?: string
  leaseExpiresAt?: string
  schedulerGeneration?: string
  costUsd?: number
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  runtimeMs?: number
  result?: StageResult
}

export interface RunAttributionInput {
  costUsd?: number
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface RunResolutionInput {
  agentTeam?: string
  agentTeamVersion?: string
  resolvedProfile?: string
  resolvedAgent?: string
  environment?: EnvironmentRunRecord
  runtimeProfile?: RuntimeIsolationProfile
  taskQualitySpec?: TaskQualitySpec
}

export type WorkEnvironmentAction = 'retain' | 'release' | 'abort' | 'cleanup'

export interface WorkEnvironmentView {
  id: string
  runId: string
  taskId: string
  roadmapId?: string
  taskTitle?: string
  stage: string
  sessionId: string
  runStatus: RunStatus
  name: string
  backend: string
  status: EnvironmentRunRecord['status']
  provider?: string
  class?: string
  image?: string
  imageDigest?: string
  runtime?: string
  leaseId?: string
  runEnvironmentId?: string
  workdir?: string
  ttlMs: number
  startedAt: string
  updatedAt: string
  expiresAt?: string
  cleanup: EnvironmentRunRecord['cleanup']
  preflight: EnvironmentRunRecord['preflight']
  resources: EnvironmentRunRecord['resources']
  network: EnvironmentRunRecord['network']
  runtimeProfile?: RuntimeIsolationProfileSummary
  lifecycleDiagnostics: RuntimeLifecycleDiagnostic[]
  artifacts: string[]
  costUsd?: number
  metadata: Record<string, unknown>
}

export interface WorkEventRecord {
  id: number
  type: string
  subjectId?: string
  payload: Record<string, unknown>
  createdAt: string
  processedAt?: string
}

export type DelegatedWorkProgressKind = 'created' | 'dispatched' | 'stage_advanced' | 'blocked' | 'gate_opened' | 'completed' | 'failed' | 'completion_proposed'
export type DelegationProgressRouteReceiptState = 'pending' | 'delivered' | 'failed' | 'retried' | 'suppressed' | 'deferred' | 'muted' | 'stale_parent' | 'orphaned'

export interface DelegationProgressRouteReceiptRecord {
  dedupeKey: string
  progressKey?: string
  idempotencyKey?: string
  progress?: DelegatedWorkProgressKind
  targetKey?: string
  provider?: string
  sessionId?: string
  delivery?: string
  state: DelegationProgressRouteReceiptState
  reason?: string
  error?: string
  deferredUntil?: string
  suppressedUntil?: string
  progressEventId?: number
  attemptCount: number
  lastEventId?: number
  createdAt: string
  updatedAt: string
  nextAction: string
}

export interface AuditEventInput {
  actor: string
  source: string
  operation: string
  target?: string
  result: 'ok' | 'denied' | 'error'
  details?: Record<string, unknown>
}

export interface HumanGateRecord {
  id: string
  type: HumanGateType
  status: HumanGateStatus
  roadmapId?: string
  taskId?: string
  runId?: string
  stage?: string
  reason: string
  requestedBy: string
  requestedAt: string
  updatedAt: string
  expiresAt?: string
  timeoutAction: HumanGateTimeoutAction
  escalatedAt?: string
  decidedBy?: string
  decisionNote?: string
  scope?: HumanGateScope
  scopeKey?: string
  details: Record<string, unknown>
}

export interface HumanGateInput {
  type: HumanGateType
  roadmapId?: string
  taskId?: string
  runId?: string
  stage?: string
  reason: string
  requestedBy?: string
  expiresAt?: string
  timeoutAction?: HumanGateTimeoutAction
  scopeKey?: string
  details?: Record<string, unknown>
}

export interface HumanGateDecisionInput {
  decision: HumanGateDecision
  scope?: HumanGateScope
  actor?: string
  source?: string
  note?: string
}

export interface HumanGateDecisionResult {
  gate: HumanGateRecord
  task?: WorkTaskRecord
}

export interface AlertRecord {
  id: string
  key: string
  status: AlertStatus
  severity: AlertSeverity
  source: string
  target?: string
  summary: string
  evidence: string[]
  nextAction: string
  firstSeenAt: string
  lastSeenAt: string
  lastNotifiedAt?: string
  resolvedAt?: string
  acknowledgedAt?: string
  suppressedUntil?: string
  dedupeCount: number
  details: Record<string, unknown>
}

export interface AlertInput {
  key: string
  severity: AlertSeverity
  source: string
  target?: string
  summary: string
  evidence?: string[]
  nextAction: string
  details?: Record<string, unknown>
}

export interface AlertUpsertResult {
  alert: AlertRecord
  created: boolean
  notify: boolean
}

export type ChannelBindingMode = 'chat' | 'task' | 'roadmap'

export interface ChannelBindingRecord {
  provider: string
  chatId: string
  threadId?: string
  sessionId: string
  mode: ChannelBindingMode
  roadmapId?: string
  taskId?: string
  title?: string
  createdAt: string
  updatedAt: string
}

export type ChannelClaimAction = 'trust_target' | 'prove_denial'
export type ChannelClaimStatus = 'pending' | 'accepted' | 'expired' | 'denied'

export interface ChannelClaimCodeRecord {
  id: string
  provider: string
  action: ChannelClaimAction
  codeHash: string
  codeFingerprint: string
  status: ChannelClaimStatus
  createdBy: string
  createdAt: string
  expiresAt: string
  acceptedAt?: string
  acceptedTargetHash?: string
  deniedAt?: string
  denialReason?: string
}

export interface WorkState {
  version: 1
  savedAt: string
  roadmaps: RoadmapRecord[]
  supervisors: RoadmapSupervisorRecord[]
  projectBindings: ProjectBindingRecord[]
  completionProposals: RoadmapCompletionProposalRecord[]
  tasks: WorkTaskRecord[]
  runs: RunRecord[]
  dependencies?: WorkDependencyRecord[]
}

export interface RoadmapSupervisorCreateInput {
  roadmapId: string
  sessionId: string
  profile?: string
  status?: RoadmapSupervisorStatus
  isDefault?: boolean
  cadence?: Record<string, unknown>
  eventTriggers?: Record<string, unknown>
  lastReviewedEventId?: number
  lastReviewAt?: string
  nextReviewAt?: string
  completionPolicy?: Record<string, unknown>
  notificationPolicyRef?: string
  note?: string
}

export interface RoadmapSupervisorUpdateInput {
  sessionId?: string
  profile?: string
  status?: RoadmapSupervisorStatus
  isDefault?: boolean
  cadence?: Record<string, unknown>
  eventTriggers?: Record<string, unknown>
  lastReviewedEventId?: number | null
  lastReviewAt?: string | null
  nextReviewAt?: string | null
  completionPolicy?: Record<string, unknown>
  notificationPolicyRef?: string | null
  note?: string | null
  lastResultHash?: string | null
  lastResultAt?: string | null
  lastResultStatus?: string | null
  lastResultSummary?: string | null
}

export interface RoadmapSupervisorResultTurnInput {
  supervisorId: string
  roadmapId: string
  leaseOwner: string
  cursorEventId: number
}

export interface RoadmapSupervisorResultActionInput {
  type: string
  summary: string
}

export interface RoadmapSupervisorCompletionInput {
  recommendation: string
  evidence: string[]
  risks: string[]
}

export interface RoadmapSupervisorResultApplyInput {
  turn?: RoadmapSupervisorResultTurnInput
  status: string
  summary: string
  resultHash: string
  actions: RoadmapSupervisorResultActionInput[]
  questions: string[]
  proposedTasks: WorkTaskCreateInput[]
  completion?: RoadmapSupervisorCompletionInput
  nextReviewAt?: string
  recommendation?: string
  nextAction?: string
}

export interface RoadmapSupervisorResultApplyResult {
  applied: boolean
  appliedActions: string[]
  rejectedActions: string[]
  changedObjectIds: string[]
  recommendation?: string
  nextAction?: string
}

export interface ProjectBindingInput {
  alias: string
  roadmapId: string
  sessionId: string
  scope?: ProjectBindingScope
  provider?: string
  chatId?: string
  threadId?: string
  title?: string
  allowRebind?: boolean
  notificationMode?: ProjectNotificationMode
  mutedUntil?: string
  quietHours?: Record<string, unknown>
  lastDigestAt?: string
}

export interface SupervisedProjectCreateInput {
  idempotencyKey?: string
  roadmap: {
    title: string
    priority?: 'HIGH' | 'MEDIUM' | 'LOW'
    agentTeam?: string
    environment?: EnvironmentSelector
    qualitySpec?: RoadmapQualitySpec
  }
  tasks?: WorkTaskCreateInput[]
  supervisor: Omit<RoadmapSupervisorCreateInput, 'roadmapId'>
  binding: Omit<ProjectBindingInput, 'roadmapId'>
  event?: { type: string; payload?: Record<string, unknown> }
}

export interface SupervisedProjectCreateResult {
  roadmap: RoadmapRecord
  tasks: WorkTaskRecord[]
  supervisor: RoadmapSupervisorRecord
  binding: ProjectBindingRecord
  idempotencyStatus?: 'created' | 'replayed'
}

export interface ProjectBindingUpdateInput {
  alias?: string
  roadmapId?: string
  sessionId?: string
  scope?: ProjectBindingScope
  provider?: string | null
  chatId?: string | null
  threadId?: string | null
  title?: string | null
  allowRebind?: boolean
  notificationMode?: ProjectNotificationMode
  mutedUntil?: string | null
  quietHours?: Record<string, unknown> | null
  lastDigestAt?: string | null
}

export interface ProjectContextResolution {
  status: 'resolved' | 'ambiguous' | 'not_found'
  reason: string
  binding?: ProjectBindingRecord
  roadmap?: RoadmapRecord
  supervisor?: RoadmapSupervisorRecord
  candidates?: ProjectBindingRecord[]
}

export interface WorkTaskView extends WorkTaskRecord {
  activeRun?: RunRecord
  lastRun?: RunRecord
  readiness?: WorkTaskReadiness
  dependencies?: WorkDependencyRecord[]
}

export interface WorkTaskUpdateInput {
  title?: string
  description?: string
  roadmapId?: string
  status?: WorkStatus
  priority?: 'HIGH' | 'MEDIUM' | 'LOW'
  agent?: string
  agentTeam?: string | null
  stageProfiles?: Record<string, string> | null
  environment?: EnvironmentSelector | null
  pipeline?: string[]
  currentStage?: string
  note?: string
  earliestStartAt?: string
  deadlineAt?: string
  recurrence?: string
  manualGate?: ManualGate | ''
  slaClass?: string
  qualitySpec?: TaskQualitySpec
}

export interface WorkTaskCreateInput {
  title: string
  description?: string
  roadmapId?: string
  priority?: 'HIGH' | 'MEDIUM' | 'LOW'
  agent?: string
  agentTeam?: string
  stageProfiles?: Record<string, string>
  environment?: EnvironmentSelector
  pipeline?: string[]
  note?: string
  dependsOn?: string[]
  earliestStartAt?: string
  deadlineAt?: string
  recurrence?: string
  manualGate?: ManualGate | ''
  slaClass?: string
  qualitySpec?: TaskQualitySpec
  /**
   * Optional dedupe key for idempotent externally-triggered creation. When
   * supplied, a repeated create with the same (sourceType, idempotencyKey)
   * returns the existing task instead of inserting a duplicate. Omit for the
   * default unique-per-call behavior.
   */
  idempotencyKey?: string
  /** Namespace for {@link idempotencyKey}; defaults to `external`. */
  sourceType?: string
}

export interface WorkDependencyInput {
  taskId: string
  dependsOnTaskId: string
  type?: WorkDependencyType
}

export interface WorkTaskBulkUpdateInput extends WorkTaskUpdateInput {
  taskId: string
}

export interface RoadmapUpdateInput {
  title?: string
  status?: RoadmapStatus
  priority?: 'HIGH' | 'MEDIUM' | 'LOW'
  agentTeam?: string | null
  environment?: EnvironmentSelector | null
  qualitySpec?: RoadmapQualitySpec | null
}

export interface RoadmapCompletionProposalInput {
  roadmapId: string
  proposedBy?: string
  sessionId?: string
  evidence?: string[]
  unresolvedRisks?: string[]
  recommendation?: string
  expiresAt?: string
}

export interface RoadmapCompletionProposalDecisionInput {
  decision: 'approve' | 'reject'
  actor?: string
  source?: string
  note?: string
}

export interface RoadmapCompletionProposalDecisionResult {
  proposal: RoadmapCompletionProposalRecord
  roadmap?: RoadmapRecord
  blockedReasons: string[]
}

export type WorkTaskAction = 'pause' | 'resume' | 'cancel' | 'retry' | 'done' | 'block'

export type ActiveRunControlAction = 'cancel' | 'stop' | 'retry' | 'restart'
export type ActiveRunControlOutcome = 'applied' | 'no_op' | 'denied'
export type ActiveRunControlReason =
  | 'applied'
  | 'run_not_found'
  | 'run_not_active'
  | 'task_not_found'
  | 'task_not_owned_by_run'
  | 'lease_missing'
  | 'lease_expired'
  | 'lease_owner_mismatch'
  | 'scheduler_generation_mismatch'

export interface ActiveRunControlSnapshot {
  runId: string
  taskId: string
  taskTitle: string
  taskStatus: WorkStatus
  stage: string
  status: RunStatus
  sessionId: string
  profile: string
  attempt: number
  startedAt: string
  leaseOwner?: string
  leaseExpiresAt?: string
  schedulerGeneration?: string
  heartbeatFreshness: 'fresh' | 'stale' | 'expired' | 'missing'
  heartbeatAgeMs?: number
  cancellable: boolean
  restartable: boolean
  lastOperatorAction?: {
    action: ActiveRunControlAction
    outcome: ActiveRunControlOutcome
    reason: ActiveRunControlReason
    actor: string
    source: string
    at: string
  }
}

export interface ActiveRunControlInput {
  runId: string
  action: ActiveRunControlAction
  actor?: string
  source?: string
  note?: string
  expectedLeaseOwner?: string
  expectedSchedulerGeneration?: string
  now?: number
}

export interface ActiveRunControlResult {
  action: ActiveRunControlAction
  outcome: ActiveRunControlOutcome
  reason: ActiveRunControlReason
  applied: boolean
  run?: RunRecord
  task?: WorkTaskRecord
  before?: ActiveRunControlSnapshot
  after?: ActiveRunControlSnapshot
  abortedSessionId?: string
  restartBehavior?: 'new_opencode_session_on_next_scheduler_dispatch' | 'durable_requeue_only' | 'not_applicable'
  nextAction: string
}

export interface WorkTaskActionResult {
  task: WorkTaskRecord
  abortedSessionId?: string
}

export interface WorkTaskUpdateResult {
  task: WorkTaskRecord
  abortedSessionId?: string
}

export interface WorkTaskArchiveResult {
  task: WorkTaskRecord
  abortedSessionId?: string
}

export interface WorkTaskDeleteResult {
  deleted: boolean
  task?: WorkTaskRecord
  abortedSessionId?: string
}

export interface RoadmapArchiveResult {
  roadmap: RoadmapRecord
  tasks: WorkTaskRecord[]
  supervisors: RoadmapSupervisorRecord[]
  abortedSessionIds: string[]
}

export interface RoadmapDeleteResult {
  deleted: boolean
  roadmap?: RoadmapRecord
  taskIds: string[]
  supervisorIds: string[]
  projectBindingIds: string[]
  completionProposalIds: string[]
  abortedSessionIds: string[]
}

export interface DelegatedWorkMutationInput {
  idempotencyKey: string
  targetType: string
  objective: string
  parentSessionId?: string
  notificationTarget?: Record<string, unknown>
  issue?: WorkTaskCreateInput & { roadmapId: string }
  project?: {
    roadmapId?: string
    title?: string
    priority?: 'HIGH' | 'MEDIUM' | 'LOW'
    agentTeam?: string
    environment?: EnvironmentSelector
    qualitySpec?: RoadmapQualitySpec
    tasks?: WorkTaskCreateInput[]
    supervisor?: RoadmapSupervisorCreateInput
    binding?: ProjectBindingInput
  }
}

export interface DelegatedWorkReceipt {
  idempotencyKey: string
  idempotencyStatus: 'created' | 'replayed'
  targetType: string
  taskIds: string[]
  roadmapId?: string
  supervisorId?: string
  projectBindingId?: string
  parentSessionId?: string
  links: Record<string, string>
  nextSchedulerAction: string
}

export interface WorkTaskRunStartResult {
  task: WorkTaskRecord
  run: RunRecord
}

export interface WorkLeaseSummary {
  running: number
  expired: number
  owners: Record<string, number>
}

export interface WorkTaskRunCompleteResult {
  applied: boolean
  task?: WorkTaskRecord
  run?: RunRecord
  decision?: WorkflowDecision
  reason?: ActiveRunControlReason
}

export interface WorkTaskRunFailResult {
  applied: boolean
  task?: WorkTaskRecord
  run?: RunRecord
}

export interface RunLeaseExpectation {
  owner?: string
  generation?: string
  now?: number
}

export const INBOX_ROADMAP_ID = 'roadmap_inbox'
export const MAX_WORK_EVENT_ROWS = 10000
export const WORK_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
// Audit ledger retention: rows older than the window (or beyond the row cap) are
// pruned from the oldest end of the hash chain during periodic maintenance, and
// the entry hash of the newest pruned row is recorded in meta as the retention
// anchor so chain verification of the retained suffix still passes.
export const AUDIT_LEDGER_RETENTION_MS = 365 * 24 * 60 * 60 * 1000
export const MAX_AUDIT_LEDGER_ROWS = 200_000
export const AUDIT_LEDGER_RETENTION_ANCHOR_HASH_KEY = 'auditLedgerRetentionAnchorHash'
export const DURABLE_WORK_EVENT_TYPES = [
  'audit.security',
  'channel.action.accepted',
  'channel.claim.denied',
  'delegation.accepted',
  'delegation.mapped',
  'delegation.progress',
  'delegation.progress.attempting',
  'delegation.progress.notified',
  'delegation.progress.failed',
  'delegation.progress.suppressed',
  'opencode.request.notified',
  'project.notification.attempting',
  'project.notification.sent',
  'project.notification.failed',
  'project.notification.suppressed',
  'team_assignment.created',
  'team_assignment.rejected',
  'team_assignment.gate_result',
  'team_assignment.review_outcome',
  'team_assignment.completion',
  'team_assignment.briefing.notified',
  'telegram.command_menu.registration.succeeded',
] as const
export const OPEN_HUMAN_GATE_STATUSES: HumanGateStatus[] = ['pending', 'escalated']

