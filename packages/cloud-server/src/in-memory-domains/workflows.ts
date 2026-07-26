import { createHash, randomBytes } from 'node:crypto'
import { normalizeWorkflowSteps } from '@open-cowork/shared'
import type { WorkflowRunStatus, WorkflowStatus, WorkflowTrigger } from '@open-cowork/shared'
import { clone, key, nowIso } from './store-helpers.ts'
import type {
  AttachWorkflowRunSessionInput,
  ClaimDueWorkflowRunInput,
  ClaimedWorkflowRunRecord,
  CloudWorkflowRecord,
  CloudWorkflowRunRecord,
  CloudWorkflowWebhookSecretRecord,
  CompleteWorkflowRunInput,
  CreateWorkflowInput,
  CreateWorkflowRunInput,
  FailWorkflowRunInput,
  LegacyCloudWorkflowWebhookSecretRecord,
  ListWorkflowRunsForWorkflowsInput,
  ListWorkflowsPageInput,
  ListWorkflowsPageRecord,
  ReapExpiredWorkflowClaimsInput,
  ReapedWorkflowClaimRecord,
  MigrateLegacyWorkflowWebhookSecretInput,
  RotateWorkflowWebhookSecretInput,
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

function publicWorkflowTrigger(value: WorkflowTrigger): WorkflowTrigger {
  const { webhookSecret: _webhookSecret, ...trigger } = value as unknown as Record<string, unknown>
  return trigger as unknown as WorkflowTrigger
}

export type InMemoryWorkflowsSnapshot = {
  workflows: Array<[string, WorkflowState]>
  workflowRuns: Array<[string, CloudWorkflowRunRecord]>
  workflowWebhookSecrets: Array<[string, CloudWorkflowWebhookSecretRecord]>
  legacyWorkflowWebhookSecrets: Array<[string, LegacyCloudWorkflowWebhookSecretRecord]>
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
  private readonly workflowWebhookSecrets = new Map<string, CloudWorkflowWebhookSecretRecord>()
  private readonly legacyWorkflowWebhookSecrets = new Map<string, LegacyCloudWorkflowWebhookSecretRecord>()
  private readonly host: InMemoryWorkflowsHost

  constructor(host: InMemoryWorkflowsHost) {
    this.host = host
  }

  // All run records, for the quota domain's concurrent-run accounting (the only
  // cross-domain reader of this state).
  allRuns(): IterableIterator<CloudWorkflowRunRecord> {
    return this.workflowRuns.values()
  }

  snapshot(): InMemoryWorkflowsSnapshot {
    return {
      workflows: clone([...this.workflows.entries()]),
      workflowRuns: clone([...this.workflowRuns.entries()]),
      workflowWebhookSecrets: clone([...this.workflowWebhookSecrets.entries()]),
      legacyWorkflowWebhookSecrets: clone([...this.legacyWorkflowWebhookSecrets.entries()]),
    }
  }

  restore(snapshot: InMemoryWorkflowsSnapshot) {
    this.workflows.clear()
    this.workflowRuns.clear()
    this.workflowWebhookSecrets.clear()
    this.legacyWorkflowWebhookSecrets.clear()
    for (const [entryKey, value] of clone(snapshot.workflows)) this.workflows.set(entryKey, value)
    for (const [entryKey, value] of clone(snapshot.workflowRuns)) this.workflowRuns.set(entryKey, value)
    for (const [entryKey, value] of clone(snapshot.workflowWebhookSecrets || [])) this.workflowWebhookSecrets.set(entryKey, value)
    for (const [entryKey, value] of clone(snapshot.legacyWorkflowWebhookSecrets || [])) this.legacyWorkflowWebhookSecrets.set(entryKey, value)
  }

  createWorkflow(input: CreateWorkflowInput): CloudWorkflowRecord {
    this.host.requireTenantUser(input.tenantId, input.userId)
    const workflowKey = key(input.tenantId, input.workflowId)
    const existing = this.workflows.get(workflowKey)
    if (existing) {
      if (existing.record.userId !== input.userId) throw new Error(`Unknown workflow ${input.workflowId}.`)
      return clone(existing.record)
    }
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
      triggers: draft.triggers
        .map(publicWorkflowTrigger)
        .map((trigger) => clone(trigger)),
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
    for (const secret of input.webhookSecrets || []) {
      const secretKey = key(input.tenantId, input.workflowId, secret.triggerId)
      this.workflowWebhookSecrets.set(secretKey, {
        tenantId: input.tenantId,
        workflowId: input.workflowId,
        triggerId: secret.triggerId,
        ciphertext: secret.ciphertext,
        envelopeVersion: secret.envelopeVersion,
        status: 'active',
        createdAt,
        updatedAt: createdAt,
      })
    }
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
    const webhookTriggerIds = new Set(
      workflow.record.triggers
        .filter((trigger) => trigger.type === 'webhook')
        .map((trigger) => trigger.id),
    )
    if (
      input.status === 'active'
      && webhookTriggerIds.size > 0
      && !Array.from(this.workflowWebhookSecrets.values()).some((secret) => (
        secret.tenantId === input.tenantId
        && secret.workflowId === input.workflowId
        && webhookTriggerIds.has(secret.triggerId)
        && secret.status === 'active'
      ))
    ) return null
    const updatedAt = nowIso(input.updatedAt)
    if (input.status === 'archived') {
      for (const secret of this.workflowWebhookSecrets.values()) {
        if (
          secret.tenantId !== input.tenantId
          || secret.workflowId !== input.workflowId
          || !webhookTriggerIds.has(secret.triggerId)
          || secret.status !== 'active'
        ) continue
        secret.status = 'revoked'
        secret.updatedAt = updatedAt
      }
      for (const [secretKey, secret] of this.legacyWorkflowWebhookSecrets.entries()) {
        if (secret.tenantId === input.tenantId && secret.workflowId === input.workflowId) {
          this.legacyWorkflowWebhookSecrets.delete(secretKey)
        }
      }
    }
    workflow.record.status = input.status
    workflow.record.nextRunAt = input.nextRunAt ?? null
    workflow.record.updatedAt = updatedAt
    return clone(workflow.record)
  }

  getWorkflowWebhookSecret(tenantId: string, workflowId: string, triggerId?: string): CloudWorkflowWebhookSecretRecord | null {
    const secret = Array.from(this.workflowWebhookSecrets.values())
      .filter((entry) => (
        entry.tenantId === tenantId
        && entry.workflowId === workflowId
        && (!triggerId || entry.triggerId === triggerId)
      ))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.triggerId.localeCompare(right.triggerId))[0]
    return secret ? clone(secret) : null
  }

  rotateWorkflowWebhookSecret(input: RotateWorkflowWebhookSecretInput): CloudWorkflowWebhookSecretRecord | null {
    this.host.requireTenantUser(input.tenantId, input.userId)
    const workflow = this.workflows.get(key(input.tenantId, input.workflowId))
    if (!workflow || workflow.record.userId !== input.userId) return null
    if (!workflow.record.triggers.some((trigger) => trigger.id === input.triggerId && trigger.type === 'webhook')) return null
    const secretKey = key(input.tenantId, input.workflowId, input.triggerId)
    const existing = this.workflowWebhookSecrets.get(secretKey)
    const updatedAt = nowIso(input.updatedAt)
    const next: CloudWorkflowWebhookSecretRecord = {
      tenantId: input.tenantId,
      workflowId: input.workflowId,
      triggerId: input.triggerId,
      ciphertext: input.ciphertext,
      envelopeVersion: input.envelopeVersion,
      status: 'active',
      createdAt: existing?.createdAt || updatedAt,
      updatedAt,
    }
    this.workflowWebhookSecrets.set(secretKey, next)
    this.legacyWorkflowWebhookSecrets.delete(secretKey)
    workflow.record.updatedAt = updatedAt
    return clone(next)
  }

  listLegacyWorkflowWebhookSecrets(limit = 100): LegacyCloudWorkflowWebhookSecretRecord[] {
    return Array.from(this.legacyWorkflowWebhookSecrets.values())
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.workflowId.localeCompare(right.workflowId))
      .slice(0, Math.max(1, Math.min(1_000, Math.floor(limit))))
      .map((record) => clone(record))
  }

  getLegacyWorkflowWebhookSecret(
    tenantId: string,
    workflowId: string,
    triggerId: string,
  ): LegacyCloudWorkflowWebhookSecretRecord | null {
    const secret = this.legacyWorkflowWebhookSecrets.get(key(tenantId, workflowId, triggerId))
    return secret ? clone(secret) : null
  }

  migrateLegacyWorkflowWebhookSecret(input: MigrateLegacyWorkflowWebhookSecretInput): boolean {
    const secretKey = key(input.tenantId, input.workflowId, input.triggerId)
    const legacy = this.legacyWorkflowWebhookSecrets.get(secretKey)
    if (!legacy) return false
    if (legacy.plaintext !== input.expectedPlaintext) return false
    const workflow = this.workflows.get(key(input.tenantId, input.workflowId))
    if (
      !workflow
      || !workflow.record.triggers.some((trigger) => (
        trigger.id === input.triggerId && trigger.type === 'webhook'
      ))
    ) return false
    const targetStatus = workflow.record.status === 'archived' ? 'revoked' : 'active'
    const existing = this.workflowWebhookSecrets.get(secretKey)
    if (input.expectedExistingCiphertext === null) {
      if (existing) return false
    } else if (
      !existing
      || existing.ciphertext !== input.expectedExistingCiphertext
      || existing.envelopeVersion !== input.expectedExistingEnvelopeVersion
      || (targetStatus === 'active' && existing.status !== 'active')
    ) {
      return false
    }
    const migratedAt = nowIso(input.migratedAt)
    this.workflowWebhookSecrets.set(secretKey, {
      tenantId: input.tenantId,
      workflowId: input.workflowId,
      triggerId: input.triggerId,
      ciphertext: input.ciphertext,
      envelopeVersion: input.envelopeVersion,
      status: targetStatus,
      createdAt: existing?.createdAt || migratedAt,
      updatedAt: migratedAt,
    })
    workflow.record.triggers = workflow.record.triggers.map(publicWorkflowTrigger)
    workflow.record.updatedAt = migratedAt
    this.legacyWorkflowWebhookSecrets.delete(secretKey)
    return true
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
