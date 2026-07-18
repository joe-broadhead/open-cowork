/**
 * Pure row -> record mappers, type guards, and enum coercers for the work
 * store. Split verbatim out of `work-store.ts` (behavior-preserving pure move).
 *
 * Every function here is pure: it decodes a raw `node:sqlite` row (or coerces an
 * untrusted value) into a validated in-memory record, with no module-level
 * mutable state and no call into the transactional mutation core. `parseJSON`
 * (the fail-closed JSON column decoder) is reused from `./db.js`; the record
 * INTERFACES are imported type-only from `../work-store.js` (a type-only edge,
 * so no runtime import cycle). Names and signatures are identical to their
 * previous `work-store.ts` definitions, and `work-store.ts` re-exports the
 * externally-consumed mappers so importers are unchanged.
 */
import { parseJSON } from './db.js'
import { normalizeOptionalString, normalizeStringList, normalizeThreadId } from './validators.js'
import { normalizeEnvironmentSelector } from '../environments.js'
import { normalizeTaskQualitySpec } from '../workflow.js'
import type { HumanGateTimeoutAction } from '../config.js'
import type { AuditLedgerRecord } from '../audit-ledger.js'
import type {
  AlertRecord,
  AlertSeverity,
  AlertStatus,
  ChannelBindingMode,
  ChannelBindingRecord,
  ChannelClaimAction,
  ChannelClaimCodeRecord,
  ChannelClaimStatus,
  DelegatedWorkReceipt,
  HumanGateRecord,
  HumanGateStatus,
  HumanGateType,
  ProjectBindingRecord,
  ProjectBindingScope,
  ProjectNotificationMode,
  RoadmapCompletionPolicy,
  RoadmapCompletionProposalRecord,
  RoadmapCompletionProposalStatus,
  RoadmapQualitySpec,
  RoadmapRecord,
  RoadmapSupervisorRecord,
  RoadmapSupervisorStatus,
  RunRecord,
  SupervisorWakeReason,
  SupervisorWakeupReceiptRecord,
  SupervisorWakeupReceiptStatus,
  TaskDispatchReceiptRecord,
  TaskDispatchReceiptStatus,
  WorkDependencyRecord,
  WorkDependencyType,
  WorkEventRecord,
  WorkTaskRecord,
} from '../work-store.js'

export function normalizeRoadmapQualitySpec(value: unknown): RoadmapQualitySpec | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('roadmap qualitySpec must be an object')
  const input = value as any
  return {
    objective: normalizeOptionalString(input.objective, 2000),
    acceptanceCriteria: normalizeStringList(input.acceptanceCriteria, 2000),
    definitionOfDone: normalizeStringList(input.definitionOfDone, 2000),
    evidenceRequirements: normalizeStringList(input.evidenceRequirements, 2000),
    requiredArtifacts: normalizeStringList(input.requiredArtifacts, 2000),
    residualRiskNotes: normalizeStringList(input.residualRiskNotes, 2000),
    completionPolicy: normalizeRoadmapCompletionPolicy(input.completionPolicy),
  }
}

function normalizeRoadmapCompletionPolicy(value: unknown): RoadmapCompletionPolicy {
  if (value === undefined || value === null || value === '') return 'assistant_proposes_user_approves'
  if (value === 'manual' || value === 'assistant_proposes_user_approves' || value === 'auto_when_evidence_complete' || value === 'never_auto_complete') return value
  throw new Error(`roadmap completionPolicy must be manual, assistant_proposes_user_approves, auto_when_evidence_complete, or never_auto_complete: ${String(value)}`)
}

function normalizeAlertStatus(value: unknown): AlertStatus | undefined {
  return ['active', 'acknowledged', 'resolved', 'suppressed'].includes(String(value)) ? value as AlertStatus : undefined
}

function normalizeBindingMode(mode: any): ChannelBindingMode {
  return ['chat', 'task', 'roadmap'].includes(mode) ? mode as ChannelBindingMode : 'chat'
}

function normalizeBindingRoadmapSupervisorStatus(status: any): RoadmapSupervisorStatus | undefined {
  return ['active', 'paused', 'blocked', 'completed', 'archived'].includes(status) ? status as RoadmapSupervisorStatus : undefined
}

function normalizeSupervisorWakeReason(reason: any): SupervisorWakeReason | undefined {
  return ['schedule', 'issue_completed', 'gate_requested', 'failure_alert', 'manual_poke', 'delegated_progress', 'blocked_work', 'stale_run', 'channel_mention', 'completion_proposal'].includes(reason) ? reason as SupervisorWakeReason : undefined
}

function normalizeSupervisorWakeupReceiptStatus(status: any): SupervisorWakeupReceiptStatus | undefined {
  return ['leased', 'completed', 'failed'].includes(status) ? status as SupervisorWakeupReceiptStatus : undefined
}

function normalizeTaskDispatchReceiptStatus(status: any): TaskDispatchReceiptStatus | undefined {
  return ['starting', 'started', 'failed'].includes(status) ? status as TaskDispatchReceiptStatus : undefined
}

function normalizeBindingProjectScope(scope: any): ProjectBindingScope | undefined {
  return ['global', 'opencode', 'telegram', 'whatsapp', 'discord'].includes(scope) ? scope as ProjectBindingScope : undefined
}

function normalizeBindingProjectNotificationMode(mode: any): ProjectNotificationMode {
  return ['immediate', 'digest', 'muted'].includes(mode) ? mode as ProjectNotificationMode : 'immediate'
}

function normalizeBindingCompletionProposalStatus(status: any): RoadmapCompletionProposalStatus | undefined {
  return ['pending', 'approved', 'rejected', 'expired'].includes(status) ? status as RoadmapCompletionProposalStatus : undefined
}

function normalizeBindingDependencyType(type: any): WorkDependencyType {
  return ['blocks', 'blocked_by', 'parent', 'child', 'related', 'duplicate'].includes(type) ? type as WorkDependencyType : 'blocks'
}

function normalizeBindingHumanGateType(type: any): HumanGateType | undefined {
  return ['task_start', 'stage_transition', 'external_side_effect', 'budget_exception', 'destructive_action', 'credential_use', 'manual'].includes(type) ? type as HumanGateType : undefined
}

function normalizeBindingHumanGateStatus(status: any): HumanGateStatus | undefined {
  return ['pending', 'approved', 'rejected', 'timed_out', 'escalated', 'consumed'].includes(status) ? status as HumanGateStatus : undefined
}

function normalizeBindingTimeoutAction(action: any): HumanGateTimeoutAction | undefined {
  return ['remind', 'escalate', 'pause', 'block'].includes(action) ? action as HumanGateTimeoutAction : undefined
}

export function normalizeProjectBindingRecord(binding: ProjectBindingRecord): ProjectBindingRecord {
  return {
    ...binding,
    notificationMode: normalizeBindingProjectNotificationMode(binding.notificationMode),
    mutedUntil: typeof binding.mutedUntil === 'string' ? binding.mutedUntil : undefined,
    quietHours: binding.quietHours && typeof binding.quietHours === 'object' && !Array.isArray(binding.quietHours) ? binding.quietHours : {},
    lastDigestAt: typeof binding.lastDigestAt === 'string' ? binding.lastDigestAt : undefined,
  }
}

export function isRoadmapRecord(row: any): row is RoadmapRecord {
  return Boolean(row && typeof row.id === 'string' && typeof row.title === 'string' && ['active', 'done', 'blocked', 'archived'].includes(row.status))
}

export function isRoadmapSupervisorRecord(row: any): row is RoadmapSupervisorRecord {
  return Boolean(
    row &&
    typeof row.supervisorId === 'string' &&
    typeof row.roadmapId === 'string' &&
    typeof row.sessionId === 'string' &&
    typeof row.profile === 'string' &&
    ['active', 'paused', 'blocked', 'completed', 'archived'].includes(row.status) &&
    typeof row.isDefault === 'boolean' &&
    row.cadence && typeof row.cadence === 'object' && !Array.isArray(row.cadence) &&
    row.eventTriggers && typeof row.eventTriggers === 'object' && !Array.isArray(row.eventTriggers) &&
    row.completionPolicy && typeof row.completionPolicy === 'object' && !Array.isArray(row.completionPolicy) &&
    typeof row.createdAt === 'string' &&
    typeof row.updatedAt === 'string',
  )
}

function isSupervisorWakeupReceiptRecord(row: any): row is SupervisorWakeupReceiptRecord {
  return Boolean(
    row &&
    typeof row.id === 'string' &&
    typeof row.supervisorId === 'string' &&
    typeof row.roadmapId === 'string' &&
    normalizeSupervisorWakeReason(row.wakeReason) &&
    typeof row.reasonDetail === 'string' &&
    typeof row.idempotencyKey === 'string' &&
    typeof row.windowKey === 'string' &&
    Number.isInteger(row.cursorEventId) &&
    Array.isArray(row.triggerEventIds) &&
    typeof row.leaseOwner === 'string' &&
    typeof row.leaseExpiresAt === 'string' &&
    normalizeSupervisorWakeupReceiptStatus(row.status) &&
    Array.isArray(row.inspectedInputs) &&
    Array.isArray(row.changedObjectIds) &&
    typeof row.createdAt === 'string' &&
    typeof row.updatedAt === 'string',
  )
}

function isTaskDispatchReceiptRecord(row: any): row is TaskDispatchReceiptRecord {
  return Boolean(
    row &&
    typeof row.id === 'string' &&
    typeof row.taskId === 'string' &&
    typeof row.stage === 'string' &&
    typeof row.idempotencyKey === 'string' &&
    typeof row.leaseOwner === 'string' &&
    typeof row.leaseExpiresAt === 'string' &&
    normalizeTaskDispatchReceiptStatus(row.status) &&
    typeof row.createdAt === 'string' &&
    typeof row.updatedAt === 'string',
  )
}

export function isProjectBindingRecord(row: any): row is ProjectBindingRecord {
  return Boolean(
    row &&
    typeof row.id === 'string' &&
    typeof row.alias === 'string' &&
    typeof row.roadmapId === 'string' &&
    typeof row.sessionId === 'string' &&
    ['global', 'opencode', 'telegram', 'whatsapp', 'discord'].includes(row.scope) &&
    typeof row.createdAt === 'string' &&
    typeof row.updatedAt === 'string',
  )
}

export function isRoadmapCompletionProposalRecord(row: any): row is RoadmapCompletionProposalRecord {
  return Boolean(
    row &&
    typeof row.id === 'string' &&
    typeof row.roadmapId === 'string' &&
    Array.isArray(row.evidence) &&
    Array.isArray(row.unresolvedRisks) &&
    typeof row.recommendation === 'string' &&
    ['pending', 'approved', 'rejected', 'expired'].includes(row.status) &&
    typeof row.createdAt === 'string' &&
    typeof row.updatedAt === 'string',
  )
}

export function isTaskRecord(row: any): row is WorkTaskRecord {
  return Boolean(
    row &&
    typeof row.id === 'string' &&
    typeof row.roadmapId === 'string' &&
    typeof row.title === 'string' &&
    typeof row.description === 'string' &&
    ['pending', 'running', 'done', 'blocked', 'paused', 'cancelled', 'archived'].includes(row.status) &&
    ['HIGH', 'MEDIUM', 'LOW'].includes(row.priority) &&
    Array.isArray(row.pipeline),
  )
}

export function isDependencyRecord(row: any): row is WorkDependencyRecord {
  return Boolean(row && typeof row.taskId === 'string' && typeof row.dependsOnTaskId === 'string' && ['blocks', 'blocked_by', 'parent', 'child', 'related', 'duplicate'].includes(row.type) && typeof row.createdAt === 'string')
}

export function isRunRecord(row: any): row is RunRecord {
  return Boolean(
    row &&
    typeof row.id === 'string' &&
    typeof row.taskId === 'string' &&
    typeof row.stage === 'string' &&
    typeof row.sessionId === 'string' &&
    typeof row.profile === 'string' &&
    ['running', 'passed', 'failed', 'blocked', 'errored'].includes(row.status),
  )
}

export function rowToRoadmap(row: any): RoadmapRecord | null {
  const record = {
    id: String(row.id || ''),
    title: String(row.title || ''),
    status: row.status,
    priority: row.priority,
    agentTeam: row.agent_team || undefined,
    environment: row.environment_json ? normalizeEnvironmentSelector(parseJSON(row.environment_json, undefined), 'roadmap.environment') : undefined,
    qualitySpec: row.quality_spec_json ? normalizeRoadmapQualitySpec(parseJSON(row.quality_spec_json, undefined)) : undefined,
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
  }
  return isRoadmapRecord(record) ? record : null
}

export function rowToRoadmapSupervisor(row: any): RoadmapSupervisorRecord | null {
  if (!row?.supervisor_id) return null
  const status = normalizeBindingRoadmapSupervisorStatus(row.status)
  if (!status) return null
  const record: RoadmapSupervisorRecord = {
    supervisorId: String(row.supervisor_id || ''),
    roadmapId: String(row.roadmap_id || ''),
    sessionId: String(row.session_id || ''),
    profile: String(row.profile || ''),
    status,
    isDefault: Boolean(Number(row.is_default || 0)),
    cadence: parseJSON(row.cadence_json, {}),
    eventTriggers: parseJSON(row.event_triggers_json, {}),
    lastReviewedEventId: row.last_reviewed_event_id === null || row.last_reviewed_event_id === undefined ? undefined : Number(row.last_reviewed_event_id),
    lastReviewAt: row.last_review_at || undefined,
    nextReviewAt: row.next_review_at || undefined,
    completionPolicy: parseJSON(row.completion_policy_json, {}),
    notificationPolicyRef: row.notification_policy_ref || undefined,
    note: row.note || undefined,
    wakeLeaseOwner: row.wake_lease_owner || undefined,
    wakeLeaseExpiresAt: row.wake_lease_expires_at || undefined,
    lastWakeAt: row.last_wake_at || undefined,
    lastWakeReason: row.last_wake_reason || undefined,
    lastWakeEventId: row.last_wake_event_id === null || row.last_wake_event_id === undefined ? undefined : Number(row.last_wake_event_id),
    lastResultHash: row.last_result_hash || undefined,
    lastResultAt: row.last_result_at || undefined,
    lastResultStatus: row.last_result_status || undefined,
    lastResultSummary: row.last_result_summary || undefined,
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
  }
  return isRoadmapSupervisorRecord(record) ? record : null
}

export function rowToSupervisorWakeupReceipt(row: any): SupervisorWakeupReceiptRecord | null {
  if (!row?.id) return null
  const wakeReason = normalizeSupervisorWakeReason(row.wake_reason)
  const status = normalizeSupervisorWakeupReceiptStatus(row.status)
  if (!wakeReason || !status) return null
  const record: SupervisorWakeupReceiptRecord = {
    id: String(row.id || ''),
    supervisorId: String(row.supervisor_id || ''),
    roadmapId: String(row.roadmap_id || ''),
    wakeReason,
    reasonDetail: String(row.reason_detail || ''),
    idempotencyKey: String(row.idempotency_key || ''),
    windowKey: String(row.window_key || ''),
    cursorEventId: Number(row.cursor_event_id || 0),
    triggerEventIds: parseJSON(row.trigger_event_ids_json, []).filter((id: unknown) => Number.isInteger(Number(id))).map((id: unknown) => Number(id)),
    leaseOwner: String(row.lease_owner || ''),
    leaseExpiresAt: String(row.lease_expires_at || ''),
    status,
    summary: row.summary || undefined,
    inspectedInputs: normalizeStringList(parseJSON(row.inspected_inputs_json, []), 500),
    changedObjectIds: normalizeStringList(parseJSON(row.changed_object_ids_json, []), 500),
    recommendation: row.recommendation || undefined,
    nextAction: row.next_action || undefined,
    nextWakeAt: row.next_wake_at || undefined,
    createdAt: String(row.created_at || ''),
    completedAt: row.completed_at || undefined,
    updatedAt: String(row.updated_at || ''),
  }
  return isSupervisorWakeupReceiptRecord(record) ? record : null
}

export function rowToTaskDispatchReceipt(row: any): TaskDispatchReceiptRecord | null {
  if (!row?.id) return null
  const status = normalizeTaskDispatchReceiptStatus(row.status)
  if (!status) return null
  const record: TaskDispatchReceiptRecord = {
    id: String(row.id || ''),
    taskId: String(row.task_id || ''),
    stage: String(row.stage || ''),
    profile: row.profile || undefined,
    idempotencyKey: String(row.idempotency_key || ''),
    leaseOwner: String(row.lease_owner || ''),
    leaseExpiresAt: String(row.lease_expires_at || ''),
    status,
    runId: row.run_id || undefined,
    sessionId: row.session_id || undefined,
    environment: row.environment_json ? parseJSON(row.environment_json, undefined) : undefined,
    promptSubmittedAt: row.prompt_submitted_at || undefined,
    failureReason: row.failure_reason || undefined,
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
  }
  return isTaskDispatchReceiptRecord(record) ? record : null
}

export function rowToProjectBinding(row: any): ProjectBindingRecord | null {
  if (!row?.id) return null
  const scope = normalizeBindingProjectScope(row.scope)
  if (!scope) return null
  const record: ProjectBindingRecord = {
    id: String(row.id || ''),
    alias: String(row.alias || ''),
    roadmapId: String(row.roadmap_id || ''),
    sessionId: String(row.session_id || ''),
    scope,
    provider: row.provider || undefined,
    chatId: row.chat_id || undefined,
    threadId: normalizeThreadId(row.thread_id) || undefined,
    title: row.title || undefined,
    notificationMode: normalizeBindingProjectNotificationMode(row.notification_mode),
    mutedUntil: row.muted_until || undefined,
    quietHours: parseJSON(row.quiet_hours_json, {}),
    lastDigestAt: row.last_digest_at || undefined,
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
  }
  return isProjectBindingRecord(record) ? record : null
}

export function rowToRoadmapCompletionProposal(row: any): RoadmapCompletionProposalRecord | null {
  if (!row?.id) return null
  const status = normalizeBindingCompletionProposalStatus(row.status)
  if (!status) return null
  const record: RoadmapCompletionProposalRecord = {
    id: String(row.id || ''),
    roadmapId: String(row.roadmap_id || ''),
    proposedBy: row.proposed_by || undefined,
    sessionId: row.session_id || undefined,
    evidence: normalizeStringList(parseJSON(row.evidence_json, []), 2000),
    unresolvedRisks: normalizeStringList(parseJSON(row.unresolved_risks_json, []), 2000),
    recommendation: String(row.recommendation || ''),
    status,
    decisionBy: row.decision_by || undefined,
    decisionNote: row.decision_note || undefined,
    expiresAt: row.expires_at || undefined,
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
  }
  return isRoadmapCompletionProposalRecord(record) ? record : null
}

export function rowToTask(row: any): WorkTaskRecord | null {
  const record = {
    id: String(row.id || ''),
    roadmapId: String(row.roadmap_id || ''),
    title: String(row.title || ''),
    description: String(row.description || ''),
    status: row.status,
    priority: row.priority,
    agent: String(row.agent || ''),
    agentTeam: row.agent_team || undefined,
    stageProfiles: row.stage_profiles_json ? parseJSON(row.stage_profiles_json, undefined) : undefined,
    environment: row.environment_json ? normalizeEnvironmentSelector(parseJSON(row.environment_json, undefined), 'task.environment') : undefined,
    pipeline: parseJSON(row.pipeline_json, []),
    currentStage: row.current_stage || undefined,
    currentRunId: row.current_run_id || undefined,
    attempts: parseJSON(row.attempts_json, {}),
    note: row.note || undefined,
    earliestStartAt: row.earliest_start_at || undefined,
    deadlineAt: row.deadline_at || undefined,
    recurrence: row.recurrence || undefined,
    manualGate: row.manual_gate || undefined,
    slaClass: row.sla_class || undefined,
    qualitySpec: row.quality_spec_json ? normalizeTaskQualitySpec(parseJSON(row.quality_spec_json, undefined)) : undefined,
    sourceType: row.source_type ? String(row.source_type) : undefined,
    sourceKey: row.source_key ? String(row.source_key) : undefined,
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
  }
  return isTaskRecord(record) ? record : null
}

export function rowToDependency(row: any): WorkDependencyRecord | null {
  const record = {
    taskId: String(row.task_id || ''),
    dependsOnTaskId: String(row.depends_on_task_id || ''),
    type: normalizeBindingDependencyType(row.type),
    createdAt: String(row.created_at || ''),
  }
  return isDependencyRecord(record) ? record : null
}

export function rowToRun(row: any): RunRecord | null {
  const record = {
    id: String(row.id || ''),
    taskId: String(row.task_id || ''),
    stage: String(row.stage || ''),
    sessionId: String(row.session_id || ''),
    profile: String(row.profile || ''),
    agentTeam: row.agent_team || undefined,
    agentTeamVersion: row.agent_team_version || undefined,
    resolvedProfile: row.resolved_profile || undefined,
    resolvedAgent: row.resolved_agent || undefined,
    environment: row.environment_json ? parseJSON(row.environment_json, undefined) : undefined,
    runtimeProfile: row.runtime_profile_json ? parseJSON(row.runtime_profile_json, undefined) : undefined,
    status: row.status,
    attempt: Number(row.attempt || 0),
    startedAt: String(row.started_at || ''),
    completedAt: row.completed_at || undefined,
    leaseOwner: row.lease_owner || undefined,
    leaseExpiresAt: row.lease_expires_at || undefined,
    schedulerGeneration: row.scheduler_generation || undefined,
    costUsd: row.cost_usd === null || row.cost_usd === undefined ? undefined : Number(row.cost_usd),
    inputTokens: row.input_tokens === null || row.input_tokens === undefined ? undefined : Number(row.input_tokens),
    outputTokens: row.output_tokens === null || row.output_tokens === undefined ? undefined : Number(row.output_tokens),
    reasoningTokens: row.reasoning_tokens === null || row.reasoning_tokens === undefined ? undefined : Number(row.reasoning_tokens),
    cacheReadTokens: row.cache_read_tokens === null || row.cache_read_tokens === undefined ? undefined : Number(row.cache_read_tokens),
    cacheWriteTokens: row.cache_write_tokens === null || row.cache_write_tokens === undefined ? undefined : Number(row.cache_write_tokens),
    runtimeMs: row.runtime_ms === null || row.runtime_ms === undefined ? undefined : Number(row.runtime_ms),
    result: row.result_json ? parseJSON(row.result_json, undefined) : undefined,
  }
  return isRunRecord(record) ? record : null
}

export function rowToEvent(row: any): WorkEventRecord {
  return {
    id: Number(row.id || 0),
    type: String(row.type || ''),
    subjectId: row.subject_id || undefined,
    payload: parseJSON(row.payload_json, {}),
    createdAt: String(row.created_at || ''),
    processedAt: row.processed_at || undefined,
  }
}

export function rowToAuditLedger(row: any): AuditLedgerRecord {
  return {
    id: Number(row.id || 0),
    schemaVersion: Number(row.schema_version || 1) as AuditLedgerRecord['schemaVersion'],
    eventId: String(row.event_id || ''),
    sourceEventId: row.source_event_id === null || row.source_event_id === undefined ? undefined : Number(row.source_event_id),
    sourceEventType: row.source_event_type || undefined,
    class: row.class,
    actorKind: row.actor_kind,
    actorRef: String(row.actor_ref || ''),
    resourceKind: row.resource_kind,
    resourceRef: String(row.resource_ref || ''),
    action: String(row.action || ''),
    result: row.result,
    occurredAt: String(row.occurred_at || ''),
    traceId: String(row.trace_id || ''),
    correlationId: row.correlation_id || undefined,
    retentionClass: row.retention_class,
    evidenceRefs: parseJSON<string[]>(row.evidence_refs_json, []),
    redactedPayload: parseJSON<Record<string, unknown>>(row.redacted_payload_json, {}),
    previousHash: row.previous_hash || undefined,
    entryHash: String(row.entry_hash || ''),
  }
}

export function rowToHumanGate(row: any): HumanGateRecord | null {
  if (!row?.id) return null
  const type = normalizeBindingHumanGateType(row.type)
  const status = normalizeBindingHumanGateStatus(row.status)
  const timeoutAction = normalizeBindingTimeoutAction(row.timeout_action)
  if (!type || !status || !timeoutAction) return null
  return {
    id: String(row.id),
    type,
    status,
    roadmapId: row.roadmap_id || undefined,
    taskId: row.task_id || undefined,
    runId: row.run_id || undefined,
    stage: row.stage || undefined,
    reason: String(row.reason || ''),
    requestedBy: String(row.requested_by || 'gateway'),
    requestedAt: String(row.requested_at || ''),
    updatedAt: String(row.updated_at || ''),
    expiresAt: row.expires_at || undefined,
    timeoutAction,
    escalatedAt: row.escalated_at || undefined,
    decidedBy: row.decided_by || undefined,
    decisionNote: row.decision_note || undefined,
    scope: row.scope === 'always' ? 'always' : row.scope === 'once' ? 'once' : undefined,
    scopeKey: row.scope_key || undefined,
    details: parseJSON(row.details_json, {}),
  }
}

export function rowToAlert(row: any): AlertRecord | null {
  if (!row?.id) return null
  const status = normalizeAlertStatus(row.status)
  const severity = ['info', 'warning', 'critical'].includes(row.severity) ? row.severity as AlertSeverity : undefined
  if (!status || !severity) return null
  return {
    id: String(row.id),
    key: String(row.key || ''),
    status,
    severity,
    source: String(row.source || ''),
    target: row.target || undefined,
    summary: String(row.summary || ''),
    evidence: parseJSON(row.evidence_json, []),
    nextAction: String(row.next_action || ''),
    firstSeenAt: String(row.first_seen_at || ''),
    lastSeenAt: String(row.last_seen_at || ''),
    lastNotifiedAt: row.last_notified_at || undefined,
    resolvedAt: row.resolved_at || undefined,
    acknowledgedAt: row.acknowledged_at || undefined,
    suppressedUntil: row.suppressed_until || undefined,
    dedupeCount: Number(row.dedupe_count || 0),
    details: parseJSON(row.details_json, {}),
  }
}

export function rowToChannelBinding(row: any): ChannelBindingRecord | null {
  const mode = normalizeBindingMode(row.mode)
  if (!row?.provider || !row?.chat_id || !row?.session_id) return null
  return {
    provider: String(row.provider),
    chatId: String(row.chat_id),
    threadId: normalizeThreadId(row.thread_id) || undefined,
    sessionId: String(row.session_id),
    mode,
    roadmapId: row.roadmap_id || undefined,
    taskId: row.task_id || undefined,
    title: row.title || undefined,
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
  }
}

export function rowToChannelClaimCode(row: any): ChannelClaimCodeRecord | null {
  if (!row?.id || !row?.provider || !row?.code_hash) return null
  const action = (row.action === 'trust_target' || row.action === 'prove_denial') ? row.action as ChannelClaimAction : undefined
  const status = ['pending', 'accepted', 'expired', 'denied'].includes(row.status) ? row.status as ChannelClaimStatus : undefined
  if (!action || !status) return null
  return {
    id: String(row.id),
    provider: String(row.provider),
    action,
    codeHash: String(row.code_hash),
    codeFingerprint: String(row.code_fingerprint || ''),
    status,
    createdBy: String(row.created_by || 'operator'),
    createdAt: String(row.created_at || ''),
    expiresAt: String(row.expires_at || ''),
    acceptedAt: row.accepted_at || undefined,
    acceptedTargetHash: row.accepted_target_hash || undefined,
    deniedAt: row.denied_at || undefined,
    denialReason: row.denial_reason || undefined,
  }
}

export function rowToDelegationReceipt(row: any): DelegatedWorkReceipt | undefined {
  if (!row?.idempotency_key) return undefined
  return {
    idempotencyKey: String(row.idempotency_key),
    idempotencyStatus: 'created',
    targetType: String(row.target_type || ''),
    taskIds: parseJSON<unknown[]>(row.task_ids_json, []).filter((id: unknown) => typeof id === 'string') as string[],
    roadmapId: row.roadmap_id || undefined,
    supervisorId: row.supervisor_id || undefined,
    projectBindingId: row.project_binding_id || undefined,
    parentSessionId: row.parent_session_id || undefined,
    links: parseJSON<Record<string, string>>(row.links_json, {}),
    nextSchedulerAction: String(row.next_scheduler_action || 'inspect_existing_delegation'),
  }
}
