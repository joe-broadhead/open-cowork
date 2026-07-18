import { createHash } from 'node:crypto'
import { isActiveRunStatus, isTaskActiveStatus } from './runtime-state-machine.js'
import { redactSensitiveText } from './security.js'
import type {
  ChannelBindingRecord,
  DelegationProgressRouteReceiptRecord,
  ProjectBindingRecord,
  RunRecord,
  TaskDispatchReceiptRecord,
  WorkEventRecord,
  WorkState,
  WorkTaskRecord,
} from './work-store.js'

export type RuntimeReplayConsistencyStatus = 'pass' | 'warn' | 'fail'
export type RuntimeReplayConsistencySeverity = 'info' | 'warning' | 'critical'
export type RuntimeReplayRepairMode = 'none' | 'automatic' | 'operator_confirmed' | 'blocked'
export type RuntimeReplaySurfaceRebuildability = 'rebuildable' | 'best_effort' | 'operator_intervention_required'

export type RuntimeReplaySurface =
  | 'events'
  | 'tasks'
  | 'runs'
  | 'worker_leases'
  | 'task_dispatch_receipts'
  | 'delegation_receipts'
  | 'delegation_progress'
  | 'progress_route_receipts'
  | 'channel_bindings'
  | 'project_bindings'
  | 'session_links'
  | 'dashboard_summary'
  | 'evidence_export'

export interface RuntimeReplayConsistencyFinding {
  code: string
  owner: string
  surface: RuntimeReplaySurface
  entityKind: string
  entityId: string
  severity: RuntimeReplayConsistencySeverity
  summary: string
  safeRepairAction: string
  repairMode: RuntimeReplayRepairMode
  automaticRepair: boolean
  redacted: true
  evidenceRefs: string[]
}

export interface RuntimeReplaySurfaceSummary {
  surface: RuntimeReplaySurface
  owner: string
  status: RuntimeReplayConsistencyStatus
  records: number
  rebuildability: RuntimeReplaySurfaceRebuildability
  evidenceRefs: string[]
  safeRepairAction: string
}

export interface RuntimeReplayConsistencyReport {
  schemaVersion: 1
  mode: 'm59_runtime_replay_consistency_harness'
  generatedAt: string
  status: RuntimeReplayConsistencyStatus
  releaseClaimBoundary: 'local_beta_replay_consistency_only_no_release_claim_expansion'
  determinismKey: string
  counts: {
    roadmaps: number
    tasks: number
    runs: number
    events: number
    taskDispatchReceipts: number
    delegationReceipts: number
    delegationProgressEvents: number
    routeReceipts: number
    channelBindings: number
    projectBindings: number
    activeSessionLinks: number
    findings: number
    criticalFindings: number
    warningFindings: number
  }
  surfaces: RuntimeReplaySurfaceSummary[]
  findings: RuntimeReplayConsistencyFinding[]
  acceptance: {
    deterministicOrdering: 'events_by_id_then_entities_by_created_at'
    scannerOutputOwnerMapped: boolean
    scannerOutputRedacted: boolean
    replayCoversRuntimeSurfaces: boolean
    duplicateMissingStaleOrphanedFailClosed: boolean
    unsafeRepairsRequireOperatorConfirmation: boolean
    evidenceReferencesPresent: boolean
    noReleaseClaimExpansion: true
  }
  safeNextAction: string
}

export interface RuntimeReplayConsistencyInput {
  state: WorkState
  events: WorkEventRecord[]
  routeReceipts?: DelegationProgressRouteReceiptRecord[]
  channelBindings?: ChannelBindingRecord[]
  projectBindings?: ProjectBindingRecord[]
  taskDispatchReceipts?: TaskDispatchReceiptRecord[]
  dashboardSummary?: RuntimeReplayDashboardSummary
  evidenceManifest?: RuntimeReplayEvidenceManifest
  activeSessionIds?: ReadonlySet<string>
  generatedAt?: string | Date
  now?: number
  recentEventWindowMs?: number
  staleRouteReceiptMs?: number
}

export interface RuntimeReplayDashboardSummary {
  status?: string
  taskCounts?: string
  gatewaySessions?: string
  activeIssues?: Array<{ id?: string; status?: string; currentStage?: string }>
  initiatives?: Array<{ id?: string; status?: string }>
}

export interface RuntimeReplayEvidenceManifest {
  counts?: Partial<Record<'tasks' | 'runs' | 'events' | 'channelBindings' | 'projectBindings' | 'artifacts', number>>
  evidenceContract?: { claimState?: string; validation?: { state?: string }; redaction?: { safeToShare?: boolean } }
  contractState?: { safeToShare?: boolean; validationState?: string; claimState?: string }
  pipeline?: { status?: string; releaseClaimBoundary?: string }
  correlation?: { traceRootId?: string }
}

interface FindingInput {
  code: string
  surface: RuntimeReplaySurface
  entityKind: string
  entityId?: string
  severity: RuntimeReplayConsistencySeverity
  summary: string
  safeRepairAction: string
  repairMode: RuntimeReplayRepairMode
  evidenceRefs?: string[]
}

const DEFAULT_RECENT_EVENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
const DEFAULT_STALE_ROUTE_RECEIPT_MS = 15 * 60 * 1000

const SURFACE_OWNERS: Record<RuntimeReplaySurface, string> = {
  events: 'work-store/event-log',
  tasks: 'work-store/task-port',
  runs: 'work-store/run-lease-port',
  worker_leases: 'work-store/run-lease-port',
  task_dispatch_receipts: 'scheduler',
  delegation_receipts: 'delegation-progress',
  delegation_progress: 'delegation-progress',
  progress_route_receipts: 'delegation-progress',
  channel_bindings: 'channel-sync',
  project_bindings: 'project-routing',
  session_links: 'opencode-session-link',
  dashboard_summary: 'mission-control',
  evidence_export: 'evidence-export',
}

const SURFACE_REBUILDABILITY: Record<RuntimeReplaySurface, RuntimeReplaySurfaceRebuildability> = {
  events: 'rebuildable',
  tasks: 'rebuildable',
  runs: 'rebuildable',
  worker_leases: 'operator_intervention_required',
  task_dispatch_receipts: 'best_effort',
  delegation_receipts: 'rebuildable',
  delegation_progress: 'rebuildable',
  progress_route_receipts: 'best_effort',
  channel_bindings: 'best_effort',
  project_bindings: 'rebuildable',
  session_links: 'operator_intervention_required',
  dashboard_summary: 'rebuildable',
  evidence_export: 'best_effort',
}

const SURFACE_REPAIR_ACTION: Record<RuntimeReplaySurface, string> = {
  events: 'Inspect durable event/audit evidence before editing the event log.',
  tasks: 'Rebuild the task read model from durable task rows and recent task events; require operator confirmation for destructive repair.',
  runs: 'Use run lease recovery ports before accepting new run completions.',
  worker_leases: 'Recover expired or orphaned work runs with explicit operator-visible recovery commands.',
  task_dispatch_receipts: 'Run dispatch-start recovery for expired starting receipts before redispatch.',
  delegation_receipts: 'Reconcile delegation receipts from delegation.accepted and delegation.mapped events before sending progress.',
  delegation_progress: 'Dedupe by progress key and require operator confirmation before synthesizing missing terminal progress.',
  progress_route_receipts: 'Repair delivery targets or rerun delegated progress delivery after resolving the recorded route reason.',
  channel_bindings: 'Rebind trusted channel targets before claiming channel delivery.',
  project_bindings: 'Recreate or repair the project binding from the trusted project alias and roadmap.',
  session_links: 'Reconnect the OpenCode session or recover the run before claiming active ownership.',
  dashboard_summary: 'Regenerate Mission Control from durable work state and source contracts.',
  evidence_export: 'Regenerate a redacted evidence bundle inside the local-beta evidence boundary.',
}

const RUNTIME_SURFACES: RuntimeReplaySurface[] = [
  'events',
  'tasks',
  'runs',
  'worker_leases',
  'task_dispatch_receipts',
  'delegation_receipts',
  'delegation_progress',
  'progress_route_receipts',
  'channel_bindings',
  'project_bindings',
  'session_links',
  'dashboard_summary',
  'evidence_export',
]

export function buildRuntimeReplayConsistencyReport(input: RuntimeReplayConsistencyInput): RuntimeReplayConsistencyReport {
  const generatedAt = normalizeGeneratedAt(input.generatedAt, input.now)
  const nowMs = input.now ?? Date.parse(generatedAt)
  const recentEventWindowMs = input.recentEventWindowMs ?? DEFAULT_RECENT_EVENT_WINDOW_MS
  const staleRouteReceiptMs = input.staleRouteReceiptMs ?? DEFAULT_STALE_ROUTE_RECEIPT_MS
  const state = input.state
  const events = [...input.events].sort((a, b) => a.id - b.id)
  const routeReceipts = [...(input.routeReceipts || [])].sort((a, b) => compareStrings(a.updatedAt, b.updatedAt) || compareStrings(a.dedupeKey, b.dedupeKey))
  const channelBindings = [...(input.channelBindings || [])].sort((a, b) => compareStrings(a.provider, b.provider) || compareStrings(a.chatId, b.chatId) || compareStrings(a.threadId || '', b.threadId || ''))
  const projectBindings = [...(input.projectBindings || state.projectBindings || [])].sort((a, b) => compareStrings(a.alias, b.alias) || compareStrings(a.id, b.id))
  const taskDispatchReceipts = [...(input.taskDispatchReceipts || [])].sort((a, b) => compareStrings(a.createdAt, b.createdAt) || compareStrings(a.id, b.id))
  const findings: RuntimeReplayConsistencyFinding[] = []
  const addFinding = (finding: FindingInput) => findings.push(normalizeFinding(finding))

  const tasksById = new Map(state.tasks.map(task => [task.id, task]))
  const runsById = new Map(state.runs.map(run => [run.id, run]))
  const activeRunsByTask = indexActiveRunsByTask(state.runs)
  const roadmapsById = new Map(state.roadmaps.map(roadmap => [roadmap.id, roadmap]))
  const eventsBySubjectType = indexEventsBySubjectType(events)
  const delegationAcceptedEvents = events.filter(event => event.type === 'delegation.accepted')
  const delegationMappedEvents = events.filter(event => event.type === 'delegation.mapped')
  const delegationProgressEvents = events.filter(event => event.type === 'delegation.progress')
  const delegationReceipts = delegationMappedEvents.map(event => event.payload).filter(payload => stringValue(payload['idempotencyKey']))
  const progressEventsByKey = new Map<string, WorkEventRecord[]>()
  const progressEventsByIdempotencyKey = new Map<string, WorkEventRecord[]>()
  const routeReceiptsByProgressKey = new Map<string, DelegationProgressRouteReceiptRecord[]>()

  for (const event of delegationProgressEvents) {
    const key = progressEventKey(event)
    if (key) pushMap(progressEventsByKey, key, event)
    const idempotencyKey = stringValue(event.payload['idempotencyKey']) || stringValue(event.subjectId)
    if (idempotencyKey) pushMap(progressEventsByIdempotencyKey, idempotencyKey, event)
  }
  for (const receipt of routeReceipts) {
    if (receipt.progressKey) pushMap(routeReceiptsByProgressKey, receipt.progressKey, receipt)
  }

  scanTasks({ state, tasksById, eventsBySubjectType, nowMs, recentEventWindowMs, addFinding })
  scanRuns({ state, tasksById, runsById, activeRunsByTask, events, nowMs, activeSessionIds: input.activeSessionIds, addFinding })
  scanTaskDispatchReceipts({ taskDispatchReceipts, tasksById, runsById, activeRunsByTask, nowMs, addFinding })
  scanDelegationReceipts({ delegationAcceptedEvents, delegationMappedEvents, delegationProgressEvents, progressEventsByIdempotencyKey, tasksById, roadmapsById, addFinding })
  scanDelegationProgress({ progressEventsByKey, routeReceiptsByProgressKey, addFinding })
  scanProgressRouteReceipts({ routeReceipts, nowMs, staleRouteReceiptMs, addFinding })
  scanSessionLinkEvidence({ state, channelBindings, projectBindings, activeSessionIds: input.activeSessionIds, addFinding })
  scanBindings({ channelBindings, projectBindings, tasksById, roadmapsById, activeSessionIds: input.activeSessionIds, addFinding })
  scanDashboardSummary({ dashboardSummary: input.dashboardSummary, state, addFinding })
  scanEvidenceManifest({ evidenceManifest: input.evidenceManifest, addFinding })

  findings.sort(compareFindings)

  const surfaces = buildSurfaceSummaries({
    state,
    events,
    taskDispatchReceipts,
    delegationReceipts: delegationReceipts.length,
    delegationProgressEvents: delegationProgressEvents.length,
    routeReceipts,
    channelBindings,
    projectBindings,
    activeSessionIds: input.activeSessionIds,
    dashboardSummary: input.dashboardSummary,
    evidenceManifest: input.evidenceManifest,
    findings,
  })
  const criticalFindings = findings.filter(finding => finding.severity === 'critical').length
  const warningFindings = findings.filter(finding => finding.severity === 'warning').length
  const status: RuntimeReplayConsistencyStatus = criticalFindings ? 'fail' : warningFindings ? 'warn' : 'pass'
  const reportWithoutKey: Omit<RuntimeReplayConsistencyReport, 'determinismKey'> = {
    schemaVersion: 1,
    mode: 'm59_runtime_replay_consistency_harness',
    generatedAt,
    status,
    releaseClaimBoundary: 'local_beta_replay_consistency_only_no_release_claim_expansion',
    counts: {
      roadmaps: state.roadmaps.length,
      tasks: state.tasks.length,
      runs: state.runs.length,
      events: events.length,
      taskDispatchReceipts: taskDispatchReceipts.length,
      delegationReceipts: delegationReceipts.length,
      delegationProgressEvents: delegationProgressEvents.length,
      routeReceipts: routeReceipts.length,
      channelBindings: channelBindings.length,
      projectBindings: projectBindings.length,
      activeSessionLinks: input.activeSessionIds?.size ?? 0,
      findings: findings.length,
      criticalFindings,
      warningFindings,
    },
    surfaces,
    findings,
    acceptance: {
      deterministicOrdering: 'events_by_id_then_entities_by_created_at',
      scannerOutputOwnerMapped: findings.every(finding => Boolean(finding.owner && finding.surface && finding.entityKind && finding.safeRepairAction)),
      scannerOutputRedacted: findings.every(finding => finding.redacted === true),
      replayCoversRuntimeSurfaces: RUNTIME_SURFACES.every(surface => surfaces.some(row => row.surface === surface)),
      duplicateMissingStaleOrphanedFailClosed: findings
        .filter(finding => /duplicate|missing|stale|orphaned|lease_expired|delayed/.test(finding.code))
        .every(finding => finding.severity !== 'info' && finding.repairMode !== 'none'),
      unsafeRepairsRequireOperatorConfirmation: findings
        .filter(finding => finding.severity === 'critical' || finding.repairMode === 'blocked')
        .every(finding => finding.repairMode === 'operator_confirmed' || finding.repairMode === 'blocked'),
      evidenceReferencesPresent: findings.every(finding => finding.evidenceRefs.length > 0),
      noReleaseClaimExpansion: true as const,
    },
    safeNextAction: status === 'pass'
      ? 'Record this replay consistency report as local-beta evidence; no repair is required.'
      : status === 'warn'
        ? 'Address warning diagnostics, rerun the harness, and keep repairs inside the local operator boundary.'
        : 'Stop runtime promotion, repair critical diagnostics with operator-confirmed actions, then rerun the harness.',
  }

  return {
    ...reportWithoutKey,
    determinismKey: hashText(stableStringify({
      ...reportWithoutKey,
      generatedAt: '<generatedAt>',
    })).slice(0, 16),
  }
}

function scanTasks(input: {
  state: WorkState
  tasksById: Map<string, WorkTaskRecord>
  eventsBySubjectType: Map<string, WorkEventRecord[]>
  nowMs: number
  recentEventWindowMs: number
  addFinding: (finding: FindingInput) => void
}): void {
  for (const task of input.state.tasks) {
    if (isRecent(task.createdAt, input.nowMs, input.recentEventWindowMs) && !input.eventsBySubjectType.get(eventSubjectTypeKey('task.created', task.id))?.length) {
      input.addFinding({
        code: 'runtime.task.missing_recent_created_event',
        surface: 'tasks',
        entityKind: 'task',
        entityId: task.id,
        severity: 'warning',
        summary: `Recent task ${safeInlineId(task.id)} has no task.created event in the replay window.`,
        safeRepairAction: 'Compare the task row to backup/audit evidence before synthesizing or accepting a replacement task.created event.',
        repairMode: 'operator_confirmed',
        evidenceRefs: [`task:${safeInlineId(task.id)}`, 'events:task.created'],
      })
    }
    if (isTaskActiveStatus(task.status) && !task.currentRunId) {
      input.addFinding({
        code: 'runtime.task.running_without_current_run',
        surface: 'tasks',
        entityKind: 'task',
        entityId: task.id,
        severity: 'critical',
        summary: `Running task ${safeInlineId(task.id)} has no current run owner.`,
        safeRepairAction: 'Recover the task through the run-lease recovery path before dispatching or completing more work.',
        repairMode: 'operator_confirmed',
        evidenceRefs: [`task:${safeInlineId(task.id)}`],
      })
    }
  }
}

function scanRuns(input: {
  state: WorkState
  tasksById: Map<string, WorkTaskRecord>
  runsById: Map<string, RunRecord>
  activeRunsByTask: Map<string, RunRecord[]>
  events: WorkEventRecord[]
  nowMs: number
  activeSessionIds?: ReadonlySet<string>
  addFinding: (finding: FindingInput) => void
}): void {
  for (const run of input.state.runs) {
    const task = input.tasksById.get(run.taskId)
    if (!task) {
      input.addFinding({
        code: 'runtime.run.orphaned_task',
        surface: 'runs',
        entityKind: 'run',
        entityId: run.id,
        severity: 'critical',
        summary: `Run ${safeInlineId(run.id)} references a missing task.`,
        safeRepairAction: 'Block the run from accepting completion and reconcile from backup before deleting or reparenting it.',
        repairMode: 'blocked',
        evidenceRefs: [`run:${safeInlineId(run.id)}`, `task:${safeInlineId(run.taskId)}`],
      })
    }
    if (isActiveRunStatus(run.status)) {
      if (!run.leaseOwner || !isFutureIso(run.leaseExpiresAt, input.nowMs)) {
        input.addFinding({
          code: 'runtime.run.lease_expired',
          surface: 'worker_leases',
          entityKind: 'run',
          entityId: run.id,
          severity: 'critical',
          summary: `Active run ${safeInlineId(run.id)} has a missing, malformed, or expired lease.`,
          safeRepairAction: 'Run recoverExpiredWorkLeases before accepting a result, renewal, or redispatch for this task.',
          repairMode: 'operator_confirmed',
          evidenceRefs: [`run:${safeInlineId(run.id)}`, `task:${safeInlineId(run.taskId)}`],
        })
      }
      if (input.activeSessionIds && run.sessionId && !input.activeSessionIds.has(run.sessionId)) {
        input.addFinding({
          code: 'runtime.run.orphaned_session',
          surface: 'session_links',
          entityKind: 'session',
          entityId: sensitiveRef('session', run.sessionId),
          severity: 'critical',
          summary: `Active run ${safeInlineId(run.id)} points at a session that is not currently linked.`,
          safeRepairAction: 'Run recoverOrphanedWorkRuns or reconnect the OpenCode session before claiming active ownership.',
          repairMode: 'operator_confirmed',
          evidenceRefs: [`run:${safeInlineId(run.id)}`, sensitiveRef('session', run.sessionId)],
        })
      }
      const startedEvent = input.events.find(event => event.type === 'task.run.started' && stringValue(event.payload['runId']) === run.id)
      if (!startedEvent) {
        input.addFinding({
          code: 'runtime.run.missing_started_event',
          surface: 'runs',
          entityKind: 'run',
          entityId: run.id,
          severity: 'warning',
          summary: `Active run ${safeInlineId(run.id)} has no task.run.started event in the replay window.`,
          safeRepairAction: 'Treat the run as best-effort until backup/audit evidence confirms the start event lineage.',
          repairMode: 'operator_confirmed',
          evidenceRefs: [`run:${safeInlineId(run.id)}`, 'events:task.run.started'],
        })
      }
    }
  }
  for (const task of input.state.tasks) {
    if (!task.currentRunId) continue
    const run = input.runsById.get(task.currentRunId)
    if (!run) {
      input.addFinding({
        code: 'runtime.task.current_run_missing',
        surface: 'runs',
        entityKind: 'task',
        entityId: task.id,
        severity: 'critical',
        summary: `Task ${safeInlineId(task.id)} points at missing current run ${safeInlineId(task.currentRunId)}.`,
        safeRepairAction: 'Clear or repair currentRunId only through operator-confirmed run recovery.',
        repairMode: 'operator_confirmed',
        evidenceRefs: [`task:${safeInlineId(task.id)}`, `run:${safeInlineId(task.currentRunId)}`],
      })
    } else if (run.taskId !== task.id || !isActiveRunStatus(run.status)) {
      input.addFinding({
        code: 'runtime.task.current_run_inconsistent',
        surface: 'runs',
        entityKind: 'task',
        entityId: task.id,
        severity: 'critical',
        summary: `Task ${safeInlineId(task.id)} current run does not own the active task state.`,
        safeRepairAction: 'Block completion and reconcile the task/run pair through the run recovery path.',
        repairMode: 'operator_confirmed',
        evidenceRefs: [`task:${safeInlineId(task.id)}`, `run:${safeInlineId(task.currentRunId)}`],
      })
    }
  }
  for (const [taskId, runs] of input.activeRunsByTask) {
    if (runs.length <= 1) continue
    input.addFinding({
      code: 'runtime.run.duplicate_active_runs',
      surface: 'runs',
      entityKind: 'task',
      entityId: taskId,
      severity: 'critical',
      summary: `Task ${safeInlineId(taskId)} has ${runs.length} active runs.`,
      safeRepairAction: 'Stop result acceptance and recover all but the operator-confirmed active run owner.',
      repairMode: 'operator_confirmed',
      evidenceRefs: [`task:${safeInlineId(taskId)}`, ...runs.map(run => `run:${safeInlineId(run.id)}`)],
    })
  }
}

function scanTaskDispatchReceipts(input: {
  taskDispatchReceipts: TaskDispatchReceiptRecord[]
  tasksById: Map<string, WorkTaskRecord>
  runsById: Map<string, RunRecord>
  activeRunsByTask: Map<string, RunRecord[]>
  nowMs: number
  addFinding: (finding: FindingInput) => void
}): void {
  const activeStartingByTask = new Map<string, TaskDispatchReceiptRecord[]>()
  for (const receipt of input.taskDispatchReceipts) {
    if (!input.tasksById.has(receipt.taskId)) {
      input.addFinding({
        code: 'runtime.dispatch.missing_task',
        surface: 'task_dispatch_receipts',
        entityKind: 'dispatch',
        entityId: receipt.id,
        severity: 'critical',
        summary: `Dispatch receipt ${safeInlineId(receipt.id)} references a missing task.`,
        safeRepairAction: 'Mark the dispatch failed only after operator confirms the task is not recoverable from backup.',
        repairMode: 'operator_confirmed',
        evidenceRefs: [`dispatch:${safeInlineId(receipt.id)}`, `task:${safeInlineId(receipt.taskId)}`],
      })
    }
    if (receipt.status === 'starting') {
      if (!isFutureIso(receipt.leaseExpiresAt, input.nowMs)) {
        input.addFinding({
          code: 'runtime.dispatch.starting_lease_expired',
          surface: 'task_dispatch_receipts',
          entityKind: 'dispatch',
          entityId: receipt.id,
          severity: 'warning',
          summary: `Dispatch receipt ${safeInlineId(receipt.id)} has a missing, malformed, or expired lease before a run started.`,
          safeRepairAction: 'Run recoverExpiredTaskDispatchStarts before attempting a new dispatch.',
          repairMode: 'automatic',
          evidenceRefs: [`dispatch:${safeInlineId(receipt.id)}`, `task:${safeInlineId(receipt.taskId)}`],
        })
      } else {
        pushMap(activeStartingByTask, receipt.taskId, receipt)
      }
    }
    if (receipt.status === 'started' && receipt.runId && !input.runsById.has(receipt.runId)) {
      input.addFinding({
        code: 'runtime.dispatch.started_run_missing',
        surface: 'task_dispatch_receipts',
        entityKind: 'dispatch',
        entityId: receipt.id,
        severity: 'critical',
        summary: `Started dispatch ${safeInlineId(receipt.id)} references a missing run.`,
        safeRepairAction: 'Block completion for this dispatch and reconcile the run row from durable evidence.',
        repairMode: 'operator_confirmed',
        evidenceRefs: [`dispatch:${safeInlineId(receipt.id)}`, `run:${safeInlineId(receipt.runId)}`],
      })
    }
  }
  for (const [taskId, receipts] of activeStartingByTask) {
    if (receipts.length <= 1) continue
    input.addFinding({
      code: 'runtime.dispatch.duplicate_starting_receipts',
      surface: 'task_dispatch_receipts',
      entityKind: 'task',
      entityId: taskId,
      severity: 'critical',
      summary: `Task ${safeInlineId(taskId)} has ${receipts.length} unexpired starting dispatch receipts.`,
      safeRepairAction: 'Stop dispatch for this task and expire duplicate starts through operator-confirmed scheduler recovery.',
      repairMode: 'operator_confirmed',
      evidenceRefs: [`task:${safeInlineId(taskId)}`, ...receipts.map(receipt => `dispatch:${safeInlineId(receipt.id)}`)],
    })
  }
  for (const [taskId, receipts] of activeStartingByTask) {
    const activeRuns = input.activeRunsByTask.get(taskId) || []
    if (!activeRuns.length || !receipts.length) continue
    input.addFinding({
      code: 'runtime.dispatch.mixed_active_ownership',
      surface: 'task_dispatch_receipts',
      entityKind: 'task',
      entityId: taskId,
      severity: 'critical',
      summary: `Task ${safeInlineId(taskId)} has an active run and an unexpired starting dispatch receipt.`,
      safeRepairAction: 'Stop dispatch and result acceptance until operator-confirmed recovery selects one active owner.',
      repairMode: 'operator_confirmed',
      evidenceRefs: [
        `task:${safeInlineId(taskId)}`,
        ...activeRuns.map(run => `run:${safeInlineId(run.id)}`),
        ...receipts.map(receipt => `dispatch:${safeInlineId(receipt.id)}`),
      ],
    })
  }
}

function scanDelegationReceipts(input: {
  delegationAcceptedEvents: WorkEventRecord[]
  delegationMappedEvents: WorkEventRecord[]
  delegationProgressEvents: WorkEventRecord[]
  progressEventsByIdempotencyKey: Map<string, WorkEventRecord[]>
  tasksById: Map<string, WorkTaskRecord>
  roadmapsById: Map<string, unknown>
  addFinding: (finding: FindingInput) => void
}): void {
  const acceptedEventByKey = new Map<string, WorkEventRecord>()
  const mappedEventByKey = new Map<string, WorkEventRecord>()
  for (const event of input.delegationAcceptedEvents) {
    const key = stringValue(event.payload['idempotencyKey'])
    if (key && !acceptedEventByKey.has(key)) acceptedEventByKey.set(key, event)
  }
  for (const event of input.delegationMappedEvents) {
    const key = stringValue(event.payload['idempotencyKey'])
    if (key && !mappedEventByKey.has(key)) mappedEventByKey.set(key, event)
  }
  for (const [idempotencyKey, event] of acceptedEventByKey) {
    if (mappedEventByKey.has(idempotencyKey)) continue
    input.addFinding({
      code: 'runtime.delegation.accepted_without_mapped',
      surface: 'delegation_receipts',
      entityKind: 'delegation',
      entityId: sensitiveRef('delegation', idempotencyKey),
      severity: 'critical',
      summary: `Delegation ${sensitiveRef('delegation', idempotencyKey)} was accepted but has no durable mapped receipt.`,
      safeRepairAction: 'Do not dispatch or emit progress until delegation.mapped evidence or an operator-confirmed closeout exists.',
      repairMode: 'operator_confirmed',
      evidenceRefs: [`event:${event.id}`, sensitiveRef('delegation', idempotencyKey)],
    })
  }
  for (const event of input.delegationMappedEvents) {
    const idempotencyKey = stringValue(event.payload['idempotencyKey']) || `event_${event.id}`
    if (!acceptedEventByKey.has(idempotencyKey)) {
      input.addFinding({
        code: 'runtime.delegation.mapped_without_accepted',
        surface: 'delegation_receipts',
        entityKind: 'delegation',
        entityId: sensitiveRef('delegation', idempotencyKey),
        severity: 'warning',
        summary: `Delegation ${sensitiveRef('delegation', idempotencyKey)} has mapped evidence but no accepted event in the replay window.`,
        safeRepairAction: 'Treat the delegation receipt as best-effort until accepted-event lineage is restored or operator-confirmed.',
        repairMode: 'operator_confirmed',
        evidenceRefs: [`event:${event.id}`, sensitiveRef('delegation', idempotencyKey)],
      })
    }
    const taskIds = arrayOfStrings(event.payload['taskIds'])
    const missingTaskIds = taskIds.filter(taskId => !input.tasksById.has(taskId))
    if (missingTaskIds.length) {
      input.addFinding({
        code: 'runtime.delegation.mapped_missing_tasks',
        surface: 'delegation_receipts',
        entityKind: 'delegation',
        entityId: sensitiveRef('delegation', idempotencyKey),
        severity: 'critical',
        summary: `Delegation ${sensitiveRef('delegation', idempotencyKey)} maps to missing task rows.`,
        safeRepairAction: 'Do not emit progress for this delegation until the missing task rows are restored or the delegation is operator-closed.',
        repairMode: 'operator_confirmed',
        evidenceRefs: [`event:${event.id}`, ...missingTaskIds.map(taskId => `task:${safeInlineId(taskId)}`)],
      })
    }
    const roadmapId = stringValue(event.payload['roadmapId'])
    if (roadmapId && !input.roadmapsById.has(roadmapId)) {
      input.addFinding({
        code: 'runtime.delegation.mapped_missing_roadmap',
        surface: 'delegation_receipts',
        entityKind: 'delegation',
        entityId: sensitiveRef('delegation', idempotencyKey),
        severity: 'critical',
        summary: `Delegation ${sensitiveRef('delegation', idempotencyKey)} maps to a missing roadmap.`,
        safeRepairAction: 'Rebuild the roadmap from backup or close the delegation with operator confirmation before sending progress.',
        repairMode: 'operator_confirmed',
        evidenceRefs: [`event:${event.id}`, `roadmap:${safeInlineId(roadmapId)}`],
      })
    }
    if (!input.progressEventsByIdempotencyKey.get(idempotencyKey)?.length) {
      input.addFinding({
        code: 'runtime.delegation.missing_progress',
        surface: 'delegation_progress',
        entityKind: 'delegation',
        entityId: sensitiveRef('delegation', idempotencyKey),
        severity: 'warning',
        summary: `Delegation ${sensitiveRef('delegation', idempotencyKey)} has no durable progress event.`,
        safeRepairAction: 'Rebuild or synthesize progress only after comparing delegation.accepted and delegation.mapped evidence.',
        repairMode: 'operator_confirmed',
        evidenceRefs: [`event:${event.id}`, 'events:delegation.progress'],
      })
    }
  }
}

function scanDelegationProgress(input: {
  progressEventsByKey: Map<string, WorkEventRecord[]>
  routeReceiptsByProgressKey: Map<string, DelegationProgressRouteReceiptRecord[]>
  addFinding: (finding: FindingInput) => void
}): void {
  for (const [progressKey, events] of input.progressEventsByKey) {
    if (events.length > 1) {
      const hashes = new Set(events.map(event => hashStablePayload(event.payload)))
      input.addFinding({
        code: hashes.size === 1 ? 'runtime.delegation_progress.duplicate_exact' : 'runtime.delegation_progress.duplicate_conflict',
        surface: 'delegation_progress',
        entityKind: 'progress',
        entityId: sensitiveRef('progress', progressKey),
        severity: hashes.size === 1 ? 'warning' : 'critical',
        summary: hashes.size === 1
          ? `Progress key ${sensitiveRef('progress', progressKey)} was recorded more than once with the same payload.`
          : `Progress key ${sensitiveRef('progress', progressKey)} was recorded with conflicting payloads.`,
        safeRepairAction: hashes.size === 1
          ? 'Dedupe exact duplicate progress events by progress key during replay.'
          : 'Stop progress delivery and require operator confirmation before selecting the canonical progress event.',
        repairMode: hashes.size === 1 ? 'automatic' : 'operator_confirmed',
        evidenceRefs: events.map(event => `event:${event.id}`),
      })
    }
    const terminal = events.find(event => ['completed', 'failed', 'blocked'].includes(stringValue(event.payload['progress']) || ''))
    if (!terminal) continue
    const target = terminal.payload['notificationTarget']
    const targetRecord = target && typeof target === 'object' ? target as Record<string, unknown> : {}
    const targetMode = stringValue(targetRecord['mode'])
    const hasChannelTarget = Boolean(stringValue(targetRecord['provider']) || targetMode === 'channel')
    const hasParentSessionTarget = Boolean(targetMode === 'parent_session' || stringValue(terminal.payload['parentSessionId']) || stringValue(targetRecord['parentSessionId']))
    if (!hasChannelTarget && !hasParentSessionTarget) continue
    const routeReceipts = input.routeReceiptsByProgressKey.get(progressKey) || []
    const delivered = routeReceipts.some(receipt => receipt.state === 'delivered' || receipt.state === 'retried' || receipt.state === 'muted')
    if (!delivered) {
      input.addFinding({
        code: 'runtime.delegation_progress.terminal_route_missing',
        surface: 'progress_route_receipts',
        entityKind: 'progress',
        entityId: sensitiveRef('progress', progressKey),
        severity: 'warning',
        summary: `Terminal delegated progress ${sensitiveRef('progress', progressKey)} has no delivered route receipt.`,
        safeRepairAction: 'Rerun delegated progress delivery after verifying the trusted channel or parent-session target.',
        repairMode: 'operator_confirmed',
        evidenceRefs: [`event:${terminal.id}`, sensitiveRef('progress', progressKey)],
      })
    }
  }
}

function scanProgressRouteReceipts(input: {
  routeReceipts: DelegationProgressRouteReceiptRecord[]
  nowMs: number
  staleRouteReceiptMs: number
  addFinding: (finding: FindingInput) => void
}): void {
  for (const receipt of input.routeReceipts) {
    const entityId = sensitiveRef('route', receipt.dedupeKey)
    if (receipt.state === 'orphaned' || receipt.state === 'stale_parent') {
      input.addFinding({
        code: receipt.state === 'orphaned' ? 'runtime.route_receipt.orphaned' : 'runtime.route_receipt.stale_parent',
        surface: 'progress_route_receipts',
        entityKind: 'route_receipt',
        entityId,
        severity: 'critical',
        summary: receipt.state === 'orphaned'
          ? `Route receipt ${entityId} has no usable parent session or trusted channel target.`
          : `Route receipt ${entityId} references a stale parent session.`,
        safeRepairAction: receipt.nextAction || SURFACE_REPAIR_ACTION.progress_route_receipts,
        repairMode: 'operator_confirmed',
        evidenceRefs: [`route:${entityId}`, receipt.progressKey ? sensitiveRef('progress', receipt.progressKey) : 'progress:unknown'],
      })
    } else if (receipt.state === 'failed') {
      input.addFinding({
        code: 'runtime.route_receipt.failed',
        surface: 'progress_route_receipts',
        entityKind: 'route_receipt',
        entityId,
        severity: 'warning',
        summary: `Route receipt ${entityId} failed delivery.`,
        safeRepairAction: receipt.nextAction || SURFACE_REPAIR_ACTION.progress_route_receipts,
        repairMode: 'operator_confirmed',
        evidenceRefs: [`route:${entityId}`, receipt.progressKey ? sensitiveRef('progress', receipt.progressKey) : 'progress:unknown'],
      })
    } else if ((receipt.state === 'pending' || receipt.state === 'deferred') && isOlderThan(receipt.updatedAt, input.nowMs, input.staleRouteReceiptMs)) {
      input.addFinding({
        code: 'runtime.route_receipt.delayed_callback',
        surface: 'progress_route_receipts',
        entityKind: 'route_receipt',
        entityId,
        severity: 'warning',
        summary: `Route receipt ${entityId} has not reached a terminal delivery state inside the callback window.`,
        safeRepairAction: receipt.nextAction || 'Rerun delegated progress delivery after checking target availability.',
        repairMode: 'operator_confirmed',
        evidenceRefs: [`route:${entityId}`, receipt.progressKey ? sensitiveRef('progress', receipt.progressKey) : 'progress:unknown'],
      })
    }
  }
}

function scanSessionLinkEvidence(input: {
  state: WorkState
  channelBindings: ChannelBindingRecord[]
  projectBindings: ProjectBindingRecord[]
  activeSessionIds?: ReadonlySet<string>
  addFinding: (finding: FindingInput) => void
}): void {
  if (input.activeSessionIds) return
  const refs = [
    ...input.state.runs.filter(run => isActiveRunStatus(run.status) && run.sessionId).map(run => `run:${safeInlineId(run.id)}`),
    ...input.channelBindings.filter(binding => binding.sessionId).map(binding => sensitiveRef('channel_target', `${binding.provider}:${binding.chatId}:${binding.threadId || ''}`)),
    ...input.projectBindings.filter(binding => binding.sessionId).map(binding => `project_binding:${safeInlineId(binding.id)}`),
  ]
  if (!refs.length) return
  input.addFinding({
    code: 'runtime.session_links.evidence_missing',
    surface: 'session_links',
    entityKind: 'session_links',
    entityId: 'active_session_evidence',
    severity: 'warning',
    summary: 'Active session link evidence was not supplied to the replay consistency harness.',
    safeRepairAction: 'Pass active session IDs from the current OpenCode client view or treat live session ownership as unproven.',
    repairMode: 'operator_confirmed',
    evidenceRefs: refs.slice(0, 20),
  })
}

function scanBindings(input: {
  channelBindings: ChannelBindingRecord[]
  projectBindings: ProjectBindingRecord[]
  tasksById: Map<string, WorkTaskRecord>
  roadmapsById: Map<string, unknown>
  activeSessionIds?: ReadonlySet<string>
  addFinding: (finding: FindingInput) => void
}): void {
  const channelBindingKeys = new Set(input.channelBindings.map(binding => channelBindingKey(binding.provider, binding.chatId, binding.threadId)))
  for (const binding of input.projectBindings) {
    if (!input.roadmapsById.has(binding.roadmapId)) {
      input.addFinding({
        code: 'runtime.project_binding.missing_roadmap',
        surface: 'project_bindings',
        entityKind: 'project_binding',
        entityId: safeInlineId(binding.id),
        severity: 'critical',
        summary: `Project binding ${safeInlineId(binding.id)} references a missing roadmap.`,
        safeRepairAction: 'Restore the roadmap or delete the binding only with operator confirmation.',
        repairMode: 'operator_confirmed',
        evidenceRefs: [`project_binding:${safeInlineId(binding.id)}`, `roadmap:${safeInlineId(binding.roadmapId)}`],
      })
    }
    if (binding.provider && binding.chatId && !channelBindingKeys.has(channelBindingKey(binding.provider, binding.chatId, binding.threadId))) {
      input.addFinding({
        code: 'runtime.project_binding.channel_binding_missing',
        surface: 'channel_bindings',
        entityKind: 'project_binding',
        entityId: safeInlineId(binding.id),
        severity: 'warning',
        summary: `Project binding ${safeInlineId(binding.id)} has no matching trusted channel binding.`,
        safeRepairAction: 'Rebind the channel target through the trusted binding flow before sending notifications.',
        repairMode: 'operator_confirmed',
        evidenceRefs: [`project_binding:${safeInlineId(binding.id)}`, sensitiveRef('channel_target', `${binding.provider}:${binding.chatId}:${binding.threadId || ''}`)],
      })
    }
  }
  for (const binding of input.channelBindings) {
    const entityId = sensitiveRef('channel_target', `${binding.provider}:${binding.chatId}:${binding.threadId || ''}`)
    if (binding.mode === 'task' && binding.taskId && !input.tasksById.has(binding.taskId)) {
      input.addFinding({
        code: 'runtime.channel_binding.missing_task',
        surface: 'channel_bindings',
        entityKind: 'channel_binding',
        entityId,
        severity: 'critical',
        summary: `Task channel binding ${entityId} references a missing task.`,
        safeRepairAction: 'Remove or repair the task binding only after confirming the target task lineage.',
        repairMode: 'operator_confirmed',
        evidenceRefs: [entityId, `task:${safeInlineId(binding.taskId)}`],
      })
    }
    if (binding.mode === 'roadmap' && binding.roadmapId && !input.roadmapsById.has(binding.roadmapId)) {
      input.addFinding({
        code: 'runtime.channel_binding.missing_roadmap',
        surface: 'channel_bindings',
        entityKind: 'channel_binding',
        entityId,
        severity: 'critical',
        summary: `Roadmap channel binding ${entityId} references a missing roadmap.`,
        safeRepairAction: 'Remove or repair the roadmap binding only after confirming the target roadmap lineage.',
        repairMode: 'operator_confirmed',
        evidenceRefs: [entityId, `roadmap:${safeInlineId(binding.roadmapId)}`],
      })
    }
    if (input.activeSessionIds && binding.sessionId && !input.activeSessionIds.has(binding.sessionId)) {
      input.addFinding({
        code: 'runtime.channel_binding.session_missing',
        surface: 'session_links',
        entityKind: 'channel_binding',
        entityId,
        severity: 'warning',
        summary: `Channel binding ${entityId} points at a session that is not currently linked.`,
        safeRepairAction: 'Reconnect the OpenCode session or rebind the channel before claiming live channel sync.',
        repairMode: 'operator_confirmed',
        evidenceRefs: [entityId, sensitiveRef('session', binding.sessionId)],
      })
    }
  }
}

function scanDashboardSummary(input: {
  dashboardSummary?: RuntimeReplayDashboardSummary
  state: WorkState
  addFinding: (finding: FindingInput) => void
}): void {
  if (!input.dashboardSummary) {
    input.addFinding({
      code: 'runtime.dashboard_summary.missing',
      surface: 'dashboard_summary',
      entityKind: 'dashboard',
      entityId: 'mission_control',
      severity: 'warning',
      summary: 'Mission Control dashboard summary was not supplied to the replay consistency harness.',
      safeRepairAction: 'Regenerate Mission Control from durable state before using the report as dashboard evidence.',
      repairMode: 'automatic',
      evidenceRefs: ['dashboard:mission_control'],
    })
    return
  }
  const expectedActiveTaskIds = new Set(input.state.tasks.filter(task => isTaskActiveStatus(task.status)).map(task => task.id))
  const dashboardActiveTaskIds = new Set((input.dashboardSummary.activeIssues || []).map(row => stringValue(row.id)).filter(Boolean) as string[])
  for (const taskId of expectedActiveTaskIds) {
    if (!dashboardActiveTaskIds.has(taskId)) {
      input.addFinding({
        code: 'runtime.dashboard_summary.active_task_missing',
        surface: 'dashboard_summary',
        entityKind: 'task',
        entityId: taskId,
        severity: 'warning',
        summary: `Mission Control summary is missing active task ${safeInlineId(taskId)}.`,
        safeRepairAction: 'Regenerate Mission Control from durable work state before presenting dashboard state.',
        repairMode: 'automatic',
        evidenceRefs: [`task:${safeInlineId(taskId)}`, 'dashboard:mission_control'],
      })
    }
  }
  const activeRoadmapIds = new Set(input.state.roadmaps.filter(roadmap => roadmap.status !== 'archived').map(roadmap => roadmap.id))
  const dashboardRoadmapIds = new Set((input.dashboardSummary.initiatives || []).map(row => stringValue(row.id)).filter(Boolean) as string[])
  for (const roadmapId of activeRoadmapIds) {
    if (!dashboardRoadmapIds.has(roadmapId)) {
      input.addFinding({
        code: 'runtime.dashboard_summary.roadmap_missing',
        surface: 'dashboard_summary',
        entityKind: 'roadmap',
        entityId: roadmapId,
        severity: 'warning',
        summary: `Mission Control summary is missing active roadmap ${safeInlineId(roadmapId)}.`,
        safeRepairAction: 'Regenerate Mission Control from durable work state before presenting dashboard state.',
        repairMode: 'automatic',
        evidenceRefs: [`roadmap:${safeInlineId(roadmapId)}`, 'dashboard:mission_control'],
      })
    }
  }
}

function scanEvidenceManifest(input: {
  evidenceManifest?: RuntimeReplayEvidenceManifest
  addFinding: (finding: FindingInput) => void
}): void {
  const manifest = input.evidenceManifest
  if (!manifest) {
    input.addFinding({
      code: 'runtime.evidence_export.missing',
      surface: 'evidence_export',
      entityKind: 'evidence_export',
      entityId: 'redacted_manifest',
      severity: 'warning',
      summary: 'No redacted evidence manifest was supplied to the replay consistency harness.',
      safeRepairAction: 'Generate a redacted evidence bundle before using the report as release evidence.',
      repairMode: 'automatic',
      evidenceRefs: ['evidence:redacted_manifest'],
    })
    return
  }
  const safeToShare = manifest.contractState?.safeToShare ?? manifest.evidenceContract?.redaction?.safeToShare
  const validationState = manifest.contractState?.validationState || manifest.evidenceContract?.validation?.state || manifest.pipeline?.status
  const claimState = manifest.contractState?.claimState || manifest.evidenceContract?.claimState
  if (safeToShare !== true || validationState !== 'pass' || claimState !== 'local_beta_evidence_only') {
    input.addFinding({
      code: 'runtime.evidence_export.unsafe_or_incomplete',
      surface: 'evidence_export',
      entityKind: 'evidence_export',
      entityId: 'redacted_manifest',
      severity: 'critical',
      summary: 'Evidence export is unsafe, incomplete, or outside the local-beta evidence boundary.',
      safeRepairAction: 'Regenerate the evidence bundle in redacted mode and do not share incomplete, unsafe, or non-local-beta evidence.',
      repairMode: 'blocked',
      evidenceRefs: ['evidence:redacted_manifest'],
    })
  }
}

function buildSurfaceSummaries(input: {
  state: WorkState
  events: WorkEventRecord[]
  taskDispatchReceipts: TaskDispatchReceiptRecord[]
  delegationReceipts: number
  delegationProgressEvents: number
  routeReceipts: DelegationProgressRouteReceiptRecord[]
  channelBindings: ChannelBindingRecord[]
  projectBindings: ProjectBindingRecord[]
  activeSessionIds?: ReadonlySet<string>
  dashboardSummary?: RuntimeReplayDashboardSummary
  evidenceManifest?: RuntimeReplayEvidenceManifest
  findings: RuntimeReplayConsistencyFinding[]
}): RuntimeReplaySurfaceSummary[] {
  const counts: Record<RuntimeReplaySurface, number> = {
    events: input.events.length,
    tasks: input.state.tasks.length,
    runs: input.state.runs.length,
    worker_leases: input.state.runs.filter(run => isActiveRunStatus(run.status)).length,
    task_dispatch_receipts: input.taskDispatchReceipts.length,
    delegation_receipts: input.delegationReceipts,
    delegation_progress: input.delegationProgressEvents,
    progress_route_receipts: input.routeReceipts.length,
    channel_bindings: input.channelBindings.length,
    project_bindings: input.projectBindings.length,
    session_links: input.activeSessionIds?.size ?? 0,
    dashboard_summary: input.dashboardSummary ? 1 : 0,
    evidence_export: input.evidenceManifest ? 1 : 0,
  }
  return RUNTIME_SURFACES.map(surface => {
    const surfaceFindings = input.findings.filter(finding => finding.surface === surface)
    const critical = surfaceFindings.some(finding => finding.severity === 'critical')
    const warning = surfaceFindings.some(finding => finding.severity === 'warning')
    return {
      surface,
      owner: SURFACE_OWNERS[surface],
      status: critical ? 'fail' : warning ? 'warn' : 'pass',
      records: counts[surface],
      rebuildability: SURFACE_REBUILDABILITY[surface],
      evidenceRefs: surfaceEvidenceRefs(surface),
      safeRepairAction: SURFACE_REPAIR_ACTION[surface],
    }
  })
}

function surfaceEvidenceRefs(surface: RuntimeReplaySurface): string[] {
  if (surface === 'events') return ['events:durable-log', 'audit_ledger:work-events']
  if (surface === 'tasks') return ['table:tasks', 'events:task.created']
  if (surface === 'runs') return ['table:runs', 'events:task.run.started', 'events:task.run.completed']
  if (surface === 'worker_leases') return ['table:runs.lease_owner', 'table:runs.lease_expires_at']
  if (surface === 'task_dispatch_receipts') return ['table:task_dispatch_receipts', 'events:task.dispatch.*']
  if (surface === 'delegation_receipts') return ['table:delegation_receipts', 'events:delegation.accepted', 'events:delegation.mapped']
  if (surface === 'delegation_progress') return ['table:delegation_progress_receipts', 'events:delegation.progress']
  if (surface === 'progress_route_receipts') return ['table:delegation_progress_route_receipts', 'events:delegation.progress.*']
  if (surface === 'channel_bindings') return ['table:channel_bindings', 'events:channel.binding.upserted']
  if (surface === 'project_bindings') return ['table:project_bindings', 'events:project.binding.upserted']
  if (surface === 'session_links') return ['runs.session_id', 'channel_bindings.session_id', 'project_bindings.session_id']
  if (surface === 'dashboard_summary') return ['mission_control:dashboard_summary']
  return ['evidence_export:redacted_manifest']
}

function normalizeFinding(input: FindingInput): RuntimeReplayConsistencyFinding {
  const owner = SURFACE_OWNERS[input.surface]
  const entityId = safeInlineId(input.entityId || input.entityKind)
  return {
    code: input.code,
    owner,
    surface: input.surface,
    entityKind: input.entityKind,
    entityId,
    severity: input.severity,
    summary: redactSensitiveText(input.summary),
    safeRepairAction: redactSensitiveText(input.safeRepairAction),
    repairMode: input.repairMode,
    automaticRepair: input.repairMode === 'automatic',
    redacted: true,
    evidenceRefs: (input.evidenceRefs?.length ? input.evidenceRefs : [`${input.entityKind}:${entityId}`]).map(ref => redactSensitiveText(safeInlineId(ref))),
  }
}

function indexEventsBySubjectType(events: WorkEventRecord[]): Map<string, WorkEventRecord[]> {
  const index = new Map<string, WorkEventRecord[]>()
  for (const event of events) {
    if (!event.subjectId) continue
    pushMap(index, eventSubjectTypeKey(event.type, event.subjectId), event)
  }
  return index
}

function indexActiveRunsByTask(runs: RunRecord[]): Map<string, RunRecord[]> {
  const index = new Map<string, RunRecord[]>()
  for (const run of runs) {
    if (isActiveRunStatus(run.status)) pushMap(index, run.taskId, run)
  }
  return index
}

function eventSubjectTypeKey(type: string, subjectId: string): string {
  return `${type}\n${subjectId}`
}

function progressEventKey(event: WorkEventRecord): string | undefined {
  return stringValue(event.payload['progressKey'])
    || [stringValue(event.payload['idempotencyKey']) || stringValue(event.subjectId), stringValue(event.payload['progress']), stringValue(event.payload['subjectId']) || stringValue(event.subjectId)]
      .filter(Boolean)
      .join(':')
}

function channelBindingKey(provider: string, chatId: string, threadId?: string): string {
  return `${provider}\n${chatId}\n${threadId || ''}`
}

function pushMap<T>(map: Map<string, T[]>, key: string, value: T): void {
  const values = map.get(key)
  if (values) values.push(value)
  else map.set(key, [value])
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((row): row is string => typeof row === 'string' && row.trim().length > 0) : []
}

function safeInlineId(value: unknown): string {
  const text = String(value ?? 'unknown')
  return redactSensitiveText(text.replace(/[\r\n\t]/g, ' ').slice(0, 160))
}

function sensitiveRef(kind: string, value: unknown): string {
  return `${kind}_${hashText(String(value ?? 'unknown')).slice(0, 12)}`
}

function hashStablePayload(value: unknown): string {
  return hashText(stableStringify(value))
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

function normalizeGeneratedAt(value: string | Date | undefined, now?: number): string {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(Date.parse(value)).toISOString()
  return new Date(now ?? Date.now()).toISOString()
}

function isRecent(iso: string | undefined, nowMs: number, windowMs: number): boolean {
  const then = Date.parse(iso || '')
  return Number.isFinite(then) && nowMs - then <= windowMs
}

function isOlderThan(iso: string | undefined, nowMs: number, ageMs: number): boolean {
  const then = Date.parse(iso || '')
  return Number.isFinite(then) && nowMs - then > ageMs
}

function isFutureIso(iso: string | undefined, nowMs: number): boolean {
  const then = Date.parse(iso || '')
  return Number.isFinite(then) && then > nowMs
}

function compareStrings(left: string | undefined, right: string | undefined): number {
  return String(left || '').localeCompare(String(right || ''))
}

function compareFindings(left: RuntimeReplayConsistencyFinding, right: RuntimeReplayConsistencyFinding): number {
  return severityRank(right.severity) - severityRank(left.severity)
    || compareStrings(left.surface, right.surface)
    || compareStrings(left.code, right.code)
    || compareStrings(left.entityId, right.entityId)
}

function severityRank(severity: RuntimeReplayConsistencySeverity): number {
  if (severity === 'critical') return 2
  if (severity === 'warning') return 1
  return 0
}
