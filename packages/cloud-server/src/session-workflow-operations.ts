// Workflow orchestration, carved out of the CloudSessionService god class (ARCH
// god-class, P2). Listing/creating/running workflows, claiming due scheduled runs,
// the signed-webhook trigger path, and the run lifecycle (start → complete/fail with
// channel fan-out) all carry real body logic, moved verbatim so behavior is
// byte-identical. CloudSessionService keeps thin delegators for the public API and the
// core command-execution path calls back into completeWorkflowRunForSession /
// failWorkflowRunForSession / workflowSummaryFromRuntimeEvents on this collaborator.
// The two cross-cutting session/billing dependencies (createCloudSessionRecord and
// assertBillingAllowed) are passed as callbacks, mirroring how the channel domain
// service is composed. Workflow-draft validation continues to live in
// session-workflow-validation.ts.
import { computeNextWorkflowRunAt } from '@open-cowork/runtime-host/workflow/workflow-schedule'
import {
  verifyWorkflowWebhookAuth,
  WebhookHttpError,
  type WorkflowWebhookAuth,
  type WorkflowWebhookSecurityStore,
} from '@open-cowork/shared/node'
import type {
  WorkflowDetail,
  WorkflowDraft,
  WorkflowListPayload,
  WorkflowStatus,
  WorkflowTriggerType,
} from '@open-cowork/shared'
import type {
  ClaimedWorkflowRunRecord,
  CloudWorkflowRecord,
  CloudWorkflowRunRecord,
  ControlPlaneStore,
  SessionCommandRecord,
  SessionRecord,
} from './control-plane-store.ts'
import { InvalidWorkflowPageCursorError } from './control-plane-store.ts'
import { CloudServiceError } from './cloud-service-error.ts'
import { ControlPlaneQuotaExceededError } from './control-plane-errors.ts'
import { type CloudRuntimePolicy } from './cloud-config.ts'
import type { BillingAction } from './billing-adapter.ts'
import type { CloudRuntimeEvent } from './runtime-adapter.ts'
import type { CloudUsageGovernanceService } from './services/usage-governance-service.ts'
import {
  toWorkflowRun,
  toWorkflowSummary,
  workflowRunTerminal,
  workflowWebhookReplayKey,
} from './session-workflow-mappers.ts'
import {
  assertWorkflowDraftAllowed,
  normalizeWorkflowDraft,
  WORKFLOW_VALID_TRIGGER_TYPES,
} from './session-workflow-validation.ts'
import {
  asRecord,
  normalizedCloudListLimit,
  readString,
  stableCloudId,
} from './session-input-validation.ts'
import type { CloudPrincipal, CloudWorkflowStartResult } from './session-service.ts'

const WEBHOOK_SIGNATURE_REPLAY_WINDOW_MS = 5 * 60 * 1000
const WEBHOOK_SIGNATURE_REPLAY_CACHE_LIMIT = 512

export type WorkflowSessionRecordInput = {
  tenantId: string
  userId: string
  orgId?: string | null
  accountId?: string | null
  profileName: string
  sessionId?: string | null
  title?: string | null
  deferRuntime?: boolean
}

export type CloudWorkflowOperationsServiceOptions = {
  store: ControlPlaneStore
  policy: CloudRuntimePolicy
  ids: { randomUUID: () => string }
  usageGovernance: CloudUsageGovernanceService
  ensurePrincipal: (principal: CloudPrincipal) => Promise<unknown> | unknown
  principalOrgId: (principal: CloudPrincipal) => string
  assertBillingAllowed: (input: {
    orgId: string
    action: BillingAction
    profileName?: string | null
    providerId?: string | null
  }) => Promise<void>
  createCloudSessionRecord: (input: WorkflowSessionRecordInput) => Promise<SessionRecord>
}

export class CloudWorkflowOperationsService {
  private readonly store: ControlPlaneStore
  private readonly policy: CloudRuntimePolicy
  private readonly ids: { randomUUID: () => string }
  private readonly usageGovernance: CloudUsageGovernanceService
  private readonly ensurePrincipal: CloudWorkflowOperationsServiceOptions['ensurePrincipal']
  private readonly principalOrgId: CloudWorkflowOperationsServiceOptions['principalOrgId']
  private readonly assertBillingAllowed: CloudWorkflowOperationsServiceOptions['assertBillingAllowed']
  private readonly createCloudSessionRecord: CloudWorkflowOperationsServiceOptions['createCloudSessionRecord']

  constructor(options: CloudWorkflowOperationsServiceOptions) {
    this.store = options.store
    this.policy = options.policy
    this.ids = options.ids
    this.usageGovernance = options.usageGovernance
    this.ensurePrincipal = options.ensurePrincipal
    this.principalOrgId = options.principalOrgId
    this.assertBillingAllowed = options.assertBillingAllowed
    this.createCloudSessionRecord = options.createCloudSessionRecord
  }

  async listWorkflows(principal: CloudPrincipal, input: { limit?: number | null, cursor?: string | null } = {}): Promise<WorkflowListPayload> {
    await this.ensurePrincipal(principal)
    this.assertWorkflowsEnabled()
    let page
    try {
      page = await this.store.listWorkflowsPage({
        tenantId: principal.tenantId,
        userId: principal.userId,
        limit: normalizedCloudListLimit(input.limit),
        cursor: input.cursor,
      })
    } catch (error) {
      if (error instanceof InvalidWorkflowPageCursorError) {
        throw new CloudServiceError(400, 'Workflow list cursor is invalid.', {
          policyCode: 'workflows.cursor.invalid',
        })
      }
      throw error
    }
    const workflows = page.items
    const runs = await this.store.listWorkflowRunsForWorkflows({
      tenantId: principal.tenantId,
      userId: principal.userId,
      workflowIds: workflows.map((workflow) => workflow.id),
      limitPerWorkflow: 25,
      limit: 100,
    })
    return {
      workflows: workflows.map(toWorkflowSummary),
      runs: runs.map(toWorkflowRun),
      nextCursor: page.nextCursor,
      totalEstimate: page.totalEstimate,
    }
  }

  async getWorkflow(principal: CloudPrincipal, workflowId: string): Promise<WorkflowDetail | null> {
    await this.ensurePrincipal(principal)
    this.assertWorkflowsEnabled()
    const workflow = await this.store.getWorkflow(principal.tenantId, principal.userId, workflowId)
    return workflow ? this.workflowDetail(workflow) : null
  }

  async createWorkflow(principal: CloudPrincipal, draft: WorkflowDraft): Promise<WorkflowDetail> {
    await this.ensurePrincipal(principal)
    this.assertWorkflowsEnabled()
    const now = new Date()
    let normalized: WorkflowDraft
    try {
      normalized = normalizeWorkflowDraft(draft, this.ids, now)
    } catch (error) {
      throw new CloudServiceError(400, error instanceof Error ? error.message : 'Workflow draft is invalid.')
    }
    assertWorkflowDraftAllowed(normalized, this.policy)
    const workflow = await this.store.createWorkflow({
      tenantId: principal.tenantId,
      userId: principal.userId,
      workflowId: this.ids.randomUUID(),
      draft: normalized,
      nextRunAt: computeNextWorkflowRunAt(normalized.triggers, now),
      createdAt: now,
    })
    return this.workflowDetail(workflow)
  }

  async updateWorkflowStatus(
    principal: CloudPrincipal,
    workflowId: string,
    status: WorkflowStatus,
  ): Promise<WorkflowDetail | null> {
    await this.ensurePrincipal(principal)
    this.assertWorkflowsEnabled()
    if (status !== 'active' && status !== 'paused' && status !== 'archived') {
      throw new Error('Cloud workflow status updates must be active, paused, or archived.')
    }
    const current = await this.store.getWorkflow(principal.tenantId, principal.userId, workflowId)
    if (!current) return null
    const now = new Date()
    const updated = await this.store.updateWorkflowStatus({
      tenantId: principal.tenantId,
      userId: principal.userId,
      workflowId,
      status,
      nextRunAt: status === 'active' ? computeNextWorkflowRunAt(current.triggers, now) : null,
      updatedAt: now,
    })
    return updated ? this.workflowDetail(updated) : null
  }

  private async assertWorkflowExecutionStartAllowed(tenantId: string, orgId: string) {
    await this.assertBillingAllowed({
      orgId,
      action: 'worker.execute',
      profileName: this.policy.profileName,
    })
    try {
      await this.store.assertSessionCommandQueueQuota({
        tenantId,
        quota: await this.usageGovernance.commandQueueQuotaForOrg(orgId),
      })
    } catch (error) {
      this.usageGovernance.translateQuotaError(error, 'Cloud command queue is full.', 'quota.queued_commands_exceeded')
    }
  }

  async runWorkflow(
    principal: CloudPrincipal,
    workflowId: string,
    input: {
      triggerType?: WorkflowTriggerType
      triggerPayload?: Record<string, unknown> | null
    } = {},
  ): Promise<CloudWorkflowStartResult> {
    await this.ensurePrincipal(principal)
    this.assertWorkflowsEnabled()
    const workflow = await this.store.getWorkflow(principal.tenantId, principal.userId, workflowId)
    if (!workflow) throw new Error(`Unknown workflow ${workflowId}.`)
    const triggerType = input.triggerType || 'manual'
    if (!WORKFLOW_VALID_TRIGGER_TYPES.has(triggerType)) throw new Error('Workflow trigger type is invalid.')
    const orgId = this.principalOrgId(principal)
    await this.assertWorkflowExecutionStartAllowed(principal.tenantId, orgId)
    let run: CloudWorkflowRunRecord
    try {
      run = await this.store.createWorkflowRun({
        tenantId: principal.tenantId,
        userId: principal.userId,
        workflowId,
        runId: this.ids.randomUUID(),
        triggerType,
        triggerPayload: input.triggerPayload || null,
        claimedBy: `workflow-api:${principal.userId}`,
        quota: await this.usageGovernance.workflowRunQuotaForOrg(orgId),
      })
    } catch (error) {
      this.usageGovernance.translateQuotaError(error, 'Cloud workflow run quota exceeded.', 'quota.workflow_runs_per_hour_exceeded')
    }
    return this.startWorkflowRun(workflow, run)
  }

  async claimAndStartDueWorkflow(now = new Date(), claimedBy?: string | null): Promise<CloudWorkflowStartResult | null> {
    this.assertWorkflowsEnabled()
    let claimed: ClaimedWorkflowRunRecord | null
    try {
      claimed = await this.store.claimDueWorkflowRun({
        runId: this.ids.randomUUID(),
        claimedBy,
        now,
        quota: this.usageGovernance.workflowRunDefaultQuota(),
      })
    } catch (error) {
      if (error instanceof ControlPlaneQuotaExceededError) return null
      throw error
    }
    if (!claimed) return null
    return this.startClaimedWorkflowRun(claimed)
  }

  async runWorkflowWebhook(input: {
    workflowId: string
    auth: WorkflowWebhookAuth
    payload: Record<string, unknown>
    securityStore: WorkflowWebhookSecurityStore
    now?: Date
  }): Promise<CloudWorkflowStartResult> {
    this.assertWorkflowsEnabled()
    if (!this.policy.features.webhooks) {
      throw new WebhookHttpError(404, 'Workflow webhook was not found.')
    }
    if (input.auth.kind !== 'signature') {
      throw new WebhookHttpError(401, 'Workflow webhook signature authorization is required.')
    }
    const workflow = await this.store.findWorkflow(input.workflowId)
    const webhook = workflow?.triggers.find((trigger) => (
      trigger.enabled
      && trigger.type === 'webhook'
      && typeof trigger.webhookSecret === 'string'
      && verifyWorkflowWebhookAuth(input.auth, trigger.webhookSecret, input.now || new Date())
    ))
    if (!workflow || !webhook) {
      throw new WebhookHttpError(401, 'Workflow webhook authorization failed.')
    }
    const replayClaim = await input.securityStore.claimSignature({
      key: workflowWebhookReplayKey(workflow.id, input.auth),
      nowMs: (input.now || new Date()).getTime(),
      windowMs: WEBHOOK_SIGNATURE_REPLAY_WINDOW_MS,
      cacheLimit: WEBHOOK_SIGNATURE_REPLAY_CACHE_LIMIT,
    })
    if (!replayClaim) throw new WebhookHttpError(401, 'Workflow webhook authorization failed.')
    try {
      const org = await this.store.ensureOrgForTenant({ tenantId: workflow.tenantId, name: workflow.tenantId })
      await this.assertWorkflowExecutionStartAllowed(workflow.tenantId, org.orgId)
      let run: CloudWorkflowRunRecord
      try {
        run = await this.store.createWorkflowRun({
          tenantId: workflow.tenantId,
          userId: workflow.userId,
          workflowId: workflow.id,
          runId: this.ids.randomUUID(),
          triggerType: 'webhook',
          triggerPayload: input.payload,
          claimedBy: `workflow-webhook:${workflow.id}`,
          quota: await this.usageGovernance.workflowRunQuotaForOrg(org.orgId),
        })
      } catch (error) {
        this.usageGovernance.translateQuotaError(error, 'Cloud workflow run quota exceeded.', 'quota.workflow_runs_per_hour_exceeded')
      }
      const started = await this.startWorkflowRun(workflow, run)
      await replayClaim.accept()
      return started
    } catch (error) {
      await replayClaim.release()
      throw error
    }
  }

  private async workflowDetail(workflow: CloudWorkflowRecord): Promise<WorkflowDetail> {
    return {
      ...toWorkflowSummary(workflow),
      runs: (await this.store.listWorkflowRuns(workflow.tenantId, workflow.id, 25)).map(toWorkflowRun),
    }
  }

  private async startClaimedWorkflowRun(claimed: ClaimedWorkflowRunRecord): Promise<CloudWorkflowStartResult | null> {
    try {
      return await this.startWorkflowRun(claimed.workflow, claimed.run)
    } catch (error) {
      if (error instanceof CloudServiceError && (error.status === 402 || error.status === 429)) {
        const now = new Date()
        const nextStatus = this.nextWorkflowStatusAfterRun(claimed.workflow)
        await this.store.failWorkflowRun({
          tenantId: claimed.workflow.tenantId,
          workflowId: claimed.workflow.id,
          runId: claimed.run.id,
          error: error.message,
          nextStatus,
          nextRunAt: nextStatus === 'active' ? computeNextWorkflowRunAt(claimed.workflow.triggers, now) : null,
          finishedAt: now,
        })
        return null
      }
      throw error
    }
  }

  private async startWorkflowRun(
    workflow: CloudWorkflowRecord,
    run: CloudWorkflowRunRecord,
  ): Promise<CloudWorkflowStartResult> {
    const org = await this.store.ensureOrgForTenant({ tenantId: workflow.tenantId, name: workflow.tenantId })
    await this.assertWorkflowExecutionStartAllowed(workflow.tenantId, org.orgId)
    const session = await this.createCloudSessionRecord({
      tenantId: workflow.tenantId,
      userId: workflow.userId,
      sessionId: run.sessionId || undefined,
      profileName: this.policy.profileName,
      title: `Run ${workflow.title}`,
    })
    const attached = await this.store.attachWorkflowRunSession({
      tenantId: workflow.tenantId,
      workflowId: workflow.id,
      runId: run.id,
      sessionId: session.sessionId,
      claimToken: run.claimToken,
    })
    let command: SessionCommandRecord
    try {
      command = await this.store.enqueueSessionCommand({
        commandId: this.workflowPromptCommandId(workflow, run),
        tenantId: workflow.tenantId,
        userId: workflow.userId,
        sessionId: session.sessionId,
        kind: 'prompt',
        payload: {
          text: workflow.instructions,
          agent: workflow.agentName,
        },
        quota: await this.usageGovernance.commandQueueQuotaForOrg(org.orgId),
      })
    } catch (error) {
      if (error instanceof ControlPlaneQuotaExceededError) {
        const now = new Date()
        const nextStatus = this.nextWorkflowStatusAfterRun(workflow)
        await this.store.failWorkflowRun({
          tenantId: workflow.tenantId,
          workflowId: workflow.id,
          runId: run.id,
          error: error.publicMessage || 'Cloud command queue is full.',
          nextStatus,
          nextRunAt: nextStatus === 'active' ? computeNextWorkflowRunAt(workflow.triggers, now) : null,
          finishedAt: now,
        })
      }
      this.usageGovernance.translateQuotaError(error, 'Cloud command queue is full.', 'quota.queued_commands_exceeded')
    }
    await this.usageGovernance.recordUsage({
      orgId: org.orgId,
      accountId: workflow.userId,
      eventType: 'work.queued',
      unit: 'count',
      metadata: {
        tenantId: workflow.tenantId,
        sessionId: session.sessionId,
        workflowId: workflow.id,
        runId: run.id,
        commandId: command.commandId,
        commandKind: command.kind,
        source: `workflow:${run.triggerType}`,
      },
    })
    const updatedWorkflow = await this.store.getWorkflowForTenant(workflow.tenantId, workflow.id)
    return {
      tenantId: workflow.tenantId,
      workflow: updatedWorkflow ? await this.workflowDetail(updatedWorkflow) : {
        ...toWorkflowSummary(workflow),
        runs: [toWorkflowRun(attached || run)],
      },
      run: toWorkflowRun(attached || run),
      sessionId: session.sessionId,
      command,
    }
  }

  private workflowPromptCommandId(workflow: CloudWorkflowRecord, run: CloudWorkflowRunRecord) {
    return `workflow:${workflow.tenantId}:${workflow.id}:${run.id}:prompt`
  }

  workflowSummaryFromRuntimeEvents(events: CloudRuntimeEvent[]) {
    const assistant = events
      .slice()
      .reverse()
      .find((event) => event.type === 'assistant.message')
    const content = assistant ? readString(asRecord(assistant.payload).content) : ''
    return content ? content.slice(0, 500) : null
  }

  async completeWorkflowRunForSession(
    tenantId: string,
    sessionId: string,
    summary: string | null,
    leaseToken?: string | null,
  ) {
    const run = await this.store.getWorkflowRunBySession(tenantId, sessionId)
    if (!run || workflowRunTerminal(run.status)) return
    const workflow = await this.store.getWorkflowForTenant(tenantId, run.workflowId)
    if (!workflow) return
    const now = new Date()
    const nextStatus = this.nextWorkflowStatusAfterRun(workflow)
    await this.store.completeWorkflowRun({
      tenantId,
      workflowId: workflow.id,
      runId: run.id,
      summary,
      nextStatus,
      nextRunAt: nextStatus === 'active' ? computeNextWorkflowRunAt(workflow.triggers, now) : null,
      leaseToken,
      finishedAt: now,
    })
    await this.enqueueWorkflowChannelDeliveries(tenantId, sessionId, {
      eventType: 'workflow.completed',
      workflowId: workflow.id,
      runId: run.id,
      status: 'completed',
      summary,
      finishedAt: now.toISOString(),
    })
  }

  async failWorkflowRunForSession(
    tenantId: string,
    sessionId: string,
    error: string,
    leaseToken?: string | null,
  ) {
    const run = await this.store.getWorkflowRunBySession(tenantId, sessionId)
    if (!run || workflowRunTerminal(run.status)) return
    const workflow = await this.store.getWorkflowForTenant(tenantId, run.workflowId)
    if (!workflow) return
    const now = new Date()
    const nextStatus = this.nextWorkflowStatusAfterRun(workflow)
    await this.store.failWorkflowRun({
      tenantId,
      workflowId: workflow.id,
      runId: run.id,
      error,
      nextStatus,
      nextRunAt: nextStatus === 'active' ? computeNextWorkflowRunAt(workflow.triggers, now) : null,
      leaseToken,
      finishedAt: now,
    })
    await this.enqueueWorkflowChannelDeliveries(tenantId, sessionId, {
      eventType: 'workflow.failed',
      workflowId: workflow.id,
      runId: run.id,
      status: 'failed',
      error,
      finishedAt: now.toISOString(),
    })
  }

  private nextWorkflowStatusAfterRun(workflow: CloudWorkflowRecord): WorkflowStatus {
    return workflow.status === 'paused' || workflow.status === 'archived'
      ? workflow.status
      : 'active'
  }

  private async enqueueWorkflowChannelDeliveries(
    tenantId: string,
    sessionId: string,
    input: {
      eventType: string
      workflowId: string
      runId: string
      status: string
      summary?: string | null
      error?: string | null
      finishedAt: string
    },
  ) {
    const org = await this.store.ensureOrgForTenant({ tenantId, name: tenantId })
    const bindings = await this.store.listChannelSessionBindingsForSession(org.orgId, sessionId)
    await Promise.all(bindings.map((binding) => this.store.createChannelDelivery({
      deliveryId: stableCloudId('channel_delivery', org.orgId, input.eventType, input.runId, binding.bindingId),
      orgId: org.orgId,
      agentId: binding.agentId,
      channelBindingId: binding.channelBindingId,
      sessionBindingId: binding.bindingId,
      provider: binding.provider,
      target: {
        externalChatId: binding.externalChatId,
        externalThreadId: binding.externalThreadId,
        lastChatMessageId: binding.lastChatMessageId,
      },
      eventType: input.eventType,
      payload: {
        workflowId: input.workflowId,
        runId: input.runId,
        sessionId,
        status: input.status,
        summary: input.summary || null,
        error: input.error || null,
        finishedAt: input.finishedAt,
      },
    })))
  }

  private assertWorkflowsEnabled() {
    if (!this.policy.features.workflows) {
      throw new Error('Workflows are disabled for this cloud profile.')
    }
  }
}
