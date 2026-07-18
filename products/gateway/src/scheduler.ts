import type { OpencodeClient, SessionListData, SessionMessagesData } from '@opencode-ai/sdk'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { decideTaskCapacityAdmission, type CapacityAdmission, type CapacitySelection } from './capacity.js'
import { agentProfileRevision, getConfig, getProfile, type AgentProfile, type AgentTeamConfig, type GatewayConfig } from './config.js'
import { canCurrentDaemonWrite, captureCurrentDaemonLeadershipEpoch, getCurrentDaemonLeadershipStatus } from './daemon-leadership.js'
import { environmentControllerForBackend, environmentControllerForSpec, environmentPromptContext, redactEnvironmentRecord, resolveEnvironmentSpec, type EnvironmentAttachmentResult, type EnvironmentController, type EnvironmentHydrationResult, type EnvironmentRunRecord, type EnvironmentSourcePlan, type EnvironmentSpec } from './environments.js'
import { queueEvent } from './wakeup.js'
import { recordWorkerCompletion } from './observability.js'
import { trackWorker, updateWorker } from './workers.js'
import { evaluateGovernanceForTask, evaluateRunRuntime } from './governance.js'
import { applyHumanGateTimeouts, ensureHumanGateForTaskStage } from './human-loop.js'
import { buildRoadmapMemory, formatRoadmapMemory } from './roadmap-memory.js'
import { listPendingPermissions, listPendingQuestions } from './opencode-requests.js'
import { createOpenCodeSessionRuntime, type OpenCodeSessionRuntime } from './opencode-session-runtime.js'
import { applySupervisorResult, buildRoadmapSupervisorPrompt, parseSupervisorResult } from './supervisor.js'
import { planCapacityHold, planRuntimeFailureTimeline } from './orchestration-kernel.js'
import { isActiveRunStatus } from './runtime-state-machine.js'
import { createSqliteWorkStoreRunLeasePort } from './work-store/run-lease-port.js'
import {
  applyWorkTaskAction,
  blockActiveWorkTaskRun,
  calculateTaskReadiness,
  acquireDueRoadmapSupervisorWakeups,
  appendWorkEvent,
  completeWorkTaskRun,
  completeRoadmapSupervisorWakeup,
  emptyWorkState,
  listWorkEventsByType,
  listTaskDispatchAcquisitions,
  listWorkTaskViews,
  loadWorkState,
  loadWorkStateReadOnly,
  reconcileWorkEnvironments,
  journalTaskDispatchAcquisitionIntent,
  attachTaskDispatchSession,
  markTaskDispatchAcquisitionSettled,
  markTaskDispatchFailed,
  ensureHumanGate,
  summarizeWorkTasks,
  updateWorkTaskRunAttribution,
  updateWorkTask,
  upsertAlert,
  type TaskDispatchAcquisitionRecord,
  type WorkState,
  type WorkTaskRecord,
  type WorkDependencyRecord,
  workStatePath,
  type RunRecord,
  type RunAttributionInput,
  currentWorkDbLeadershipEpoch,
  isStaleWorkDbLeadershipError,
  withWorkDbLeadershipEpoch,
} from './work-store.js'
import { countRunsForTask } from './work-store/queries.js'
import {
  buildStagePrompt,
  mergeTaskQualitySpecDefaults,
  parseStageResult,
  profileForStage,
  type TaskQualitySpec,
  type StageResult,
  type WorkflowDecision,
  type FailureClass,
} from './workflow.js'
import { resolveReviewGateIsolation } from './review-gate-isolation.js'
import { buildRuntimeIsolationProfile, runtimeIsolationPromptContext, summarizeRuntimeIsolationProfile, validateRuntimeIsolationSpec } from './runtime-isolation.js'
import { buildRuntimeCapabilityGrant, runtimeCapabilityGrantPromptContext, summarizeRuntimeCapabilityGrant, type RuntimeCapabilityGrant } from './runtime-capability-grants.js'

let schedulerCyclePromise: Promise<SchedulerCycleSnapshots> | null = null
let schedulerAdmissionOpen = true
const SCHEDULER_INSTANCE_ID = `gateway-${process.pid}-${Date.now()}`
const runLeasePort = createSqliteWorkStoreRunLeasePort()
const PROMPT_DISPATCH_ACK_TIMEOUT_MS = 5 * 60 * 1000
const ACQUISITION_ABSENCE_GRACE_MS = 5 * 60 * 1000

/**
 * Windowed read for the scheduler hot path. The `live` scope materializes only
 * runs the scheduler can legitimately act on this cycle — every running run,
 * every run pinned by a task's `currentRunId`, and a bounded recency slice of
 * terminal runs — so per-tick read latency stays flat as terminal-run history
 * grows. Use this only where the consumers touch active/current runs (or SQL
 * aggregates / targeted queries); reads that need arbitrary old terminal runs
 * (dependency patch harvesting, retained-environment capacity) keep the full
 * `loadWorkState()` scope.
 */
function loadLiveWorkState(): WorkState {
  return loadWorkState(undefined, { runsScope: 'live' })
}

export type TaskStageResolution =
  | {
      ok: true
      stage: string
      source: string
      profileName: string
      profile: AgentProfile
      agentTeamName?: string
      agentTeam?: AgentTeamConfig
      agentTeamVersion?: string
      qualitySpec?: TaskQualitySpec
    }
  | { ok: false; stage: string; source: string; reason: string; agentTeamName?: string; profileName?: string }

export interface SchedulerCycleSnapshots {
  /** Whole-state snapshot taken at the start of the cycle, before any mutation. */
  before: WorkState
  /** Whole-state snapshot taken after the cycle's mutations. */
  after: WorkState
}

export async function schedulerCycle(client: OpencodeClient): Promise<WorkState> {
  return (await schedulerCycleSnapshots(client)).after
}

/** Stop admitting new scheduler cycles. An already-running coalesced cycle is untouched. */
export function stopSchedulerAdmission(): void {
  schedulerAdmissionOpen = false
}

/** Re-enable admission after startup or in deterministic lifecycle tests. */
export function startSchedulerAdmission(): void {
  schedulerAdmissionOpen = true
}

/** Wait for the currently admitted coalesced cycle without starting one. */
export async function waitForSchedulerIdle(): Promise<void> {
  while (schedulerCyclePromise) {
    const inFlight = schedulerCyclePromise
    await inFlight.then(() => undefined, () => undefined)
    if (schedulerCyclePromise === inFlight) return
  }
}

/**
 * Run (or join) a scheduler cycle and expose its start/end state snapshots so
 * callers like the heartbeat can diff activity without re-materializing the
 * whole work state again.
 */
export async function schedulerCycleSnapshots(client: OpencodeClient): Promise<SchedulerCycleSnapshots> {
  if (schedulerCyclePromise) return schedulerCyclePromise
  if (!schedulerAdmissionOpen || !canCurrentDaemonWrite()) {
    // Standby daemons only surface this snapshot to the heartbeat, which reads
    // active runs, running counts, and the newest run for cosmetics — all inside
    // the live window.
    const state = loadLiveWorkState()
    return { before: state, after: state }
  }
  const leadership = getCurrentDaemonLeadershipStatus()
  const epoch = captureCurrentDaemonLeadershipEpoch()
  if (leadership.enabled && !epoch) {
    const state = loadLiveWorkState()
    return { before: state, after: state }
  }
  const cycle = epoch
    ? withWorkDbLeadershipEpoch(epoch, () => runSchedulerCycle(client))
    : runSchedulerCycle(client)
  schedulerCyclePromise = cycle.finally(() => { schedulerCyclePromise = null })
  return schedulerCyclePromise
}

export function getWorkQueueSnapshot(): { state: WorkState; tasks: any[]; counts: ReturnType<typeof summarizeWorkTasks> } {
  // Full scope (NOT windowed): this is a user-facing queue view whose task rows
  // expose each task's lastRun, which can be an old terminal run outside the
  // live window. It is not part of the scheduler's per-tick hot path.
  const state = loadWorkState()
  const tasks = listWorkTaskViews(state)
  return { state, tasks, counts: summarizeWorkTasks(tasks) }
}

export function getWorkQueueSnapshotReadOnly(): { state: WorkState; tasks: any[]; counts: ReturnType<typeof summarizeWorkTasks> } {
  let state: WorkState
  try {
    // Full scope (NOT windowed): user-facing queue view; see getWorkQueueSnapshot.
    state = loadWorkStateReadOnly()
  } catch {
    state = emptyWorkState()
  }
  const tasks = listWorkTaskViews(state)
  return { state, tasks, counts: summarizeWorkTasks(tasks) }
}

// Standby daemons are fenced by the guard in schedulerCycleSnapshots, this
// function's only caller (called synchronously after that check, so leadership
// cannot change in between).
async function runSchedulerCycle(client: OpencodeClient): Promise<SchedulerCycleSnapshots> {
  const config = getConfig()
  // Single pre-mutation snapshot for this cycle. The recovery passes below
  // re-read state inside their own fenced transactions, so a snapshot taken
  // before them is safe for their read-side inputs (active-run directories,
  // worker cosmetics) and doubles as the heartbeat's activity baseline.
  // Live scope: this snapshot only feeds active-run recovery (orphan detection
  // filters `isActiveRunStatus`) and the heartbeat activity baseline (new/
  // completed/active-run diff), both of which live inside the window.
  const before = loadLiveWorkState()
  try {
    const abandonedAcquisitions = await reconcileAbandonedDispatchAcquisitions(client)
    if (abandonedAcquisitions) queueEvent(`Scheduler reconciled ${abandonedAcquisitions} abandoned external acquisition(s)`)
    const expiredDispatchStarts = runLeasePort.recoverExpiredDispatchStarts()
    if (expiredDispatchStarts.recovered) queueEvent(`Scheduler recovered ${expiredDispatchStarts.recovered} expired dispatch start lease(s)`)
    const expiredLeases = runLeasePort.recoverExpiredLeases(config.scheduler.retryLimit)
    if (expiredLeases.recovered || expiredLeases.blocked) queueEvent(`Scheduler recovered ${expiredLeases.recovered} expired run lease(s), blocked ${expiredLeases.blocked} pending operator verification`)
    const environments = reconcileWorkEnvironments()
    if (environments.cleanupFailed) queueEvent(`Environment reconciliation found ${environments.cleanupFailed} cleanup failure(s)`)
    const orphaned = await recoverMissingOpenCodeRuns(client, before, config.scheduler.retryLimit)
    if (orphaned.recovered || orphaned.blocked) queueEvent(`Scheduler recovered ${orphaned.recovered} orphaned run(s), blocked ${orphaned.blocked}`)
    const timedOut = applyHumanGateTimeouts(config)
    if (timedOut.processed) queueEvent(`Human gate timeout policy processed ${timedOut.processed} gate(s)`)
    // One reload after the recovery/timeout mutations. Run completion and
    // supervisor harvesting both apply their changes through fenced per-record
    // mutations that re-read state inside the transaction, so they share it.
    // Live scope: completeRunningRuns only iterates active runs matched to their
    // task's currentRunId; completeRunningSupervisors reads supervisors, not runs.
    const state = loadLiveWorkState()
    await completeRunningRuns(client, state)
    await completeRunningSupervisors(client, state)
    await dispatchDueSupervisors(client)
    // Completions above may have advanced stages or created follow-up tasks, so
    // dispatch decisions need the post-completion state. Live scope: dispatch
    // reads running-run counts, task readiness (tasks/deps), capacity (running
    // runs), and governance (SQL aggregates); the only history touch is the
    // task-start human gate's "has this task ever run" check, which is guarded by
    // scope-key dedup (an existing approved/open gate makes re-checks a no-op).
    await dispatchReadyTasks(client, loadLiveWorkState())
    return { before, after: loadLiveWorkState() }
  } catch (err) {
    if (isStaleWorkDbLeadershipError(err)) return { before, after: before }
    throw err
  }
}

async function completeRunningSupervisors(client: OpencodeClient, state: WorkState): Promise<void> {
  const leased = state.supervisors.filter(supervisor => supervisor.wakeLeaseOwner && supervisor.wakeLeaseExpiresAt)
  for (const supervisor of leased) {
    const messages = await client.session.messages({ path: { id: supervisor.sessionId } }).catch(() => null)
    const result = parseSupervisorResult(messages?.data || [])
    if (!result) continue
    const applied = applySupervisorResult(supervisor.supervisorId, result)
    if (!applied?.applied) continue
    queueEvent(`Supervisor result ${result.status}: ${supervisor.roadmapId}`)
  }
}

// Supervisor prompts already fired from this process and not yet settled,
// keyed by OpenCode session id. If a prompt outlives the wake lease, the next
// cycle re-acquires the wakeup; without this guard it would fire a second
// interleaved LLM turn into the same session (result fencing only dedupes the
// result, not the token burn).
const inFlightSupervisorPrompts = new Set<string>()

export function clearInFlightSupervisorPromptsForTest(): void {
  inFlightSupervisorPrompts.clear()
}

async function dispatchDueSupervisors(client: OpencodeClient): Promise<void> {
  const config = getConfig()
  const lease = leaseOptions()
  const wakeups = acquireDueRoadmapSupervisorWakeups({ leaseOwner: lease.owner, leaseMs: config.scheduler.leaseMs, limit: Math.max(1, config.scheduler.maxConcurrent) })
  if (!wakeups.length) return
  const [questions, permissions] = await Promise.all([
    listPendingQuestions().catch(() => []),
    listPendingPermissions().catch(() => []),
  ])
  // All wakeup leases were acquired above and prompt sends do not mutate work
  // state, so one post-acquisition snapshot serves every prompt in this batch.
  // Live scope: the supervisor prompt reads tasks/roadmaps and pulls run history
  // through the targeted getRunsForRoadmap query (via buildRoadmapMemory), never
  // state.runs directly.
  const promptState = loadLiveWorkState()
  for (const wakeup of wakeups) {
    const sessionId = wakeup.supervisor.sessionId
    if (inFlightSupervisorPrompts.has(sessionId)) {
      queueEvent(`Supervisor wakeup skipped for ${wakeup.supervisor.roadmapId}: previous prompt still in flight`)
      continue
    }
    const profile = getProfile(wakeup.supervisor.profile)
    // Fire-and-forget: supervisor results are harvested by completeRunningSupervisors polling,
    // so the single coalesced scheduler cycle must never block on a full supervisor LLM turn.
    // The abort signal bounds a dead transport to the wake lease window so the promise settles
    // (and the in-flight guard clears) before the expired lease re-arms the wakeup.
    // Escape hatch: skills/permission/string model go through session runtime beyond generated SDK types.
    const sessionRuntime = createOpenCodeSessionRuntime(client)
    inFlightSupervisorPrompts.add(sessionId)
    void sessionRuntime.prompt({
      sessionId,
      agent: profile?.agent || 'gateway-supervisor',
      model: profile?.model,
      skills: profile?.skills,
      permission: profile?.permission,
      parts: [{ type: 'text', text: buildRoadmapSupervisorPrompt(wakeup, promptState, { questions, permissions }) }],
      async: false,
      signal: AbortSignal.timeout(Math.max(60_000, config.scheduler.leaseMs)),
    }).catch((err: any) => {
      completeRoadmapSupervisorWakeup(wakeup.supervisor.supervisorId, { leaseOwner: wakeup.leaseOwner, success: false, note: err?.message || String(err) })
      queueEvent(`Supervisor wakeup failed for ${wakeup.supervisor.roadmapId}: ${err?.message || err}`)
    }).finally(() => {
      inFlightSupervisorPrompts.delete(sessionId)
    })
    queueEvent(`Supervisor wakeup ${wakeup.reason}: ${wakeup.supervisor.roadmapId}`)
  }
}

async function completeRunningRuns(client: OpencodeClient, state: WorkState): Promise<void> {
  for (const run of state.runs.filter(run => isActiveRunStatus(run.status))) {
    const task = state.tasks.find(row => row.id === run.taskId)
    if (!task || task.currentRunId !== run.id) continue
    const directory = runWorkdir(run, task)
    const runtimeDecision = evaluateRunRuntime(run, getConfig())
    if (!runtimeDecision.allowed) {
      const result = blockActiveWorkTaskRun(run.id, runtimeDecision.reason)
      if (result?.applied) {
        updateWorker(run.sessionId, { status: 'errored', lastMessage: runtimeDecision.reason })
        await abortSession(client, run.sessionId, directory)
        queueEvent(`Governance blocked runtime for ${task.title}: ${runtimeDecision.reason}`)
      }
      continue
    }
    const messages = await sessionMessages(client, run.sessionId, directory)
    if (!messages.ok) {
      if (messages.missing) {
        recoverOneMissingRun(run, getConfig().scheduler.retryLimit)
        queueEvent(`Scheduler recovered missing OpenCode session for ${task.title}: ${run.sessionId}`)
        continue
      }
      updateWorker(run.sessionId, { lastMessage: messages.reason || 'OpenCode session check failed' })
      continue
    }

    const session = await sessionGet(client, run.sessionId, directory)
    if (session.missing) {
      recoverOneMissingRun(run, getConfig().scheduler.retryLimit)
      queueEvent(`Scheduler recovered missing OpenCode session for ${task.title}: ${run.sessionId}`)
      continue
    }
    if (session.data) updateWorkTaskRunAttribution(run.id, sessionAttribution(session.data))

    const assistantError = latestAssistantError(messages.data)
    if (assistantError) {
      await handleRuntimeFailure(client, run, task, assistantError, directory, 'assistant')
      continue
    }

    const schedulerLease = leaseOptions()
    const result = parseStageResult(messages.data, run.stage)
    if (!result) {
      if (promptDispatchAckMissingAndStale(run, messages.data)) {
        await handleRuntimeFailure(client, run, task, 'Prompt dispatch was not acknowledged before the recovery timeout; retrying to avoid a zombie run with no worker prompt.', directory, 'prompt')
        queueEvent(`Scheduler recovered stale unacknowledged prompt dispatch for ${task.title}: ${run.sessionId}`)
        continue
      }
      runLeasePort.renewRunLease(run.id, schedulerLease)
      continue
    }

    const completion = completeWorkTaskRun(run.id, result, getConfig().scheduler.retryLimit, undefined, session.data ? sessionAttribution(session.data) : runAttribution(run), {
      owner: schedulerLease.owner,
      generation: schedulerLease.generation,
      now: Date.now(),
    })
    if (!completion?.applied || !completion.task || !completion.run) {
      if (completion?.reason) updateWorker(run.sessionId, { lastMessage: `Completion fenced: ${completion.reason}` })
      continue
    }
    announceCompletion(completion.task, completion.run, completion.decision, result)
    updateWorker(completion.run.sessionId, { status: completion.run.status === 'passed' ? 'completed' : completion.run.status === 'blocked' ? 'errored' : 'completed', lastMessage: result.summary })
    recordWorkerCompletion(client, {
      id: completion.run.sessionId,
      title: `${completion.task.title} [${completion.run.stage}]`,
      stage: completion.run.stage,
      retries: completion.run.attempt - 1,
      status: result.status === 'pass' ? 'completed' : result.status === 'blocked' ? 'blocked' : 'failed',
      summary: result.summary,
    }).catch(() => {})
  }
}

async function dispatchReadyTasks(client: OpencodeClient, state: WorkState): Promise<void> {
  const config = getConfig()
  const runningCount = state.runs.filter(run => isActiveRunStatus(run.status)).length + runLeasePort.countActiveDispatchStarts({})
  const capacity = Math.max(0, config.scheduler.maxConcurrent - runningCount)

  // Build the readiness indexes once for this cycle instead of letting each
  // calculateTaskReadiness() call rebuild tasksById / re-bucket dependencies
  // (O(tasks + deps) per pending task). Identical view of the same state as
  // listWorkTaskViews builds — just shared across the pending scan.
  const tasksById = new Map(state.tasks.map(task => [task.id, task]))
  const dependenciesByTask = new Map<string, WorkDependencyRecord[]>()
  for (const dep of state.dependencies || []) {
    const rows = dependenciesByTask.get(dep.taskId) || []
    rows.push(dep)
    dependenciesByTask.set(dep.taskId, rows)
  }
  const readinessIndexes = { tasksById, dependenciesByTask }

  const ready = state.tasks
    .filter(task => task.status === 'pending' && !task.currentRunId && calculateTaskReadiness(task, state, Date.now(), readinessIndexes).status === 'runnable')
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || deadlineRank(a.deadlineAt) - deadlineRank(b.deadlineAt) || Date.parse(a.createdAt) - Date.parse(b.createdAt))

  if (capacity <= 0) {
    for (const task of ready.slice(0, 5)) {
      recordCapacityHold(task, {
        allowed: false,
        dimension: 'global',
        key: 'scheduler',
        reason: `capacity.global_full: scheduler ${runningCount}/${config.scheduler.maxConcurrent}`,
        used: runningCount,
        limit: config.scheduler.maxConcurrent,
      }, config)
    }
    return
  }

  const activeDispatchStarts = runLeasePort.listDispatchReceipts({ status: 'starting' }).filter(receipt => Date.parse(receipt.leaseExpiresAt) > Date.now())
  const selected: Array<CapacitySelection & { resolution: Extract<TaskStageResolution, { ok: true }> }> = []
  let globalCapacityHoldCount = 0
  for (const task of ready) {
    if (selected.length >= capacity) {
      if (globalCapacityHoldCount < 5) {
        recordCapacityHold(task, {
          allowed: false,
          dimension: 'global',
          key: 'scheduler',
          reason: `capacity.global_full: scheduler ${runningCount + selected.length}/${config.scheduler.maxConcurrent}`,
          used: runningCount + selected.length,
          limit: config.scheduler.maxConcurrent,
        }, config)
        globalCapacityHoldCount++
      }
      continue
    }
    // Per-task cumulative run cap (#203): a separate, higher ceiling than
    // retryLimit (which only bounds attempts within one dispatch). Enforced with
    // a bounded indexed COUNT(*), never by loading runs. A task that has already
    // reached the cap is hard-blocked for operator attention rather than being
    // re-dispatched indefinitely — the guard that stops session-recovery churn
    // from silently ballooning one Issue to unbounded runs/spend.
    const totalRuns = countRunsForTask(task.id)
    if (totalRuns >= config.scheduler.maxRunsPerTask) {
      blockTaskForRunCap(task, totalRuns, config.scheduler.maxRunsPerTask)
      continue
    }
    const stage = task.currentStage || task.pipeline[0] || 'implement'
    const resolution = resolveTaskStageAgent(task, state, stage, config)
    if (!resolution.ok) {
      blockTaskForResolutionFailure(task, resolution)
      continue
    }
    const profile = resolution.profileName
    const capacityDecision = decideTaskCapacityAdmission({
      task,
      stage,
      profileName: profile,
      agentTeamName: resolution.agentTeamName,
      state,
      config,
      startingReceipts: activeDispatchStarts,
      selected,
    })
    if (!capacityDecision.allowed) {
      recordCapacityHold(task, capacityDecision, config)
      continue
    }
    const gate = ensureHumanGateForTaskStage(task, stage, state, config)
    if (gate) {
      queueEvent(`Human gate waiting for ${task.title}: ${gate.reason}`)
      continue
    }
    const governance = evaluateGovernanceForTask(task, stage, state, config)
    if (!governance.allowed) {
      applyWorkTaskAction(task.id, governance.action === 'pause' ? 'pause' : 'block', { stage, note: governance.reason })
      queueEvent(`Governance ${governance.action === 'pause' ? 'paused' : 'blocked'} ${task.title}: ${governance.reason}`)
      continue
    }
    if (governance.status === 'warn') queueEvent(`Governance warning for ${task.title}: ${governance.reason}`)
    selected.push({ task, stage, profileName: profile, agentTeamName: resolution.agentTeamName, resolution })
  }

  for (const item of selected) await dispatchTaskStage(client, item.task, item.resolution)
}

async function dispatchTaskStage(client: OpencodeClient, task: WorkTaskRecord, preparedResolution?: Extract<TaskStageResolution, { ok: true }>): Promise<void> {
  if (!canCurrentDaemonWrite()) return
  const config = getConfig()
  // Full scope (NOT windowed): dispatch harvests dependency patch artifacts from
  // dependency tasks' passed runs (buildDependencySourcePlan) and counts retained
  // environments that can sit on old terminal runs (evaluateEnvironmentCapacity).
  // Both legitimately reach outside the live window, so windowing here would drop
  // dependency patches and undercount retained environments. Runs at most once
  // per selected dispatch, so it is not a steady-state per-tick cost.
  const latestState = loadWorkState()
  const latestTask = latestState.tasks.find(row => row.id === task.id)
  if (!latestTask || latestTask.status !== 'pending' || latestTask.currentRunId || calculateTaskReadiness(latestTask, latestState).status !== 'runnable') return
  const stage = latestTask.currentStage || latestTask.pipeline[0] || 'implement'
  const resolution = preparedResolution && preparedResolution.stage === stage ? preparedResolution : resolveTaskStageAgent(latestTask, latestState, stage, config)
  if (!resolution.ok) {
    blockTaskForResolutionFailure(latestTask, resolution)
    return
  }
  const profileName = resolution.profileName
  const profile = resolution.profile
  const isolation = resolveReviewGateIsolation({ stage, profileName, profile, config })

  const title = `${latestTask.title} [${stage}]`.substring(0, 120)
  const requestedDirectory = taskWorkdir(latestTask)
  const roadmap = latestState.roadmaps.find(row => row.id === latestTask.roadmapId)
  const environmentResolution = resolveEnvironmentSpec({
    taskEnvironment: latestTask.environment,
    roadmapEnvironment: roadmap?.environment,
    profileEnvironment: profile.environment,
    config: config.environments,
    stage,
    workdir: requestedDirectory,
    requiredTools: requiredToolsForTask(latestTask, resolution.qualitySpec),
  })
  if (!environmentResolution.ok) {
    const note = `Environment resolution failed for ${stage}: ${environmentResolution.reason}`
    applyWorkTaskAction(latestTask.id, 'block', { stage, note })
    upsertAlert({
      key: `environment:resolution:${latestTask.id}:${stage}`,
      severity: 'warning',
      source: 'gateway.environment',
      target: latestTask.id,
      summary: note,
      evidence: [`task=${latestTask.id}`, `stage=${stage}`, `source=${environmentResolution.source.join(' > ')}`],
      nextAction: `Fix the task, roadmap, repo, profile, or Gateway environment config, then retry task ${latestTask.id}.`,
      details: { taskId: latestTask.id, stage, reason: environmentResolution.reason, source: environmentResolution.source },
    })
    queueEvent(`Scheduler blocked ${latestTask.title}: ${note}`)
    return
  }
  const environmentSpec = { ...environmentResolution.spec }
  // Never let an unbound local-process run inherit the daemon's ambient cwd — that
  // silently leaks agent file edits into wherever the daemon happens to run (e.g.
  // the Gateway repo). Default to a Gateway-owned per-project workspace under the
  // state dir so file work is real, verifiable, and contained. Bind an explicit
  // repo with `project new --directory <path>` (or a named environment) to override.
  if (environmentSpec.backend === 'local-process' && !environmentSpec.workdir && !requestedDirectory) {
    environmentSpec.workdir = ensureDefaultWorkspace(latestTask)
  }
  const runtimeSpecValidation = validateRuntimeIsolationSpec(environmentSpec)
  if (!runtimeSpecValidation.ok) {
    blockRuntimeIsolationFailure(latestTask, stage, environmentSpec, runtimeSpecValidation)
    return
  }
  const environmentCapacity = evaluateEnvironmentCapacity(environmentSpec, latestState, config)
  if (!environmentCapacity.allowed) {
    recordCapacityHold(latestTask, {
      allowed: false,
      dimension: 'environment',
      key: environmentSpec.backend,
      reason: environmentCapacity.reason,
      used: environmentCapacity.used,
      limit: environmentCapacity.limit,
    }, config)
    queueEvent(`Environment capacity waiting for ${latestTask.title}: ${environmentCapacity.reason}`)
    return
  }
  const gate = ensureEnvironmentHumanGate(latestTask, stage, environmentSpec, config)
  if (gate) {
    queueEvent(`Environment gate waiting for ${latestTask.title}: ${gate.reason}`)
    return
  }
  const lease = leaseOptions()
  const dispatchReceipt = runLeasePort.reserveDispatchStart({
    taskId: latestTask.id,
    stage,
    profile: profileName,
    leaseOwner: lease.owner,
    leaseMs: dispatchStartLeaseMs(config, environmentSpec),
  })
  if (!dispatchReceipt) return
  const dependencyTaskIds = dependencyTaskIdsFor(latestTask.id, latestState)
  const sourcePlan = buildDependencySourcePlan(latestState, environmentSpec.workdir || requestedDirectory, dependencyTaskIds)
  const controller = environmentControllerForSpec(environmentSpec)
  let hydration: EnvironmentHydrationResult
  try {
    hydration = controller.hydrate(environmentSpec, {
      taskId: latestTask.id,
      roadmapId: latestTask.roadmapId,
      stage,
      workdir: environmentSpec.workdir || requestedDirectory,
      dependencyTaskIds,
      sourcePlan,
    })
  } catch (err: any) {
    runLeasePort.markDispatchFailed(dispatchReceipt.id, `Environment hydration failed: ${err?.message || String(err)}`)
    blockEnvironmentLifecycleFailure(latestTask, stage, environmentSpec, 'hydration', err?.message || String(err))
    return
  }
  appendWorkEvent('environment.hydrated', latestTask.id, { stage, environment: redactEnvironmentRecord({ name: environmentSpec.name, backend: environmentSpec.backend, specHash: environmentSpec.specHash }), hydration: redactEnvironmentRecord(hydration) })
  if (!hydration.ok) {
    runLeasePort.markDispatchFailed(dispatchReceipt.id, `Environment hydration failed: ${hydration.reason || 'unknown failure'}`)
    blockEnvironmentLifecycleFailure(latestTask, stage, environmentSpec, 'hydration', hydration.reason || 'unknown failure', hydration.evidence, { hydration: redactEnvironmentRecord(hydration) })
    return
  }
  const environmentAcquisition = journalTaskDispatchAcquisitionIntent(dispatchReceipt.id, {
    kind: 'environment',
    provider: environmentSpec.backend,
    idempotencyKey: `${dispatchReceipt.id}:environment`,
    metadata: { environmentName: environmentSpec.name, specHash: environmentSpec.specHash, stage, workdir: environmentSpec.workdir || requestedDirectory },
  })
  if (!environmentAcquisition) return
  let environmentRun: EnvironmentRunRecord
  let sessionDirectory: string | undefined
  try {
    const prepareOptions = {
      taskId: latestTask.id,
      stage,
      dispatchId: dispatchReceipt.id,
      idempotencyKey: environmentAcquisition.idempotencyKey,
    }
    environmentRun = controller.prepare(environmentSpec, prepareOptions)
  } catch (err: any) {
    runLeasePort.markDispatchFailed(dispatchReceipt.id, `Environment prepare failed: ${err?.message || String(err)}`)
    blockEnvironmentLifecycleFailure(latestTask, stage, environmentSpec, 'prepare', err?.message || String(err))
    return
  }
  let sessionId: string | undefined
  let resourcesOwnedByRun = false
  try {
  const attachedEnvironment = runLeasePort.attachDispatchEnvironment(dispatchReceipt.id, environmentRun)
  if (!attachedEnvironment) {
    releasePreparedEnvironment(controller, latestTask, stage, environmentRun, 'dispatch_ownership_lost', dispatchReceipt.id)
    return
  }
  appendWorkEvent('environment.prepared', latestTask.id, { runId: environmentRun.id, stage, environment: redactEnvironmentRecord(environmentRun) })
  if (!environmentRun.preflight.ok) {
    try {
      const released = controller.release(environmentRun)
      markTaskDispatchAcquisitionSettled(dispatchReceipt.id, 'environment')
      appendWorkEvent('environment.released', latestTask.id, { stage, environment: redactEnvironmentRecord(released), reason: 'preflight_failed' })
    } catch (err: any) {
      upsertAlert({
        key: `environment:release:${latestTask.id}:${stage}:${environmentRun.id}`,
        severity: 'warning',
        source: 'gateway.environment',
        target: latestTask.id,
        summary: `Environment cleanup failed after preflight failure for ${environmentSpec.name}: ${shortFailure(err?.message || String(err))}`,
        evidence: [`task=${latestTask.id}`, `stage=${stage}`, `environment=${environmentSpec.name}`, `backend=${environmentSpec.backend}`],
        nextAction: `Inspect and clean environment ${environmentRun.id}, then retry task ${latestTask.id}.`,
        details: redactEnvironmentRecord({ taskId: latestTask.id, stage, runId: environmentRun.id, reason: err?.message || String(err), environment: environmentRun }),
      })
    }
    const note = `Preflight failed for ${stage} in ${environmentSpec.name} (${environmentSpec.backend}): missing required tool(s): ${environmentRun.preflight.missing.join(', ')}`
    applyWorkTaskAction(latestTask.id, 'block', { stage, note })
    upsertAlert({
      key: `preflight:missing-tools:${environmentSpec.backend}:${environmentRun.preflight.missing.sort().join(',')}`,
      severity: 'warning',
      source: 'gateway.environment',
      target: latestTask.id,
      summary: note,
      evidence: [`task=${latestTask.id}`, `stage=${stage}`, `environment=${environmentSpec.name}`, `backend=${environmentSpec.backend}`, `checked=${environmentRun.preflight.checked.join(', ')}`],
      nextAction: `Install/expose required tool(s) in environment ${environmentSpec.name}, then retry task ${latestTask.id}.`,
      details: { taskId: latestTask.id, stage, environment: redactEnvironmentRecord(environmentRun) },
    })
    queueEvent(`Scheduler blocked ${latestTask.title}: ${note}`)
    runLeasePort.markDispatchFailed(dispatchReceipt.id, note)
    return
  }
  let attachment: EnvironmentAttachmentResult
  try {
    attachment = controller.attach(environmentSpec, environmentRun)
  } catch (err: any) {
    releasePreparedEnvironment(controller, latestTask, stage, environmentRun, 'attach_failed', dispatchReceipt.id)
    runLeasePort.markDispatchFailed(dispatchReceipt.id, `Environment attach failed: ${err?.message || String(err)}`)
    blockEnvironmentLifecycleFailure(latestTask, stage, environmentSpec, 'attach', err?.message || String(err), [], { runId: environmentRun.id })
    return
  }
  appendWorkEvent('environment.attached', latestTask.id, { runId: environmentRun.id, stage, attachment: redactEnvironmentRecord(attachment) })
  if (!attachment.ok) {
    releasePreparedEnvironment(controller, latestTask, stage, environmentRun, 'attach_failed', dispatchReceipt.id)
    runLeasePort.markDispatchFailed(dispatchReceipt.id, `Environment attach failed: ${attachment.reason || 'unknown failure'}`)
    blockEnvironmentLifecycleFailure(latestTask, stage, environmentSpec, 'attach', attachment.reason || 'unknown failure', attachment.evidence, { runId: environmentRun.id, attachment: redactEnvironmentRecord(attachment) })
    return
  }
  const directory = attachment.workdir || environmentSpec.workdir || requestedDirectory
  sessionDirectory = directory
  if (environmentSpec.backend === 'local-container' && sourcePlan.required) {
    let workspaceHydration: EnvironmentHydrationResult
    try {
      workspaceHydration = controller.hydrate(environmentSpec, {
        taskId: latestTask.id,
        roadmapId: latestTask.roadmapId,
        stage,
        workdir: directory,
        dependencyTaskIds,
        sourcePlan,
      })
    } catch (err: any) {
      releasePreparedEnvironment(controller, latestTask, stage, environmentRun, 'hydration_failed', dispatchReceipt.id)
      runLeasePort.markDispatchFailed(dispatchReceipt.id, `Environment hydration failed: ${err?.message || String(err)}`)
      blockEnvironmentLifecycleFailure(latestTask, stage, environmentSpec, 'hydration', err?.message || String(err), [], { runId: environmentRun.id })
      return
    }
    appendWorkEvent('environment.hydrated', latestTask.id, { runId: environmentRun.id, stage, environment: redactEnvironmentRecord({ name: environmentSpec.name, backend: environmentSpec.backend, specHash: environmentSpec.specHash }), hydration: redactEnvironmentRecord(workspaceHydration) })
    if (!workspaceHydration.ok) {
      releasePreparedEnvironment(controller, latestTask, stage, environmentRun, 'hydration_failed', dispatchReceipt.id)
      runLeasePort.markDispatchFailed(dispatchReceipt.id, `Environment hydration failed: ${workspaceHydration.reason || 'unknown failure'}`)
      blockEnvironmentLifecycleFailure(latestTask, stage, environmentSpec, 'hydration', workspaceHydration.reason || 'unknown failure', workspaceHydration.evidence, { runId: environmentRun.id, hydration: redactEnvironmentRecord(workspaceHydration) })
      return
    }
    if (workspaceHydration.source?.applyResult === 'not_required') {
      const reason = 'Local-container dependency source hydration did not run after isolated workspace attachment'
      releasePreparedEnvironment(controller, latestTask, stage, environmentRun, 'hydration_failed', dispatchReceipt.id)
      runLeasePort.markDispatchFailed(dispatchReceipt.id, `Environment hydration failed: ${reason}`)
      blockEnvironmentLifecycleFailure(latestTask, stage, environmentSpec, 'hydration', reason, workspaceHydration.evidence, { runId: environmentRun.id, hydration: redactEnvironmentRecord(workspaceHydration) })
      return
    }
  }
  const capabilityGrant = buildRuntimeCapabilityGrant({
    taskId: latestTask.id,
    stage,
    profileName,
    profile,
    profileRevision: agentProfileRevision(profile),
    config,
    agentTeamName: resolution.agentTeamName,
    agentTeam: resolution.agentTeam,
    source: resolution.source,
    effectivePermission: isolation.effectivePermission as Record<string, unknown>,
    environmentSpec,
    environmentRun,
    workdir: directory,
  })
  if (!capabilityGrant.validation.ok) {
    releasePreparedEnvironment(controller, latestTask, stage, environmentRun, 'runtime_capability_grant_rejected', dispatchReceipt.id)
    runLeasePort.markDispatchFailed(dispatchReceipt.id, `Runtime capability grant rejected: ${capabilityGrant.validation.errors.join('; ')}`)
    blockRuntimeCapabilityGrantFailure(latestTask, stage, environmentSpec, capabilityGrant)
    return
  }
  appendWorkEvent('runtime.capability_grant.validated', latestTask.id, { stage, status: capabilityGrant.status, capabilityGrant: summarizeRuntimeCapabilityGrant(capabilityGrant) })
  const runtimeProfile = buildRuntimeIsolationProfile({
    taskId: latestTask.id,
    stage,
    profileName,
    agentName: profile.agent,
    model: profile.model,
    permissionSummary: isolation.active ? 'review gate isolation enforced' : 'profile permissions applied',
    profileAccess: {
      tools: profile.tools,
      mcpServers: profile.mcpServers,
      skills: profile.skills,
      capabilities: profile.capabilities,
    },
    environmentSpec,
    environmentRun,
    requestedWorkdir: requestedDirectory,
    attachmentWorkdir: directory,
    capabilityGrant,
    reviewGate: {
      active: isolation.active,
      deniedTools: isolation.deniedTools,
      allowedBashCommandCount: isolation.allowedBashCommands.length,
      forbiddenPathHints: isolation.forbiddenPathHints,
      changedPermissions: isolation.changedPermissions,
    },
  })
  if (!runtimeProfile.validation.ok) {
    releasePreparedEnvironment(controller, latestTask, stage, environmentRun, 'runtime_profile_rejected', dispatchReceipt.id)
    runLeasePort.markDispatchFailed(dispatchReceipt.id, `Runtime profile rejected: ${runtimeProfile.validation.errors.join('; ')}`)
    blockRuntimeIsolationFailure(latestTask, stage, environmentSpec, runtimeProfile.validation, { runtimeProfile: summarizeRuntimeIsolationProfile(runtimeProfile, environmentRun) })
    return
  }
  appendWorkEvent('runtime.profile.validated', latestTask.id, { stage, runtimeProfile: summarizeRuntimeIsolationProfile(runtimeProfile, environmentRun) })
  const sessionRuntime = createOpenCodeSessionRuntime(client)
  const sessionTag = `[gw-dispatch:${dispatchReceipt.id}]`
  const sessionTitle = `GW:${title}`.substring(0, Math.max(1, 200 - sessionTag.length - 1)) + ` ${sessionTag}`
  const sessionAcquisition = journalTaskDispatchAcquisitionIntent(dispatchReceipt.id, {
    kind: 'session',
    provider: 'opencode',
    idempotencyKey: `${dispatchReceipt.id}:session`,
    metadata: { directory, titleTag: sessionTag },
  })
  if (!sessionAcquisition) {
    releasePreparedEnvironment(controller, latestTask, stage, environmentRun, 'session_intent_ownership_lost', dispatchReceipt.id)
    return
  }
  try {
    const created = await sessionRuntime.createSession({ title: sessionTitle, directory: directory, agent: profile.agent })
    sessionId = created.id
  } catch (err) {
    runLeasePort.markDispatchFailed(dispatchReceipt.id, `Session create failed: ${(err as any)?.message || String(err)}`)
    throw err
  }
  const attachedSession = attachTaskDispatchSession(dispatchReceipt.id, sessionId)
  if (!attachedSession) {
    if (await abortSessionAndVerify(client, sessionId, directory).catch(() => false)) {
      markTaskDispatchAcquisitionSettled(dispatchReceipt.id, 'session')
      releasePreparedEnvironment(controller, latestTask, stage, environmentRun, 'session_ownership_lost', dispatchReceipt.id)
    } else {
      recordUnverifiedSessionCleanup(latestTask, stage, dispatchReceipt.id, sessionId, directory, 'session_ownership_lost')
    }
    return
  }
  const started = runLeasePort.startRunFromDispatch(dispatchReceipt.id, latestTask.id, stage, sessionId, profileName, lease, {
    agentTeam: resolution.agentTeamName,
    agentTeamVersion: resolution.agentTeamVersion,
    resolvedProfile: profileName,
    resolvedAgent: profile.agent,
    environment: environmentRun,
    runtimeProfile,
    taskQualitySpec: resolution.qualitySpec,
  })
  if (!started) {
    if (await abortSessionAndVerify(client, sessionId, directory).catch(() => false)) {
      markTaskDispatchAcquisitionSettled(dispatchReceipt.id, 'session')
      releasePreparedEnvironment(controller, latestTask, stage, environmentRun, 'run_ownership_lost', dispatchReceipt.id)
    } else {
      recordUnverifiedSessionCleanup(latestTask, stage, dispatchReceipt.id, sessionId, directory, 'run_ownership_lost')
    }
    runLeasePort.markDispatchFailed(dispatchReceipt.id, 'Run ownership lost after session creation')
    return
  }
  resourcesOwnedByRun = true
  const { task: startedTask, run } = started

  trackWorker({
    id: run.sessionId,
    title,
    parentId: `scheduler:${task.id}`,
    status: 'running',
    startedAt: run.startedAt,
    lastCheck: run.startedAt,
    lastTodo: stage,
    lastMessage: null,
  })

  // buildRoadmapMemory reads only state.roadmaps/state.tasks (its runs come from
  // the indexed getRunsForRoadmap), so the default loadWorkState() full-history
  // run materialization is pure waste. Pass a fresh live-scoped state — digest
  // output is identical since it never reads state.runs. (Not reused from an
  // earlier state to keep the recentTasks digest current.)
  const memory = buildRoadmapMemory(startedTask.roadmapId, loadLiveWorkState())
  const prompt = [
    buildStagePrompt({ ...startedTask, roadmapMemory: memory ? formatRoadmapMemory(memory) : undefined }, stage, profile, startedTask.note),
    isolation.promptContext,
    runtimeCapabilityGrantPromptContext(capabilityGrant),
    environmentPromptContext(environmentSpec, environmentRun),
    runtimeIsolationPromptContext(runtimeProfile),
  ].filter(Boolean).join('\n\n')
  if (isolation.active) {
    appendWorkEvent('review_gate.isolation.enforced', startedTask.id, {
      runId: run.id,
      stage,
      profile: profileName,
      deniedTools: isolation.deniedTools,
      allowedBashCommandCount: isolation.allowedBashCommands.length,
      allowedBashCommands: isolation.allowedBashCommands,
      forbiddenPathHints: isolation.forbiddenPathHints,
      changedPermissions: isolation.changedPermissions,
    })
    queueEvent(`Review gate isolation enforced for ${startedTask.title}: ${stage}/${profileName}`)
  }
  // Escape hatch: OpenCode accepts skills/permission and string model beyond generated types.
  // Blocking (async:false): the scheduler's failure detection and dispatch-ack
  // timing depend on the returned promise reflecting the whole turn — a mid-turn
  // provider/turn error must reject here and route to handleRuntimeFailure, and
  // markDispatchPromptSubmitted must fire at turn completion, not at enqueue. If
  // this were fire-and-forget (promptAsync), the SDK resolves 204 immediately and
  // both of those break. The supervisor and daemon reply paths set async:false too.
  void sessionRuntime.prompt({
    sessionId: run.sessionId,
    directory,
    agent: profile.agent,
    model: profile.model as any,
    skills: profile.skills,
    permission: isolation.effectivePermission,
    parts: [{ type: 'text', text: prompt }],
    async: false,
  }).then(() => {
    runLeasePort.markDispatchPromptSubmitted(dispatchReceipt.id)
  }).catch(async (err: any) => {
    const note = `Prompt failed for ${stage}: ${err?.message || err}`
    if (await sessionHasAssistantActivity(client, run.sessionId, directory)) {
      updateWorker(run.sessionId, { lastMessage: `Prompt transport ended after assistant activity: ${err?.message || err}` })
      queueEvent(`Scheduler prompt transport ended after assistant activity for ${task.title}: ${err?.message || err}`)
      return
    }
    await handleRuntimeFailure(client, run, startedTask, note, directory, 'prompt')
    queueEvent(`Scheduler prompt failed for ${task.title}: ${err?.message || err}`)
  })
  queueEvent(`Scheduler dispatched ${stage}: ${latestTask.title}${resolution.agentTeamName ? ` (${resolution.agentTeamName}/${profileName})` : ''} env=${environmentSpec.name}/${environmentSpec.backend}${directory ? ` @ ${directory}` : ''}`)
  } catch (err) {
    if (!resourcesOwnedByRun) {
      let sessionCleanupProven = true
      if (sessionId) {
        sessionCleanupProven = await abortSessionAndVerify(client, sessionId, sessionDirectory).catch(() => false)
        if (sessionCleanupProven) settleDispatchAcquisitionBestEffort(dispatchReceipt.id, 'session')
        else recordUnverifiedSessionCleanup(latestTask, stage, dispatchReceipt.id, sessionId, sessionDirectory, 'stale_or_failed_dispatch')
      }
      if (sessionCleanupProven) releasePreparedEnvironment(controller, latestTask, stage, environmentRun, 'stale_or_failed_dispatch', dispatchReceipt.id)
    }
    if (isStaleWorkDbLeadershipError(err)) return
    throw err
  }
}

function promptDispatchAckMissingAndStale(run: RunRecord, messages: any[], nowMs = Date.now()): boolean {
  if (messages.some(message => (message?.info?.role || message?.role) === 'assistant')) return false
  const startedAt = Date.parse(run.startedAt)
  if (!Number.isFinite(startedAt) || nowMs - startedAt < PROMPT_DISPATCH_ACK_TIMEOUT_MS) return false
  const receipt = runLeasePort.listDispatchReceipts({ taskId: run.taskId, status: 'started' }).find(row => row.runId === run.id)
  return Boolean(receipt && !receipt.promptSubmittedAt)
}

/**
 * Rebind live run leases from a previous daemon instance (or a previous leadership
 * generation of this instance) to this scheduler's current owner + generation.
 *
 * Safety: callers must only invoke this while this daemon holds the singleton writer
 * leadership lease for the state dir. Under that lease no other daemon can be
 * dispatching or completing runs, so rebinding is a leadership handover, not a race:
 * after adoption, a stale competitor's owner/generation no longer matches and its
 * renewals/completions stay fenced.
 */
export function adoptOrphanedRunLeases(): { adopted: number; runIds: string[] } {
  const scopedEpoch = currentWorkDbLeadershipEpoch()
  if (!scopedEpoch) {
    const leadership = getCurrentDaemonLeadershipStatus()
    if (leadership.enabled) {
      const epoch = captureCurrentDaemonLeadershipEpoch()
      if (!epoch) return { adopted: 0, runIds: [] }
      return withWorkDbLeadershipEpoch(epoch, adoptOrphanedRunLeases)
    }
  }
  if (!canCurrentDaemonWrite()) return { adopted: 0, runIds: [] }
  const lease = leaseOptions()
  const adopted = runLeasePort.adoptActiveRunLeases({ owner: lease.owner, generation: lease.generation, leaseMs: lease.leaseMs })
  if (adopted.adopted) queueEvent(`Scheduler adopted ${adopted.adopted} in-flight run lease(s) after daemon restart or writer takeover`)
  return adopted
}

export async function recoverMissingOpenCodeRuns(client: any, state: WorkState | undefined = undefined, retryLimit = getConfig().scheduler.retryLimit): Promise<{ recovered: number; blocked: number; runIds: string[] }> {
  const scopedEpoch = currentWorkDbLeadershipEpoch()
  if (!scopedEpoch) {
    const leadership = getCurrentDaemonLeadershipStatus()
    if (leadership.enabled) {
      const epoch = captureCurrentDaemonLeadershipEpoch()
      if (!epoch) return { recovered: 0, blocked: 0, runIds: [] }
      return withWorkDbLeadershipEpoch(epoch, () => recoverMissingOpenCodeRuns(client, state, retryLimit))
    }
  }
  if (!canCurrentDaemonWrite()) return { recovered: 0, blocked: 0, runIds: [] }
  // Live scope: only active runs are inspected (isActiveRunStatus) and the
  // recovered-worker cosmetics are keyed by recovered run ids.
  state ||= loadLiveWorkState()
  const running = state.runs.filter(run => isActiveRunStatus(run.status))
  if (!running.length || !client?.session?.list) return { recovered: 0, blocked: 0, runIds: [] }
  const runDirectory = new Map<string, string | undefined>()
  const directories = new Set<string | undefined>()
  for (const run of running) {
    const directory = runWorkdir(run, state.tasks.find(task => task.id === run.taskId))
    runDirectory.set(run.id, directory)
    directories.add(directory)
  }
  // Cheap negative pre-filter: a session that IS listed for its workdir is
  // definitely alive, so it needs no per-run confirmation (the healthy case
  // makes zero session.get calls).
  const activeSessionIds = new Set<string>()
  for (const directory of directories) {
    const result = await client.session.list(sessionListOptions(directory)).catch(() => null)
    if (!result) return { recovered: 0, blocked: 0, runIds: [] }
    for (const session of result.data || []) {
      if (session?.id) activeSessionIds.add(String(session.id))
    }
  }
  // Absence from a directory-scoped list is only a *candidate* signal — an
  // unpaginated list can silently cap, omitting a live session. Confirm each
  // candidate with a per-run get-by-id before recovering, exactly as
  // completeRunningRuns does: the id lookup is not subject to the list's
  // windowing, so a run is errored + re-dispatched only when OpenCode itself
  // reports the session gone (a genuine 404), never merely because it fell out
  // of the list.
  const aggregate: { recovered: number; blocked: number; runIds: string[] } = { recovered: 0, blocked: 0, runIds: [] }
  for (const run of running) {
    if (activeSessionIds.has(run.sessionId)) continue
    const session = await sessionGet(client, run.sessionId, runDirectory.get(run.id))
    if (session.data) continue // listed-absent but get-present: the list was incomplete, the run is alive
    if (!session.missing) continue // transport / non-404 error: stay conservative, do not recover
    const result = runLeasePort.recoverOneOrphanedRun(run.id, retryLimit)
    aggregate.recovered += result.recovered
    aggregate.blocked += result.blocked
    aggregate.runIds.push(...result.runIds)
  }
  markRecoveredWorkers(state, aggregate, 'Recovered missing OpenCode session')
  return aggregate
}

async function reconcileAbandonedDispatchAcquisitions(client: OpencodeClient): Promise<number> {
  const epoch = currentWorkDbLeadershipEpoch()
  const leaseOwner = leaseOptions().owner
  const now = Date.now()
  const pending = listTaskDispatchAcquisitions()
    .filter(row => row.dispatchStatus !== 'started' && row.status !== 'released' && row.status !== 'failed')
    .filter(row => {
      const expired = !Number.isFinite(Date.parse(row.leaseExpiresAt)) || Date.parse(row.leaseExpiresAt) <= now
      const foreignOwner = Boolean(row.leaseOwner && row.leaseOwner !== leaseOwner)
      const foreignEpoch = Boolean(epoch && (
        row.leadershipScope !== epoch.scope ||
        row.leaderId !== epoch.leaderId ||
        row.fencingToken !== epoch.fencingToken
      ))
      return row.dispatchStatus === 'failed' || expired || foreignOwner || foreignEpoch
    })
  if (!pending.length) return 0

  const runtime = createOpenCodeSessionRuntime(client)
  const failedDispatches = new Set<string>()
  let reconciled = 0
  // Abort sessions before releasing their backing environments.
  for (const acquisition of [...pending].sort((a, b) => a.kind === b.kind ? 0 : a.kind === 'session' ? -1 : 1)) {
    try {
      let cleanupProven = false
      if (acquisition.kind === 'session') {
        const directory = optionalAcquisitionString(acquisition.metadata['directory'])
        if (acquisition.resourceId) {
          cleanupProven = await deleteSessionAndVerify(runtime, acquisition.resourceId, directory)
        } else {
          const titleTag = optionalAcquisitionString(acquisition.metadata['titleTag'])
          if (titleTag) {
            const sessions = await runtime.listSessions(directory)
            const matches = sessions.filter(row => sessionTitle(row).includes(titleTag) && row?.id)
            cleanupProven = matches.length > 0
            for (const session of matches) {
              const sessionId = String(session.id)
              if (!(await deleteSessionAndVerify(runtime, sessionId, directory))) cleanupProven = false
            }
            const createdAt = Date.parse(acquisition.createdAt)
            if (!matches.length && Number.isFinite(createdAt) && now - createdAt >= ACQUISITION_ABSENCE_GRACE_MS) cleanupProven = true
          }
        }
      } else if (acquisition.resource) {
        const environment = acquisition.resource as unknown as EnvironmentRunRecord
        environmentControllerForBackend(environment.backend).release(environment)
        cleanupProven = true
      } else if (acquisition.kind === 'environment') {
        const recovery = reconcileResourceLessEnvironmentAcquisition(acquisition, now)
        cleanupProven = recovery.cleanupProven
      }
      // A resource-less intent is ambiguous: creation may have been accepted
      // just before a crash but not yet visible to a provider list call. Keep
      // retrying until cleanup or authoritative post-grace absence is proven.
      if (!cleanupProven) continue
      markTaskDispatchAcquisitionSettled(acquisition.dispatchId, acquisition.kind)
      failedDispatches.add(acquisition.dispatchId)
      reconciled++
    } catch (err: any) {
      upsertAlert({
        key: `dispatch:acquisition-reconcile:${acquisition.dispatchId}:${acquisition.kind}`,
        severity: 'warning',
        source: 'gateway.scheduler',
        target: acquisition.taskId,
        summary: `Abandoned ${acquisition.kind} acquisition cleanup failed: ${shortFailure(err?.message || String(err))}`,
        evidence: [`dispatch=${acquisition.dispatchId}`, `kind=${acquisition.kind}`, `provider=${acquisition.provider}`],
        nextAction: `Inspect the abandoned ${acquisition.kind} resource and retry scheduler reconciliation.`,
        details: { dispatchId: acquisition.dispatchId, kind: acquisition.kind, provider: acquisition.provider, resourceId: acquisition.resourceId },
      })
    }
  }
  for (const dispatchId of failedDispatches) {
    markTaskDispatchFailed(dispatchId, 'Abandoned external acquisition reconciled after scheduler restart or writer takeover')
  }
  return reconciled
}

function optionalAcquisitionString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function reconcileResourceLessEnvironmentAcquisition(acquisition: TaskDispatchAcquisitionRecord, now: number): { cleanupProven: boolean } {
  const environmentName = optionalAcquisitionString(acquisition.metadata['environmentName'])
  const expectedSpecHash = optionalAcquisitionString(acquisition.metadata['specHash'])
  if (!environmentName || !expectedSpecHash) {
    throw new Error('resource-less environment acquisition lacks recovery metadata')
  }
  const resolution = resolveEnvironmentSpec({
    taskEnvironment: environmentName,
    config: getConfig().environments,
    stage: acquisition.stage || optionalAcquisitionString(acquisition.metadata['stage']) || 'implement',
    workdir: optionalAcquisitionString(acquisition.metadata['workdir']),
  })
  if (!resolution.ok) {
    throw new Error(`environment acquisition re-resolution failed: ${resolution.reason}`)
  }
  if (resolution.spec.specHash !== expectedSpecHash) {
    throw new Error(`environment acquisition spec drift: expected ${expectedSpecHash}, resolved ${resolution.spec.specHash}`)
  }
  if (resolution.spec.backend !== acquisition.provider) {
    throw new Error(`environment acquisition backend drift: expected ${acquisition.provider}, resolved ${resolution.spec.backend}`)
  }
  const controller = environmentControllerForSpec(resolution.spec)
  const lookup = controller.lookupByKey(resolution.spec, acquisition.idempotencyKey)
  if (!lookup.ok) {
    throw new Error(`environment acquisition lookup failed: ${lookup.reason || lookup.evidence.join('; ') || 'unknown failure'}`)
  }
  if (lookup.found) {
    const released = controller.releaseByKey(resolution.spec, acquisition.idempotencyKey)
    if (!released.ok) {
      throw new Error(`environment acquisition release failed: ${released.reason || released.evidence.join('; ') || 'unknown failure'}`)
    }
    if (released.found && !released.released) {
      throw new Error(`environment acquisition release was not confirmed: ${released.reason || released.evidence.join('; ') || 'unknown failure'}`)
    }
    return { cleanupProven: true }
  }
  const createdAt = Date.parse(acquisition.createdAt)
  return { cleanupProven: Number.isFinite(createdAt) && now - createdAt >= ACQUISITION_ABSENCE_GRACE_MS }
}

function sessionTitle(session: any): string {
  return String(session?.title || session?.info?.title || session?.name || '')
}

export function resolveTaskStageAgent(task: WorkTaskRecord, state: WorkState, stage: string, config: GatewayConfig = getConfig()): TaskStageResolution {
  const roadmap = state.roadmaps.find(row => row.id === task.roadmapId)
  const contextTeamName = task.agentTeam || roadmap?.agentTeam
  const contextTeam = contextTeamName ? config.agentTeams[contextTeamName] : undefined
  if (contextTeamName && !contextTeam) return { ok: false, stage, source: task.agentTeam ? 'task.agentTeam' : 'roadmap.agentTeam', reason: `Agent team not found: ${contextTeamName}`, agentTeamName: contextTeamName }

  const taskProfile = profileOverrideForStage(task.stageProfiles, stage)
  if (taskProfile) return validateResolvedProfile(task, stage, 'task.stageProfiles', taskProfile, contextTeamName, contextTeam, config)

  if (task.agentTeam && contextTeam) {
    const profileName = profileForAgentTeamStage(contextTeam, stage)
    if (!profileName) return { ok: false, stage, source: 'task.agentTeam', reason: `Agent team ${task.agentTeam} has no role for stage ${stage}`, agentTeamName: task.agentTeam }
    return validateResolvedProfile(task, stage, 'task.agentTeam', profileName, task.agentTeam, contextTeam, config)
  }

  if (roadmap?.agentTeam) {
    const roadmapTeam = config.agentTeams[roadmap.agentTeam]
    if (!roadmapTeam) return { ok: false, stage, source: 'roadmap.agentTeam', reason: `Agent team not found: ${roadmap.agentTeam}`, agentTeamName: roadmap.agentTeam }
    const profileName = profileForAgentTeamStage(roadmapTeam, stage)
    if (!profileName) return { ok: false, stage, source: 'roadmap.agentTeam', reason: `Agent team ${roadmap.agentTeam} has no role for stage ${stage}`, agentTeamName: roadmap.agentTeam }
    return validateResolvedProfile(task, stage, 'roadmap.agentTeam', profileName, roadmap.agentTeam, roadmapTeam, config)
  }

  return validateResolvedProfile(task, stage, 'scheduler.stageProfiles', profileForStage(stage, config.scheduler), undefined, undefined, config)
}

function validateResolvedProfile(task: WorkTaskRecord, stage: string, source: string, profileName: string, agentTeamName: string | undefined, agentTeam: AgentTeamConfig | undefined, config: GatewayConfig): TaskStageResolution {
  const profile = config.profiles[profileName]
  if (!profile) return { ok: false, stage, source, reason: `Profile not found for stage ${stage}: ${profileName}`, agentTeamName, profileName }
  const missing = missingCapabilities(agentTeam, stage, profile)
  if (missing.length) {
    return { ok: false, stage, source, reason: `Profile ${profileName} does not satisfy agent team ${agentTeamName} requirements for ${stage}: ${missing.join(', ')}`, agentTeamName, profileName }
  }
  const qualitySpec = agentTeam ? mergeTaskQualitySpecDefaults(task.qualitySpec, agentTeam.qualitySpecDefaults) : task.qualitySpec
  return { ok: true, stage, source, profileName, profile, agentTeamName, agentTeam, agentTeamVersion: agentTeam?.revision, qualitySpec }
}

function profileOverrideForStage(stageProfiles: Record<string, string> | undefined, stage: string): string | undefined {
  return stageProfiles?.[stage] || stageProfiles?.['default']
}

function profileForAgentTeamStage(team: AgentTeamConfig, stage: string): string | undefined {
  return team.roles[stage] || team.roles['default']
}

function missingCapabilities(team: AgentTeamConfig | undefined, stage: string, profile: AgentProfile): string[] {
  if (!team) return []
  const required = [...(team.capabilityRequirements['default'] || []), ...(team.capabilityRequirements[stage] || [])]
  return required.filter(capability => !profileHasCapability(profile, capability))
}

function profileHasCapability(profile: AgentProfile, capability: string): boolean {
  if (profile.agent === capability) return true
  if (profile.skills.includes(capability)) return true
  if (profile.capabilities?.includes(capability)) return true
  if (profile.tools?.includes(capability)) return true
  if (profile.mcpServers?.includes(capability)) return true
  const permission = profile.permission || {}
  return permission[capability] === 'allow' || permission[`${capability}_`] === 'allow' || permission[`${capability}_*`] === 'allow'
}

function blockTaskForResolutionFailure(task: WorkTaskRecord, resolution: Extract<TaskStageResolution, { ok: false }>): void {
  const note = `Agent team resolution failed for ${resolution.stage}: ${resolution.reason}`
  applyWorkTaskAction(task.id, 'block', { stage: resolution.stage, note })
  queueEvent(`Scheduler blocked ${task.title}: ${note}`)
}

/**
 * Per-task run cap tripped (#203). Blocks the task via the durable block/mutation
 * path (applyWorkTaskAction records a `task.block` event) and appends a dedicated
 * `scheduler.run_cap_exceeded` work event so the runaway is auditable. The task
 * then needs operator intervention (unblock / cancel / raise the cap) — it can
 * never silently consume unbounded runs/spend.
 *
 * Idempotent re-block: if an operator resumes/retries a capped task WITHOUT
 * raising `maxRunsPerTask`, its count is still at/over the same cap, so the next
 * cycle must re-block it. When a `scheduler.run_cap_exceeded` event already
 * exists for this task at this cap, the re-block is done quietly (a plain
 * `task.updated`) — no duplicate `run_cap_exceeded`/`task.block` event and no
 * repeat operator notification. The first breach, and any breach at a newly
 * raised cap, stays fully eventful.
 */
function blockTaskForRunCap(task: WorkTaskRecord, totalRuns: number, cap: number): void {
  const note = `Exceeded maxRunsPerTask (${totalRuns} runs) — stuck task, needs operator attention`
  if (hasRunCapExceededEvent(task.id, cap)) {
    updateWorkTask(task.id, { status: 'blocked', note })
    return
  }
  applyWorkTaskAction(task.id, 'block', { stage: task.currentStage, note })
  appendWorkEvent('scheduler.run_cap_exceeded', task.id, { totalRuns, cap, title: task.title })
  queueEvent(`Scheduler blocked ${task.title}: ${note}`)
}

/**
 * True when this task was already reported as run-cap-exceeded at this same cap.
 * Keyed on the cap so that raising `maxRunsPerTask` (a genuinely new breach at a
 * higher ceiling) re-emits, while a resume/retry that leaves the cap unchanged
 * does not. Bounded, type-indexed read over recent `scheduler.run_cap_exceeded`
 * events.
 */
function hasRunCapExceededEvent(taskId: string, cap: number): boolean {
  return listWorkEventsByType('scheduler.run_cap_exceeded')
    .some(event => event.subjectId === taskId && Number(event.payload?.['cap']) === cap)
}

function recordCapacityHold(task: WorkTaskRecord, admission: CapacityAdmission, config: GatewayConfig): void {
  const plan = planCapacityHold({ task, admission, schedulerIntervalMs: config.scheduler.intervalMs, nowMs: Date.now() })
  if (plan.taskPatch) updateWorkTask(task.id, plan.taskPatch)
  appendWorkEvent(plan.eventType, task.id, plan.eventPayload)
  queueEvent(plan.queueMessage)
}

function announceCompletion(task: WorkTaskRecord, run: { stage: string }, decision: WorkflowDecision | undefined, result: StageResult): void {
  if (!decision) return
  if (decision.nextStage) {
    queueEvent(`Scheduler advanced ${task.title}: ${run.stage} -> ${decision.nextStage}`)
    return
  }
  if (decision.retryStage) {
    queueEvent(`Scheduler retrying ${task.title}: ${run.stage} -> ${decision.retryStage}`)
    return
  }
  if (decision.taskStatus === 'done') {
    queueEvent(`Scheduler completed: ${task.title}`)
    return
  }
  if (decision.taskStatus === 'blocked') {
    queueEvent(`Scheduler blocked ${task.title}: ${decision.blockedReason || result.summary}`)
  }
}

function priorityRank(priority: string): number {
  return priority === 'HIGH' ? 0 : priority === 'MEDIUM' ? 1 : 2
}

function deadlineRank(value?: string): number {
  const ms = Date.parse(value || '')
  return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER
}

function leaseOptions() {
  const scheduler = getConfig().scheduler
  const epoch = currentWorkDbLeadershipEpoch()
  if (!epoch) {
    return { owner: SCHEDULER_INSTANCE_ID, leaseMs: scheduler.leaseMs, generation: SCHEDULER_INSTANCE_ID }
  }
  const generation = createHash('sha256')
    .update(`${epoch.scope}\0${epoch.leaderId}\0${epoch.fencingToken}`)
    .digest('hex')
    .slice(0, 24)
  return {
    owner: `scheduler:${epoch.leaderId}`,
    leaseMs: scheduler.leaseMs,
    generation: `leadership:${epoch.scope}:${generation}`,
  }
}

export function dispatchStartLeaseMs(config: ReturnType<typeof getConfig>, environmentSpec: EnvironmentSpec): number {
  const prepareTimeoutMs = Number(environmentSpec.resources.timeoutMs || 0)
  const schedulerBufferMs = Math.max(config.scheduler.intervalMs * 3, 30_000)
  return Math.max(config.scheduler.leaseMs, prepareTimeoutMs > 0 ? prepareTimeoutMs + schedulerBufferMs : 0)
}

async function handleRuntimeFailure(client: OpencodeClient, run: { id: string; sessionId: string; stage: string; attempt: number; profile?: string; resolvedProfile?: string }, task: WorkTaskRecord, message: string, directory: string | undefined, source: 'assistant' | 'prompt'): Promise<void> {
  const failure = classifyRuntimeFailure(message)
  recordFailureAlert(task, run, failure, source)
  if (failure.terminal) {
    const result: StageResult = { status: 'blocked', summary: failure.summary, feedback: failure.summary, failureClass: failure.failureClass, artifacts: [], raw: message.substring(0, 2000) }
    const blocked = blockActiveWorkTaskRun(run.id, failure.summary, undefined, result)
    if (blocked?.applied) {
      updateWorker(run.sessionId, { status: 'errored', lastMessage: failure.summary })
      await abortSession(client, run.sessionId, directory)
      queueEvent(`OpenCode terminal ${failure.kind} failure for ${task.title}: ${failure.summary}`)
    }
    return
  }

  const result: StageResult = { status: 'fail', summary: failure.summary, feedback: failure.summary, failureClass: failure.failureClass, artifacts: [], raw: message.substring(0, 2000) }
  const schedulerLease = leaseOptions()
  const completion = completeWorkTaskRun(run.id, result, getConfig().scheduler.retryLimit, undefined, {}, {
    owner: schedulerLease.owner,
    generation: schedulerLease.generation,
    now: Date.now(),
  })
  if (!completion?.applied) return
  updateWorker(run.sessionId, { status: 'errored', lastMessage: failure.summary })
  await abortSession(client, run.sessionId, directory)
  const timeline = planRuntimeFailureTimeline({
    taskTitle: task.title,
    runStage: run.stage,
    runAttempt: run.attempt,
    failureSummary: failure.summary,
    retryStage: completion.decision?.retryStage,
    taskStatus: completion.task?.status,
    nowMs: Date.now(),
  })
  if (timeline.action === 'retry') {
    updateWorkTask(task.id, timeline.taskPatch)
    queueEvent(timeline.queueMessage)
  } else if (timeline.action === 'blocked') {
    queueEvent(timeline.queueMessage)
  }
}

type RuntimeFailureKind = 'provider_balance' | 'provider_auth' | 'provider_quota' | 'provider_model' | 'transport' | 'unknown'

function classifyRuntimeFailure(message: string): { kind: RuntimeFailureKind; terminal: boolean; summary: string; failureClass: FailureClass; nextAction: string } {
  const text = message.toLowerCase()
  if (/model (not found|not available|unavailable|unknown|unsupported)|provider (not found|not configured|unknown|unsupported|unavailable)|no such model|invalid model|model .*does not exist|provider .*does not exist/.test(text)) return terminalFailure('provider_model', 'Provider/model configuration failure', message, 'needs_credentials', 'Validate the configured provider/model in OpenCode, update the Gateway profile, then retry the task.')
  if (/insufficient balance|billing|payment required|no credits|credit balance|402/.test(text)) return terminalFailure('provider_balance', 'Provider balance or billing failure', message, 'exceeded_budget', 'Top up or rotate the configured model/provider account, then retry the task.')
  if (/unauthorized|forbidden|invalid api key|invalid token|authentication|permission denied|401|403/.test(text)) return terminalFailure('provider_auth', 'Provider authentication failure', message, 'needs_credentials', 'Rotate or fix provider credentials, then retry the task.')
  if (/quota exceeded|rate limit|too many requests|capacity exceeded|429/.test(text)) return terminalFailure('provider_quota', 'Provider quota or rate-limit failure', message, 'exceeded_budget', 'Wait for quota reset or change provider limits before retrying.')
  if (/fetch failed|econnreset|etimedout|timeout|timed out|socket|network|temporar|503|502|504|unavailable/.test(text)) return { kind: 'transport', terminal: false, summary: `Transient OpenCode transport failure: ${shortFailure(message)}`, failureClass: 'flaky_test', nextAction: 'Gateway will retry with bounded backoff; inspect OpenCode/network health if failures repeat.' }
  return { kind: 'unknown', terminal: false, summary: `OpenCode runtime failure: ${shortFailure(message)}`, failureClass: 'flaky_test', nextAction: 'Gateway will retry with bounded backoff; inspect the session and provider logs if failures repeat.' }
}

function terminalFailure(kind: RuntimeFailureKind, label: string, message: string, failureClass: FailureClass, nextAction: string) {
  return { kind, terminal: true, summary: `${label}: ${shortFailure(message)}`, failureClass, nextAction }
}

function recordFailureAlert(task: WorkTaskRecord, run: { id: string; stage: string; attempt: number; resolvedProfile?: string; profile?: string }, failure: ReturnType<typeof classifyRuntimeFailure>, source: string): void {
  const key = `run-failure:${failure.kind}:${run.stage}:${run.resolvedProfile || run.profile || 'unknown'}`
  upsertAlert({
    key,
    severity: failure.terminal ? 'critical' : 'warning',
    source: 'gateway.scheduler',
    target: task.id,
    summary: failure.summary,
    evidence: [`task=${task.id}`, `run=${run.id}`, `stage=${run.stage}`, `attempt=${run.attempt}`, `source=${source}`],
    nextAction: failure.nextAction,
    details: { taskId: task.id, runId: run.id, stage: run.stage, attempt: run.attempt, failureKind: failure.kind, terminal: failure.terminal, source },
  })
}

function ensureEnvironmentHumanGate(task: WorkTaskRecord, stage: string, environment: EnvironmentSpec, config: GatewayConfig) {
  if (!config.humanLoop.enabled) return undefined
  const remoteNeedsApproval = environment.backend === 'remote-crabbox' && config.environments.requireApprovalForRemote && config.humanLoop.externalSideEffectApproval
  const privilegedNeedsApproval = environment.backend === 'local-container' && environment.container?.privileged && config.environments.requireApprovalForPrivilegedContainer && config.humanLoop.destructiveActionApproval
  if (!remoteNeedsApproval && !privilegedNeedsApproval) return undefined
  const type = remoteNeedsApproval ? 'external_side_effect' : 'destructive_action'
  const reason = remoteNeedsApproval
    ? `Remote environment lease requires approval: ${environment.name} (${environment.backend})`
    : `Privileged local container environment requires approval: ${environment.name}`
  return ensureHumanGate({
    type,
    taskId: task.id,
    roadmapId: task.roadmapId,
    stage,
    reason,
    requestedBy: 'gateway.environment',
    expiresAt: new Date(Date.now() + (config.humanLoop.priorityTimeoutMs[task.priority] || config.humanLoop.defaultTimeoutMs)).toISOString(),
    timeoutAction: config.humanLoop.timeoutAction,
    scopeKey: `environment:${type}:task:${task.id}:${stage}:${environment.specHash}`,
    details: { environment: redactEnvironmentRecord({ name: environment.name, backend: environment.backend, specHash: environment.specHash }) },
  })
}

function blockRuntimeCapabilityGrantFailure(task: WorkTaskRecord, stage: string, environment: EnvironmentSpec, grant: RuntimeCapabilityGrant): void {
  const reason = grant.validation.errors.join('; ') || 'runtime capability grant is missing, unsafe, or ambiguous'
  const note = `Runtime capability grant rejected for ${stage} in ${environment.name} (${environment.backend}): ${shortFailure(reason)}`
  applyWorkTaskAction(task.id, 'block', { stage, note })
  upsertAlert({
    key: `runtime-capability-grant:${task.id}:${stage}:${environment.specHash}`,
    severity: 'critical',
    source: 'gateway.runtime.capabilities',
    target: task.id,
    summary: note,
    evidence: [
      `task=${task.id}`,
      `stage=${stage}`,
      `environment=${environment.name}`,
      `backend=${environment.backend}`,
      `grant=${grant.id}`,
      ...grant.validation.errors.map(error => `error=${shortFailure(error)}`),
      ...grant.validation.warnings.map(warning => `warning=${shortFailure(warning)}`),
      ...grant.validation.denied.slice(0, 6).map(row => `denied=${row.kind}:${shortFailure(row.value)}:${shortFailure(row.reason)}`),
    ],
    nextAction: `Fix the profile/team/environment capability grants for ${environment.name}, then retry task ${task.id}.`,
    details: redactEnvironmentRecord({
      taskId: task.id,
      stage,
      reason,
      environment: { name: environment.name, backend: environment.backend, specHash: environment.specHash },
      capabilityGrant: summarizeRuntimeCapabilityGrant(grant),
    }),
  })
  appendWorkEvent('runtime.capability_grant.rejected', task.id, {
    stage,
    status: grant.status,
    environment: redactEnvironmentRecord({ name: environment.name, backend: environment.backend, specHash: environment.specHash }),
    capabilityGrant: summarizeRuntimeCapabilityGrant(grant),
  })
  queueEvent(`Scheduler blocked ${task.title}: ${note}`)
}

function blockRuntimeIsolationFailure(task: WorkTaskRecord, stage: string, environment: EnvironmentSpec, validation: { errors: string[]; warnings?: string[] }, details: Record<string, unknown> = {}): void {
  const reason = validation.errors.join('; ') || 'runtime profile is unsafe or ambiguous'
  const note = `Runtime isolation rejected for ${stage} in ${environment.name} (${environment.backend}): ${shortFailure(reason)}`
  applyWorkTaskAction(task.id, 'block', { stage, note })
  upsertAlert({
    key: `runtime-isolation:${task.id}:${stage}:${environment.specHash}`,
    severity: 'critical',
    source: 'gateway.runtime',
    target: task.id,
    summary: note,
    evidence: [`task=${task.id}`, `stage=${stage}`, `environment=${environment.name}`, `backend=${environment.backend}`, ...validation.errors.map(error => `error=${shortFailure(error)}`), ...(validation.warnings || []).map(warning => `warning=${shortFailure(warning)}`)],
    nextAction: `Fix the runtime/environment profile for ${environment.name}, then retry task ${task.id}.`,
    details: redactEnvironmentRecord({ taskId: task.id, stage, reason, environment: { name: environment.name, backend: environment.backend, specHash: environment.specHash }, warnings: validation.warnings || [], ...details }),
  })
  appendWorkEvent('runtime.profile.rejected', task.id, { stage, environment: redactEnvironmentRecord({ name: environment.name, backend: environment.backend, specHash: environment.specHash }), errors: validation.errors, warnings: validation.warnings || [] })
  queueEvent(`Scheduler blocked ${task.title}: ${note}`)
}

function blockEnvironmentLifecycleFailure(task: WorkTaskRecord, stage: string, environment: EnvironmentSpec, phase: 'hydration' | 'prepare' | 'attach', reason: string, evidence: string[] = [], details: Record<string, unknown> = {}): void {
  const label = phase === 'hydration' ? 'hydration' : phase === 'prepare' ? 'prepare/lease' : 'attach'
  const note = `Environment ${label} failed for ${stage} in ${environment.name} (${environment.backend}): ${shortFailure(reason || 'unknown failure')}`
  applyWorkTaskAction(task.id, 'block', { stage, note })
  upsertAlert({
    key: `environment:${phase}:${task.id}:${stage}`,
    severity: 'warning',
    source: 'gateway.environment',
    target: task.id,
    summary: note,
    evidence: [`task=${task.id}`, `stage=${stage}`, `environment=${environment.name}`, `backend=${environment.backend}`, ...evidence],
    nextAction: `Fix environment ${label} for ${environment.name}, then retry task ${task.id}.`,
    details: redactEnvironmentRecord({ taskId: task.id, stage, phase, reason, environment: { name: environment.name, backend: environment.backend, specHash: environment.specHash }, ...details }),
  })
  queueEvent(`Scheduler blocked ${task.title}: ${note}`)
}

function releasePreparedEnvironment(controller: EnvironmentController, task: WorkTaskRecord, stage: string, environmentRun: EnvironmentRunRecord, reason: string, dispatchId?: string): void {
  let released: EnvironmentRunRecord
  try {
    released = controller.release(environmentRun)
  } catch (err: any) {
    try {
      upsertAlert({
        key: `environment:release:${task.id}:${stage}:${environmentRun.id}:${reason}`,
        severity: 'warning',
        source: 'gateway.environment',
        target: task.id,
        summary: `Environment cleanup failed after ${reason} for ${environmentRun.name}: ${shortFailure(err?.message || String(err))}`,
        evidence: [`task=${task.id}`, `stage=${stage}`, `environment=${environmentRun.name}`, `backend=${environmentRun.backend}`, `run=${environmentRun.id}`],
        nextAction: `Inspect and clean environment ${environmentRun.id}, then retry task ${task.id}.`,
        details: redactEnvironmentRecord({ taskId: task.id, stage, runId: environmentRun.id, reason, error: err?.message || String(err), environment: environmentRun }),
      })
    } catch (alertError) {
      if (!isStaleWorkDbLeadershipError(alertError)) throw alertError
    }
    return
  }
  if (dispatchId) settleDispatchAcquisitionBestEffort(dispatchId, 'environment')
  try {
    appendWorkEvent('environment.released', task.id, { stage, environment: redactEnvironmentRecord(released), reason })
  } catch (eventError) {
    if (!isStaleWorkDbLeadershipError(eventError)) throw eventError
  }
}

function settleDispatchAcquisitionBestEffort(dispatchId: string, kind: 'environment' | 'session', error?: unknown): void {
  try {
    markTaskDispatchAcquisitionSettled(dispatchId, kind, error
      ? { status: 'failed', error: shortFailure((error as Error)?.message || String(error)) }
      : { status: 'released' })
  } catch (settleError) {
    if (!isStaleWorkDbLeadershipError(settleError)) throw settleError
  }
}

function evaluateEnvironmentCapacity(environment: EnvironmentSpec, state: WorkState, config: GatewayConfig): { allowed: boolean; reason: string; used: number; limit: number } {
  const active = state.runs.filter(run => run.environment && (isActiveRunStatus(run.status) || run.environment.status === 'retained'))
  const retained = active.filter(run => run.environment?.status === 'retained')
  const retainedLimit = config.environments.maxRetained
  if (retainedLimit === 0 ? retained.length > 0 : retained.length >= retainedLimit) return { allowed: false, reason: `retained environment limit exhausted (${retained.length}/${retainedLimit})`, used: retained.length, limit: retainedLimit }
  const globalLimit = Math.max(1, config.environments.maxConcurrent || config.scheduler.maxConcurrent)
  if (active.length >= globalLimit) return { allowed: false, reason: `environment concurrency exhausted (${active.length}/${globalLimit})`, used: active.length, limit: globalLimit }
  const backendLimit = config.environments.backendMaxConcurrent[environment.backend]
  if (backendLimit) {
    const sameBackend = active.filter(run => run.environment?.backend === environment.backend).length
    if (sameBackend >= backendLimit) return { allowed: false, reason: `environment backend ${environment.backend} concurrency exhausted (${sameBackend}/${backendLimit})`, used: sameBackend, limit: backendLimit }
  }
  const specLimit = environment.resources.maxConcurrent
  if (specLimit) {
    const sameSpec = active.filter(run => run.environment?.specHash === environment.specHash).length
    if (sameSpec >= specLimit) return { allowed: false, reason: `environment ${environment.name} concurrency exhausted (${sameSpec}/${specLimit})`, used: sameSpec, limit: specLimit }
  }
  return { allowed: true, reason: 'environment capacity available', used: active.length, limit: globalLimit }
}

function dependencyTaskIdsFor(taskId: string, state: WorkState): string[] {
  return (state.dependencies || [])
    .filter(dependency => dependency.taskId === taskId && (dependency.type === 'blocks' || dependency.type === 'blocked_by' || dependency.type === 'parent'))
    .map(dependency => dependency.dependsOnTaskId)
    .sort()
}

function buildDependencySourcePlan(state: WorkState, workdir: string | undefined, dependencyTaskIds: string[]): EnvironmentSourcePlan {
  const baseRef = sourceBaseRef(workdir)
  if (!dependencyTaskIds.length) return { required: false, baseRef, workdir, dependencyTaskIds: [], patches: [], missing: [] }
  const patches: EnvironmentSourcePlan['patches'] = []
  const missing: EnvironmentSourcePlan['missing'] = []
  for (const dependencyTaskId of dependencyTaskIds) {
    const runs = state.runs
      .filter(run => run.taskId === dependencyTaskId && run.status === 'passed' && run.result)
      .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
    const beforeCount = patches.length
    runs.forEach(run => {
      for (const [index, ref] of patchRefsFromRun(run).entries()) {
        const patchPath = resolvePatchPath(ref, workdir)
        if (!patchPath || !fs.existsSync(patchPath)) {
          missing.push({ taskId: dependencyTaskId, reason: `patch artifact not found: ${ref}` })
          continue
        }
        const content = fs.readFileSync(patchPath, 'utf8')
        if (!content.trim()) {
          missing.push({ taskId: dependencyTaskId, reason: `patch artifact is empty: ${ref}` })
          continue
        }
        patches.push({
          id: `${dependencyTaskId}:${run.id}:${index + 1}`,
          taskId: dependencyTaskId,
          runId: run.id,
          stage: run.stage,
          ref,
          path: patchPath,
          content,
          changedFiles: changedFilesFromPatch(content),
        })
      }
    })
    if (patches.length === beforeCount) missing.push({ taskId: dependencyTaskId, reason: 'missing patch artifact' })
  }
  return { required: true, baseRef, workdir, dependencyTaskIds, patches, missing }
}

function patchRefsFromRun(run: RunRecord): string[] {
  if (!run.result) return []
  const refs = [
    ...(run.result.artifacts || []),
    ...(run.result.evidence || []).map(item => item.ref),
  ]
  return uniqueStrings(refs.map(parsePatchRef).filter((ref): ref is string => Boolean(ref)))
}

function parsePatchRef(value: string | undefined): string | undefined {
  const text = String(value || '').trim()
  const prefixed = /^(?:patch|patch-file|diff-file):\s*(.+)$/i.exec(text)
  if (prefixed) return prefixed[1]!.trim()
  return /\.(?:patch|diff)$/i.test(text) ? text : undefined
}

function resolvePatchPath(ref: string, workdir: string | undefined): string | undefined {
  const fileRef = ref.startsWith('file://') ? new URL(ref).pathname : ref
  if (!workdir) return undefined
  const resolved = path.isAbsolute(fileRef) ? fileRef : path.resolve(workdir, fileRef)
  const relative = path.relative(workdir, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined
  return resolved
}

function changedFilesFromPatch(content: string): string[] {
  const files: string[] = []
  for (const line of content.split(/\r?\n/)) {
    const diff = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
    if (diff) files.push(diff[2] === '/dev/null' ? diff[1]! : diff[2]!)
    const added = /^\+\+\+ b\/(.+)$/.exec(line)
    if (added && added[1] !== '/dev/null') files.push(added[1]!)
  }
  return uniqueStrings(files).sort()
}

function sourceBaseRef(workdir: string | undefined): string {
  if (!workdir) return 'none'
  const result = spawnSync('git', ['-C', workdir, 'rev-parse', 'HEAD'], { encoding: 'utf8', maxBuffer: 1024 * 1024 })
  const ref = result.status === 0 ? result.stdout.trim() : ''
  return ref || `workdir:${path.resolve(workdir)}`
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

function shortFailure(message: string): string {
  return message.replace(/\s+/g, ' ').trim().substring(0, 500)
}

function requiredToolsForTask(task: WorkTaskRecord, qualitySpec: TaskQualitySpec | undefined): string[] {
  const spec = qualitySpec || task.qualitySpec
  const tools = new Set<string>()
  for (const tool of spec?.requiredTools || []) addTool(tools, tool)
  for (const value of [task.note || '', task.description || '', ...(spec?.constraints || []), ...(spec?.systemsTouched || [])]) {
    for (const tool of parseRequiredTools(value)) addTool(tools, tool)
  }
  return [...tools].sort()
}

function parseRequiredTools(value: string): string[] {
  const tools: string[] = []
  for (const line of value.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:required tools|preflight tools|tools)\s*:\s*(.+?)\s*$/i)
    if (match?.[1]) tools.push(...match[1].split(/[,;]/))
  }
  return tools
}

function addTool(tools: Set<string>, value: string): void {
  const tool = value.replace(/`/g, '').trim().split(/\s+/)[0]?.toLowerCase()
  if (tool) tools.add(tool)
}

function taskWorkdir(task: WorkTaskRecord | undefined): string | undefined {
  if (!task) return undefined
  const spec = task.qualitySpec
  const candidates = [
    ...(spec?.systemsTouched || []),
    ...(spec?.constraints || []),
    ...(spec?.requiredArtifacts || []),
    task.note || '',
    task.description || '',
  ]
  for (const candidate of candidates) {
    const dir = extractWorkdir(candidate)
    if (dir) return dir
  }
  return undefined
}

function runWorkdir(run: { environment?: { workdir?: string } } | undefined, task: WorkTaskRecord | undefined): string | undefined {
  return run?.environment?.workdir || taskWorkdir(task)
}

/**
 * Gateway-owned fallback workspace for an unbound local-process task: a stable
 * per-project (per-roadmap, else per-task) directory under the state dir, created
 * on demand. Keeps agent file work real and contained instead of leaking into the
 * daemon's ambient cwd.
 */
function ensureDefaultWorkspace(task: WorkTaskRecord): string {
  const key = task.roadmapId || `task-${task.id}`
  const workspace = path.join(path.dirname(workStatePath()), 'workspaces', key)
  fs.mkdirSync(workspace, { recursive: true })
  return workspace
}

function extractWorkdir(value: string): string | undefined {
  for (const line of value.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:workdir|working directory|checkout|directory)\s*:\s*(.+?)\s*$/i)
    const candidate = match?.[1]?.trim()
    if (candidate && path.isAbsolute(candidate)) return canonicalWorkdir(candidate)
  }
  const inline = value.match(/\b(?:workdir|checkout)=([^\s,;]+)/i)?.[1]
  return inline && path.isAbsolute(inline) ? canonicalWorkdir(inline) : undefined
}

function canonicalWorkdir(directory: string): string {
  try { return fs.realpathSync(directory) } catch { return path.resolve(directory) }
}

function sessionListOptions(directory?: string): Omit<SessionListData, 'url'> {
  return directory ? { query: { directory } } : {}
}

// Widest of the session-scoped path options (messages allows `limit`); the get
// call site accepts a superset structurally, so one helper serves remaining hosts.
function sessionPathOptions(id: string, directory?: string, extraQuery: { limit?: number } = {}): Omit<SessionMessagesData, 'url'> {
  const query = { ...extraQuery, ...(directory ? { directory } : {}) }
  return Object.keys(query).length ? { path: { id }, query } : { path: { id } }
}

async function abortSession(client: OpencodeClient, sessionId: string, directory?: string): Promise<void> {
  await createOpenCodeSessionRuntime(client).abort(sessionId, directory)
}

async function abortSessionAndVerify(client: OpencodeClient, sessionId: string, directory?: string): Promise<boolean> {
  const runtime = createOpenCodeSessionRuntime(client)
  return deleteSessionAndVerify(runtime, sessionId, directory)
}

async function deleteSessionAndVerify(runtime: OpenCodeSessionRuntime, sessionId: string, directory?: string): Promise<boolean> {
  await runtime.abort(sessionId, directory).catch(() => undefined)
  await runtime.deleteSession(sessionId, directory).catch(err => {
    if (!isNotFoundError(err)) throw err
  })
  return (await runtime.getSession(sessionId, directory)).missing
}

function recordUnverifiedSessionCleanup(task: WorkTaskRecord, stage: string, dispatchId: string, sessionId: string, directory: string | undefined, reason: string): void {
  try {
    upsertAlert({
      key: `dispatch:session-cleanup-unverified:${dispatchId}:${sessionId}`,
      severity: 'warning',
      source: 'gateway.scheduler',
      target: task.id,
      summary: `OpenCode session cleanup was not verified for ${task.title}: ${sessionId}`,
      evidence: [`task=${task.id}`, `stage=${stage}`, `dispatch=${dispatchId}`, `session=${sessionId}`, ...(directory ? [`directory=${directory}`] : [])],
      nextAction: `Inspect OpenCode session ${sessionId}; the scheduler will keep the acquisition pending until cleanup is proven.`,
      details: { taskId: task.id, stage, dispatchId, sessionId, directory, reason },
    })
  } catch {}
}

async function sessionMessages(client: OpencodeClient, sessionId: string, directory?: string): Promise<{ ok: true; data: any[] } | { ok: false; missing: boolean; reason?: string }> {
  try {
    const response = await client.session.messages(sessionPathOptions(sessionId, directory, { limit: 50 }))
    return { ok: true, data: response?.data || [] }
  } catch (err: any) {
    return { ok: false, missing: isNotFoundError(err), reason: err?.message || String(err) }
  }
}

async function sessionHasAssistantActivity(client: OpencodeClient, sessionId: string, directory?: string): Promise<boolean> {
  const messages = await sessionMessages(client, sessionId, directory)
  return messages.ok && messages.data.some(message => (message?.info?.role || message?.role) === 'assistant')
}

async function sessionGet(client: OpencodeClient, sessionId: string, directory?: string): Promise<{ data?: any; missing: boolean }> {
  try {
    const response = await client.session.get(sessionPathOptions(sessionId, directory))
    return { data: response?.data, missing: false }
  } catch (err: any) {
    return { missing: isNotFoundError(err) }
  }
}

function recoverOneMissingRun(run: { id: string; sessionId: string }, retryLimit: number): void {
  const recovered = runLeasePort.recoverOneOrphanedRun(run.id, retryLimit)
  if (recovered.runIds.includes(run.id)) updateWorker(run.sessionId, { status: 'errored', lastMessage: 'Recovered missing OpenCode session' })
}

function markRecoveredWorkers(state: WorkState, recovered: { runIds: string[] }, message: string): void {
  const runIds = new Set(recovered.runIds)
  for (const run of state.runs.filter(row => runIds.has(row.id))) {
    updateWorker(run.sessionId, { status: 'errored', lastMessage: message })
  }
}

export function isNotFoundError(err: any): boolean {
  const status = Number(err?.status || err?.statusCode || err?.response?.status || err?.data?.statusCode || err?.error?.status)
  return status === 404 || /(^|\D)404(\D|$)|not found/i.test(String(err?.message || err))
}

export function getSchedulerLeaseSummary(state: WorkState = loadLiveWorkState()) {
  // Live scope: summarizeWorkLeases only considers active runs.
  return runLeasePort.summarizeLeases(state)
}

function sessionAttribution(session: any) {
  const tokens = session?.tokens || {}
  return {
    costUsd: Number(session?.cost || 0),
    inputTokens: Number(tokens.input || 0),
    outputTokens: Number(tokens.output || 0),
    reasoningTokens: Number(tokens.reasoning || 0),
    cacheReadTokens: Number(tokens.cache?.read || 0),
    cacheWriteTokens: Number(tokens.cache?.write || 0),
  }
}

function latestAssistantError(messages: any[]): string | undefined {
  for (const message of [...messages].reverse()) {
    const role = message?.info?.role || message?.role
    if (role !== 'assistant') continue
    const error = message?.info?.error || message?.error
    if (!error) return undefined
    return formatAssistantError(error)
  }
  return undefined
}

function formatAssistantError(error: any): string {
  const detail = error?.data?.message || error?.message || error?.name || String(error)
  const status = error?.data?.statusCode ? `HTTP ${error.data.statusCode}: ` : ''
  return `OpenCode assistant error: ${status}${detail}`
}

function runAttribution(run: RunAttributionInput): RunAttributionInput {
  return {
    costUsd: run.costUsd,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    reasoningTokens: run.reasoningTokens,
    cacheReadTokens: run.cacheReadTokens,
    cacheWriteTokens: run.cacheWriteTokens,
  }
}
