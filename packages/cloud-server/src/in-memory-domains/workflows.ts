import { createHash, randomBytes } from 'node:crypto'
import { normalizeWorkflowSteps } from '@open-cowork/shared'
import type { WorkflowRunStatus, WorkflowStatus } from '@open-cowork/shared'
import { clone, key, nowIso } from './store-helpers.ts'
import type {
  AttachWorkflowRunSessionInput,
  ClaimDueWorkflowRunInput,
  ClaimedWorkflowRunRecord,
  CloudWorkflowRecord,
  CloudWorkflowRunRecord,
  CompleteWorkflowRunInput,
  CreateWorkflowInput,
  CreateWorkflowRunInput,
  FailWorkflowRunInput,
  ListWorkflowRunsForWorkflowsInput,
  ListWorkflowsPageInput,
  ListWorkflowsPageRecord,
  ReapExpiredWorkflowClaimsInput,
  ReapedWorkflowClaimRecord,
  UpdateWorkflowStatusInput,
  WorkflowRunQuota,
  WorkReaperAction,
} from '../control-plane-store.ts'
import { decodeWorkflowPageCursor, encodeWorkflowPageCursor } from '../workflow-page-cursor.ts'

// Workflow + workflow-run domain extracted from in-memory-control-plane-store.ts.
// Owns the workflow records (with their runs) and the run records, and the full
// authoring + run lifecycle (create / list / status, run create / claim-due /
// reap-expired-claims / attach-session / complete / fail). Cross-domain needs —
// tenant/tenant-user existence, run-quota enforcement, whether a session has
// commands, and session-lease fencing — arrive via the injected host (all
// primitive-typed; the session-lease decoupling means no SessionState leaks here).
// Behaviour-preserving; the cloud-http-server workflow suite (128 assertions) covers it.

type WorkflowState = {
  record: CloudWorkflowRecord
  runs: CloudWorkflowRunRecord[]
}

type InMemoryWorkflowsHost = {
  requireTenant(tenantId: string): void
  requireTenantUser(tenantId: string, userId: string): void
  assertWorkflowRunQuota(input: { tenantId: string; quota?: WorkflowRunQuota | null; now?: Date }): void
  sessionHasCommands(tenantId: string, sessionId: string): boolean
  assertSessionLease(tenantId: string, sessionId: string, leaseToken: string | null | undefined): void
}

export class InMemoryWorkflowsDomain {
  private readonly workflows = new Map<string, WorkflowState>()
  private readonly workflowRuns = new Map<string, CloudWorkflowRunRecord>()
  private readonly host: InMemoryWorkflowsHost

  constructor(host: InMemoryWorkflowsHost) {
    this.host = host
  }

  // All run records, for the quota domain's concurrent-run accounting (the only
  // cross-domain reader of this state).
  allRuns(): IterableIterator<CloudWorkflowRunRecord> {
    return this.workflowRuns.values()
  }

  createWorkflow(input: CreateWorkflowInput): CloudWorkflowRecord {
    this.host.requireTenantUser(input.tenantId, input.userId)
    const workflowKey = key(input.tenantId, input.workflowId)
    const existing = this.workflows.get(workflowKey)
    if (existing) return clone(existing.record)
    const createdAt = nowIso(input.createdAt)
    const draft = clone(input.draft)
    const record: CloudWorkflowRecord = {
      tenantId: input.tenantId,
      userId: input.userId,
      id: input.workflowId,
      title: draft.title,
      instructions: draft.instructions,
      agentName: draft.agentName,
      skillNames: [...(draft.skillNames || [])],
      toolIds: [...(draft.toolIds || [])],
      steps: normalizeWorkflowSteps(draft.steps, {
        instructions: draft.instructions,
        agentName: draft.agentName,
        skillNames: draft.skillNames,
        toolIds: draft.toolIds,
      }),
      status: 'active',
      projectDirectory: draft.projectDirectory || null,
      draftSessionId: draft.draftSessionId || null,
      triggers: clone(draft.triggers),
      createdAt,
      updatedAt: createdAt,
      nextRunAt: input.nextRunAt ?? null,
      lastRunAt: null,
      latestRunId: null,
      latestRunStatus: null,
      latestRunSessionId: null,
      latestRunSummary: null,
      webhookUrl: null,
    }
    this.workflows.set(workflowKey, { record, runs: [] })
    return clone(record)
  }

  findWorkflow(workflowId: string): CloudWorkflowRecord | null {
    const workflow = Array.from(this.workflows.values())
      .map((entry) => entry.record)
      .filter((record) => record.id === workflowId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.tenantId.localeCompare(right.tenantId))[0]
    return workflow ? clone(workflow) : null
  }

  listWorkflows(tenantId: string, userId: string): CloudWorkflowRecord[] {
    return this.listWorkflowsPage({ tenantId, userId, limit: WORKFLOW_LIST_LIMIT }).items
  }

  listWorkflowsPage(input: ListWorkflowsPageInput): ListWorkflowsPageRecord {
    const { tenantId, userId } = input
    this.host.requireTenantUser(tenantId, userId)
    const limit = Math.max(1, Math.min(WORKFLOW_LIST_LIMIT, Math.floor(input.limit ?? 100)))
    const cursor = decodeWorkflowPageCursor(input.cursor, input)
    const filtered = Array.from(this.workflows.values())
      .filter((workflow) => workflow.record.tenantId === tenantId && workflow.record.userId === userId)
      .sort((left, right) => (
        right.record.updatedAt.localeCompare(left.record.updatedAt)
        || left.record.id.localeCompare(right.record.id)
      ))
      .filter((workflow) => !cursor
        || workflow.record.updatedAt < cursor.updatedAt
        || (workflow.record.updatedAt === cursor.updatedAt && workflow.record.id > cursor.workflowId))
    const page = filtered.slice(0, limit)
    const hasMore = filtered.length > limit
    return {
      items: page.map((workflow) => clone(workflow.record)),
      nextCursor: hasMore && page.length > 0 ? encodeWorkflowPageCursor(page[page.length - 1]!.record, input) : null,
      totalEstimate: hasMore ? limit + 1 : filtered.length,
    }
  }

  getWorkflow(tenantId: string, userId: string, workflowId: string): CloudWorkflowRecord | null {
    this.host.requireTenantUser(tenantId, userId)
    const workflow = this.workflows.get(key(tenantId, workflowId))?.record || null
    if (!workflow || workflow.userId !== userId) return null
    return clone(workflow)
  }

  getWorkflowForTenant(tenantId: string, workflowId: string): CloudWorkflowRecord | null {
    this.host.requireTenant(tenantId)
    return clone(this.workflows.get(key(tenantId, workflowId))?.record || null)
  }

  updateWorkflowStatus(input: UpdateWorkflowStatusInput): CloudWorkflowRecord | null {
    this.host.requireTenantUser(input.tenantId, input.userId)
    const workflow = this.workflows.get(key(input.tenantId, input.workflowId))
    if (!workflow || workflow.record.userId !== input.userId) return null
    workflow.record.status = input.status
    workflow.record.nextRunAt = input.nextRunAt ?? null
    workflow.record.updatedAt = nowIso(input.updatedAt)
    return clone(workflow.record)
  }

  listWorkflowRuns(tenantId: string, workflowId: string, limit = 25): CloudWorkflowRunRecord[] {
    this.host.requireTenant(tenantId)
    const workflow = this.requireWorkflow(tenantId, workflowId)
    return workflow.runs
      .slice()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id))
      .slice(0, Math.min(Math.max(1, limit), WORKFLOW_RUN_LIST_LIMIT))
      .map((run) => clone(run))
  }

  listWorkflowRunsForWorkflows(input: ListWorkflowRunsForWorkflowsInput): CloudWorkflowRunRecord[] {
    this.host.requireTenantUser(input.tenantId, input.userId)
    const workflowIds = Array.from(new Set(input.workflowIds.filter(Boolean)))
    if (workflowIds.length === 0) return []
    const workflowIdSet = new Set(workflowIds)
    const limitPerWorkflow = Math.max(1, Math.min(WORKFLOW_RUN_LIST_LIMIT, Math.floor(input.limitPerWorkflow ?? 25)))
    const limit = Math.max(1, Math.min(WORKFLOW_RUN_LIST_LIMIT, Math.floor(input.limit ?? WORKFLOW_RUN_LIST_LIMIT)))
    const runs: CloudWorkflowRunRecord[] = []
    for (const workflow of this.workflows.values()) {
      if (
        workflow.record.tenantId !== input.tenantId
        || workflow.record.userId !== input.userId
        || !workflowIdSet.has(workflow.record.id)
      ) continue
      runs.push(...workflow.runs
        .slice()
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id))
        .slice(0, limitPerWorkflow))
    }
    return runs
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id))
      .slice(0, limit)
      .map((run) => clone(run))
  }

  createWorkflowRun(input: CreateWorkflowRunInput): CloudWorkflowRunRecord {
    this.host.requireTenantUser(input.tenantId, input.userId)
    const workflow = this.requireWorkflow(input.tenantId, input.workflowId)
    if (workflow.record.userId !== input.userId) throw new Error(`Unknown workflow ${input.workflowId}.`)
    this.assertWorkflowRunnable(workflow.record)
    const runKey = key(input.tenantId, input.runId)
    const existing = this.workflowRuns.get(runKey)
    if (existing) return clone(existing)
    this.host.assertWorkflowRunQuota({ tenantId: input.tenantId, quota: input.quota, now: input.createdAt })
    const createdAt = nowIso(input.createdAt)
    const claimedBy = input.claimedBy?.trim() || null
    const claimToken = claimedBy ? createWorkClaimToken(input.tenantId, input.runId, claimedBy) : null
    const leaseTtlMs = Math.max(1, Math.floor(input.leaseTtlMs ?? 30_000))
    const plannedSessionId = input.sessionId?.trim() || workflowRunSessionId(input.tenantId, input.workflowId, input.runId)
    const run: CloudWorkflowRunRecord = {
      tenantId: input.tenantId,
      userId: input.userId,
      id: input.runId,
      workflowId: input.workflowId,
      sessionId: plannedSessionId,
      triggerType: input.triggerType,
      triggerPayload: input.triggerPayload || null,
      status: 'queued',
      title: `Run ${workflow.record.title}`,
      summary: null,
      error: null,
      createdAt,
      startedAt: null,
      finishedAt: null,
      claimedBy,
      claimToken,
      claimExpiresAt: claimToken ? new Date(new Date(createdAt).getTime() + leaseTtlMs).toISOString() : null,
      attemptCount: claimToken ? 1 : 0,
      idempotencyKey: null,
      checkpointVersion: 0,
      lastErrorCode: null,
      lastErrorSummary: null,
    }
    workflow.runs.push(run)
    this.workflowRuns.set(runKey, run)
    workflow.record.status = 'running'
    workflow.record.latestRunId = run.id
    workflow.record.latestRunStatus = run.status
    workflow.record.latestRunSessionId = run.sessionId
    workflow.record.updatedAt = createdAt
    return clone(run)
  }

  claimDueWorkflowRun(input: ClaimDueWorkflowRunInput): ClaimedWorkflowRunRecord | null {
    const now = input.now || new Date()
    const claimedAt = now.toISOString()
    const claimedBy = input.claimedBy?.trim() || 'scheduler'
    const leaseTtlMs = Math.max(1, Math.floor(input.leaseTtlMs ?? 30_000))
    const retryRun = Array.from(this.workflowRuns.values())
      .filter((run) => (
        this.workflows.get(key(run.tenantId, run.workflowId))?.record.status === 'running'
        &&
        (
          (run.status === 'queued' && (run.sessionId === null || !this.host.sessionHasCommands(run.tenantId, run.sessionId)))
          || (run.status === 'running' && run.sessionId !== null && !this.host.sessionHasCommands(run.tenantId, run.sessionId))
        )
        && run.claimToken === null
      ))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))[0]
    if (retryRun) {
      const workflow = this.requireWorkflow(retryRun.tenantId, retryRun.workflowId)
      retryRun.claimedBy = claimedBy
      retryRun.claimToken = createWorkClaimToken(retryRun.tenantId, retryRun.id, claimedBy)
      retryRun.claimExpiresAt = new Date(now.getTime() + leaseTtlMs).toISOString()
      retryRun.attemptCount += 1
      retryRun.lastErrorCode = null
      retryRun.lastErrorSummary = null
      workflow.record.status = 'running'
      workflow.record.latestRunId = retryRun.id
      workflow.record.latestRunStatus = retryRun.status
      workflow.record.latestRunSessionId = retryRun.sessionId
      workflow.record.updatedAt = claimedAt
      return {
        workflow: clone(workflow.record),
        run: clone(retryRun),
      }
    }
    const workflow = Array.from(this.workflows.values())
      .filter((entry) => (
        entry.record.status === 'active'
        && entry.record.nextRunAt !== null
        && entry.record.nextRunAt <= claimedAt
      ))
      .sort((left, right) => String(left.record.nextRunAt).localeCompare(String(right.record.nextRunAt)))[0]
    if (!workflow) return null
    const scheduledFor = workflow.record.nextRunAt
    this.host.assertWorkflowRunQuota({ tenantId: workflow.record.tenantId, quota: input.quota, now })
    const claimToken = createWorkClaimToken(workflow.record.tenantId, input.runId, claimedBy)
    const plannedSessionId = input.sessionId?.trim() || workflowRunSessionId(workflow.record.tenantId, workflow.record.id, input.runId)
    const run: CloudWorkflowRunRecord = {
      tenantId: workflow.record.tenantId,
      userId: workflow.record.userId,
      id: input.runId,
      workflowId: workflow.record.id,
      sessionId: plannedSessionId,
      triggerType: 'schedule',
      triggerPayload: {
        source: 'schedule',
        scheduledFor,
      },
      status: 'queued',
      title: `Run ${workflow.record.title}`,
      summary: null,
      error: null,
      createdAt: claimedAt,
      startedAt: null,
      finishedAt: null,
      claimedBy,
      claimToken,
      claimExpiresAt: new Date(now.getTime() + leaseTtlMs).toISOString(),
      attemptCount: 1,
      idempotencyKey: `schedule:${workflow.record.id}:${scheduledFor}`,
      checkpointVersion: 0,
      lastErrorCode: null,
      lastErrorSummary: null,
    }
    workflow.runs.push(run)
    this.workflowRuns.set(key(run.tenantId, run.id), run)
    workflow.record.status = 'running'
    workflow.record.latestRunId = run.id
    workflow.record.latestRunStatus = run.status
    workflow.record.latestRunSessionId = run.sessionId
    workflow.record.updatedAt = claimedAt
    return {
      workflow: clone(workflow.record),
      run: clone(run),
    }
  }

  reapExpiredWorkflowClaims(input: ReapExpiredWorkflowClaimsInput = {}): ReapedWorkflowClaimRecord[] {
    const now = input.now || new Date()
    const nowIsoValue = now.toISOString()
    const maxAttempts = Math.max(1, Math.floor(input.maxAttempts ?? 3))
    const limit = Math.max(1, Math.min(1_000, Math.floor(input.limit ?? 100)))
    const reaped: ReapedWorkflowClaimRecord[] = []
    const candidates = Array.from(this.workflowRuns.values())
      .filter((run) => (
        Boolean(run.claimToken) && Boolean(run.claimExpiresAt)
        && Date.parse(run.claimExpiresAt || '') <= now.getTime()
        && (
          (run.status === 'queued' && (run.sessionId === null || !this.host.sessionHasCommands(run.tenantId, run.sessionId)))
          || (run.status === 'running' && run.sessionId !== null && !this.host.sessionHasCommands(run.tenantId, run.sessionId))
        )
      ))
      .sort((left, right) => (
        Date.parse(left.claimExpiresAt || '') - Date.parse(right.claimExpiresAt || '')
        || left.tenantId.localeCompare(right.tenantId) || left.workflowId.localeCompare(right.workflowId) || left.id.localeCompare(right.id)
      ))
      .slice(0, limit)
    for (const run of candidates) {
      const claimToken = run.claimToken
      const workflow = this.workflows.get(key(run.tenantId, run.workflowId))
      if (!workflow || !claimToken) continue
      const claimedBy = run.claimedBy || 'unknown'
      const action: WorkReaperAction = run.attemptCount >= maxAttempts ? 'failed' : 'retried'
      if (action === 'failed') {
        run.status = 'failed'
        run.error = 'Workflow run claim expired after the maximum retry attempts.'
        run.summary = run.error
        run.finishedAt = nowIsoValue
        run.lastErrorCode = 'claim_expired_max_attempts'
        run.lastErrorSummary = run.error
        run.claimedBy = null
        run.claimToken = null
        run.claimExpiresAt = null
        workflow.record.status = 'failed'
        workflow.record.latestRunStatus = 'failed'
        workflow.record.latestRunSummary = run.error
        workflow.record.nextRunAt = null
      } else {
        run.claimedBy = null
        run.claimToken = null
        run.claimExpiresAt = null
        run.lastErrorCode = 'claim_expired'
        run.lastErrorSummary = run.status === 'running'
          ? 'Workflow run claim expired before command enqueue.'
          : 'Workflow run claim expired before session attachment.'
        workflow.record.status = 'running'
        workflow.record.latestRunStatus = run.status
        workflow.record.latestRunSessionId = run.sessionId
      }
      workflow.record.latestRunId = run.id
      workflow.record.updatedAt = nowIsoValue
      reaped.push({
        tenantId: run.tenantId,
        workflowId: run.workflowId,
        runId: run.id,
        claimToken,
        claimedBy,
        action,
        reapedAt: nowIsoValue,
      })
    }
    return reaped
  }

  attachWorkflowRunSession(input: AttachWorkflowRunSessionInput): CloudWorkflowRunRecord | null {
    const workflow = this.requireWorkflow(input.tenantId, input.workflowId)
    const run = this.workflowRuns.get(key(input.tenantId, input.runId))
    if (!run || run.workflowId !== input.workflowId) return null
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      throw new Error('Workflow run is not attachable.')
    }
    if (run.status !== 'queued' && !(run.status === 'running' && run.sessionId === input.sessionId)) {
      throw new Error('Workflow run is not attachable.')
    }
    if (run.sessionId && run.sessionId !== input.sessionId) throw new Error('Workflow run is already attached to another session.')
    if (run.claimToken) {
      if (run.claimToken !== (input.claimToken ?? null)) throw new Error('Workflow run claim is stale.')
      if (run.claimExpiresAt && Date.parse(run.claimExpiresAt) <= Date.now()) throw new Error('Workflow run claim is stale.')
    } else if (input.claimToken) {
      throw new Error('Workflow run claim is stale.')
    }
    const startedAt = nowIso(input.startedAt)
    run.sessionId = input.sessionId
    run.status = 'running'
    run.startedAt ||= startedAt
    run.claimedBy = null
    run.claimToken = null
    run.claimExpiresAt = null
    workflow.record.status = 'running'
    workflow.record.latestRunId = run.id
    workflow.record.latestRunStatus = run.status
    workflow.record.latestRunSessionId = input.sessionId
    workflow.record.updatedAt = startedAt
    return clone(run)
  }

  completeWorkflowRun(input: CompleteWorkflowRunInput): CloudWorkflowRunRecord | null {
    return this.finishWorkflowRun({
      tenantId: input.tenantId,
      workflowId: input.workflowId,
      runId: input.runId,
      status: 'completed',
      summary: input.summary,
      error: null,
      nextStatus: input.nextStatus,
      nextRunAt: input.nextRunAt,
      leaseToken: input.leaseToken,
      finishedAt: input.finishedAt,
    })
  }

  failWorkflowRun(input: FailWorkflowRunInput): CloudWorkflowRunRecord | null {
    return this.finishWorkflowRun({
      tenantId: input.tenantId,
      workflowId: input.workflowId,
      runId: input.runId,
      status: 'failed',
      summary: input.error,
      error: input.error,
      nextStatus: input.nextStatus,
      nextRunAt: input.nextRunAt,
      leaseToken: input.leaseToken,
      finishedAt: input.finishedAt,
    })
  }

  getWorkflowRun(tenantId: string, runId: string): CloudWorkflowRunRecord | null {
    this.host.requireTenant(tenantId)
    return clone(this.workflowRuns.get(key(tenantId, runId)) || null)
  }

  getWorkflowRunBySession(tenantId: string, sessionId: string): CloudWorkflowRunRecord | null {
    this.host.requireTenant(tenantId)
    for (const run of this.workflowRuns.values()) {
      if (run.tenantId === tenantId && run.sessionId === sessionId) return clone(run)
    }
    return null
  }

  private requireWorkflow(tenantId: string, workflowId: string) {
    this.host.requireTenant(tenantId)
    const workflow = this.workflows.get(key(tenantId, workflowId))
    if (!workflow) throw new Error(`Unknown workflow ${workflowId}.`)
    return workflow
  }

  private assertWorkflowRunnable(workflow: CloudWorkflowRecord) {
    if (workflow.status === 'archived') throw new Error('Archived workflows cannot run.')
    if (workflow.status === 'paused') throw new Error('Paused workflows cannot run.')
    if (workflow.status === 'running') throw new Error('Workflow is already running.')
  }

  private finishWorkflowRun(input: {
    tenantId: string
    workflowId: string
    runId: string
    status: Extract<WorkflowRunStatus, 'completed' | 'failed'>
    summary: string | null
    error: string | null
    nextStatus: WorkflowStatus
    nextRunAt: string | null
    leaseToken?: string | null
    finishedAt?: Date
  }) {
    const workflow = this.requireWorkflow(input.tenantId, input.workflowId)
    const run = this.workflowRuns.get(key(input.tenantId, input.runId))
    if (!run || run.workflowId !== input.workflowId) return null
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') return clone(run)
    if (input.leaseToken !== undefined) {
      if (!run.sessionId) throw new Error('Workflow run has no execution session to fence.')
      this.host.assertSessionLease(input.tenantId, run.sessionId, input.leaseToken)
    }
    const finishedAt = nowIso(input.finishedAt)
    run.status = input.status
    run.summary = input.summary
    run.error = input.error
    run.finishedAt = finishedAt
    workflow.record.status = input.nextStatus
    workflow.record.latestRunId = run.id
    workflow.record.latestRunStatus = run.status
    workflow.record.latestRunSummary = input.summary
    workflow.record.lastRunAt = input.status === 'completed' ? finishedAt : workflow.record.lastRunAt
    workflow.record.nextRunAt = input.nextRunAt
    workflow.record.updatedAt = finishedAt
    return clone(run)
  }
}

const WORKFLOW_RUN_LIST_LIMIT = 100
const WORKFLOW_LIST_LIMIT = 500

function workflowRunSessionId(tenantId: string, workflowId: string, runId: string) {
  return stableId('workflow_session', tenantId, workflowId, runId)
}

function stableId(prefix: string, ...parts: string[]) {
  return `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)}`
}

function createWorkClaimToken(tenantId: string, workId: string, claimedBy: string) {
  return stableId('claim', tenantId, workId, claimedBy, randomBytes(16).toString('base64url'))
}
