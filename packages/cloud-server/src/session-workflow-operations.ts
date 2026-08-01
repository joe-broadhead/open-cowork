// Workflow orchestration, carved out of the CloudSessionService god class (ARCH
// god-class, P2). Listing/creating/running workflows, claiming due scheduled runs,
// the signed-webhook trigger path, and the run lifecycle (start → complete/fail with
// channel fan-out) all carry real body logic, moved verbatim so behavior is
// byte-identical. CloudSessionService keeps thin delegators for the public API and the
// core command-execution path calls back into completeWorkflowRunForSession /
// failWorkflowRunForSession / workflowSummaryForSession on this collaborator.
// The two cross-cutting session/billing dependencies (createCloudSessionRecord and
// assertBillingAllowed) are passed as callbacks, mirroring how the channel domain
// service is composed. Workflow-draft validation continues to live in
// session-workflow-validation.ts.
import { computeNextWorkflowRunAt } from '@open-cowork/runtime-host/workflow/workflow-schedule'
import { randomBytes } from 'node:crypto'
import {
  verifyWorkflowWebhookAuth,
  WebhookHttpError,
  type WorkflowWebhookAuth,
  type WorkflowWebhookSecurityStore,
} from '@open-cowork/shared/node'
import type {
  WorkflowDetail,
  WorkflowCreateResult,
  WorkflowDraft,
  WorkflowListPayload,
  WorkflowStatus,
  WorkflowTriggerType,
  WorkflowWebhookSecretMutationResult,
} from '@open-cowork/shared'
import { redactSecretText } from '@open-cowork/shared'
import type {
  ClaimedWorkflowRunRecord,
  CloudWorkflowRecord,
  CloudWorkflowRunRecord,
  CompleteWorkflowRunInput,
  ControlPlaneStore,
  FailWorkflowRunInput,
  LegacyCloudWorkflowWebhookSecretRecord,
  SessionCommandRecord,
  SessionRecord,
} from './control-plane-store.ts'
import { InvalidWorkflowPageCursorError } from './control-plane-store.ts'
import { CloudServiceError } from './cloud-service-error.ts'
import { ControlPlaneQuotaExceededError } from './control-plane-errors.ts'
import { type CloudRuntimePolicy } from './cloud-config.ts'
import type { BillingAction } from './billing-adapter.ts'
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
import type { SecretAdapter } from './secret-adapter.ts'
import {
  recordCloudLog,
  recordCloudMetric,
  type CloudObservabilityAdapter,
} from './observability.ts'

const WEBHOOK_SIGNATURE_REPLAY_WINDOW_MS = 5 * 60 * 1000
const WEBHOOK_SIGNATURE_REPLAY_CACHE_LIMIT = 512
const WORKFLOW_WEBHOOK_SECRET_ENVELOPE_VERSION = 1
const WORKFLOW_SECRET_MIGRATION_BATCH_SIZE = 100

function workflowWebhookSecretAad(tenantId: string, workflowId: string, triggerId: string) {
  return `workflow-webhook:${tenantId}:${workflowId}:${triggerId}`
}

function randomWorkflowWebhookSecret() {
  return randomBytes(32).toString('base64url')
}

function workflowWebhookPublicOrigin(value: string | null | undefined) {
  if (!value?.trim()) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Cloud workflow webhook public URL must be a valid HTTP(S) origin.')
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    throw new Error('Cloud workflow webhook public URL must be an HTTP(S) origin without credentials, path, query, or fragment.')
  }
  return url.origin
}

function legacyWorkflowSecretBatchFingerprint(
  records: readonly LegacyCloudWorkflowWebhookSecretRecord[],
) {
  return records
    .map((record) => `${record.tenantId}\0${record.workflowId}\0${record.triggerId}\0${record.updatedAt}`)
    .sort()
    .join('\n')
}

type WorkflowSessionRecordInput = {
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
  secretAdapter: SecretAdapter | null
  observability: CloudObservabilityAdapter | null
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
  private readonly secretAdapter: SecretAdapter | null
  private readonly observability: CloudObservabilityAdapter | null
  private readonly webhookPublicOrigin: string | null

  constructor(options: CloudWorkflowOperationsServiceOptions) {
    this.store = options.store
    this.policy = options.policy
    this.ids = options.ids
    this.usageGovernance = options.usageGovernance
    this.ensurePrincipal = options.ensurePrincipal
    this.principalOrgId = options.principalOrgId
    this.assertBillingAllowed = options.assertBillingAllowed
    this.createCloudSessionRecord = options.createCloudSessionRecord
    this.secretAdapter = options.secretAdapter
    this.observability = options.observability
    this.webhookPublicOrigin = workflowWebhookPublicOrigin(options.policy.publicUrl)
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
      workflows: workflows.map((workflow) => this.workflowSummary(workflow)),
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

  async createWorkflow(principal: CloudPrincipal, draft: WorkflowDraft): Promise<WorkflowCreateResult> {
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
    const webhookTriggers = normalized.triggers.filter((trigger) => trigger.type === 'webhook')
    if (webhookTriggers.length > 1) {
      throw new CloudServiceError(400, 'A workflow can have at most one webhook trigger.')
    }
    const workflowId = this.ids.randomUUID()
    const secret = webhookTriggers[0] ? randomWorkflowWebhookSecret() : null
    const webhookSecrets = webhookTriggers[0] && secret
      ? [{
          triggerId: webhookTriggers[0].id,
          ciphertext: this.protectWebhookSecret(principal.tenantId, workflowId, webhookTriggers[0].id, secret),
          envelopeVersion: WORKFLOW_WEBHOOK_SECRET_ENVELOPE_VERSION,
        }]
      : []
    const workflow = await this.store.createWorkflow({
      tenantId: principal.tenantId,
      userId: principal.userId,
      workflowId,
      draft: normalized,
      webhookSecrets,
      nextRunAt: computeNextWorkflowRunAt(normalized.triggers, now),
      createdAt: now,
    })
    if (webhookSecrets[0]) {
      const storedSecret = await this.store.getWorkflowWebhookSecret(
        principal.tenantId,
        workflowId,
        webhookSecrets[0].triggerId,
      )
      if (
        !storedSecret
        || storedSecret.status !== 'active'
        || storedSecret.envelopeVersion !== webhookSecrets[0].envelopeVersion
        || storedSecret.ciphertext !== webhookSecrets[0].ciphertext
      ) {
        throw new CloudServiceError(409, 'Workflow creation conflicted with an existing workflow.')
      }
    }
    return {
      workflow: await this.workflowDetail(workflow),
      webhookSecretReveal: webhookTriggers[0] && secret
        ? {
            workflowId,
            triggerId: webhookTriggers[0].id,
            secret,
          }
        : null,
    }
  }

  async rotateWorkflowWebhookSecret(
    principal: CloudPrincipal,
    workflowId: string,
  ): Promise<WorkflowWebhookSecretMutationResult | null> {
    await this.ensurePrincipal(principal)
    this.assertWorkflowsEnabled()
    const workflow = await this.store.getWorkflow(principal.tenantId, principal.userId, workflowId)
    if (!workflow) return null
    const webhook = workflow.triggers.find((trigger) => trigger.type === 'webhook')
    if (!webhook) return null
    const secret = randomWorkflowWebhookSecret()
    const stored = await this.store.rotateWorkflowWebhookSecret({
      tenantId: principal.tenantId,
      userId: principal.userId,
      workflowId,
      triggerId: webhook.id,
      ciphertext: this.protectWebhookSecret(principal.tenantId, workflowId, webhook.id, secret),
      envelopeVersion: WORKFLOW_WEBHOOK_SECRET_ENVELOPE_VERSION,
    })
    if (!stored) return null
    const updated = await this.store.getWorkflow(principal.tenantId, principal.userId, workflowId)
    if (!updated) return null
    return {
      workflow: await this.workflowDetail(updated),
      webhookSecretReveal: {
        workflowId,
        triggerId: webhook.id,
        secret,
      },
    }
  }

  async migrateLegacyWebhookSecrets() {
    let migrated = 0
    let stalledBatchFingerprint: string | null = null
    while (true) {
      const candidates = await this.store.listLegacyWorkflowWebhookSecrets(WORKFLOW_SECRET_MIGRATION_BATCH_SIZE)
      if (candidates.length === 0) {
        if (migrated === 0) await this.observeWorkflowSecretMigrationBatch('ok', 0)
        return { migrated }
      }
      let migratedThisBatch = 0
      try {
        for (const candidate of candidates) {
          if (await this.migrateLegacyWebhookSecret(candidate)) {
            migrated += 1
            migratedThisBatch += 1
          }
        }
      } catch {
        await this.observeWorkflowSecretMigrationBatch('error', migratedThisBatch)
        throw new CloudServiceError(
          503,
          'Workflow webhook secret migration failed; unprocessed legacy records remain unchanged.',
        )
      }
      if (migratedThisBatch === 0) {
        const remaining = await this.store.listLegacyWorkflowWebhookSecrets(WORKFLOW_SECRET_MIGRATION_BATCH_SIZE)
        if (remaining.length === 0) {
          await this.observeWorkflowSecretMigrationBatch('ok', 0)
          return { migrated }
        }
        const fingerprint = legacyWorkflowSecretBatchFingerprint(remaining)
        if (fingerprint !== stalledBatchFingerprint) {
          stalledBatchFingerprint = fingerprint
          continue
        }
        await this.observeWorkflowSecretMigrationBatch('error', 0)
        throw new CloudServiceError(
          503,
          'Workflow webhook secret migration could not make progress; legacy records remain unchanged.',
        )
      }
      stalledBatchFingerprint = null
      await this.observeWorkflowSecretMigrationBatch('ok', migratedThisBatch)
    }
  }

  private async migrateLegacyWebhookSecret(
    candidate: LegacyCloudWorkflowWebhookSecretRecord,
  ) {
    const existing = await this.store.getWorkflowWebhookSecret(
      candidate.tenantId,
      candidate.workflowId,
      candidate.triggerId,
    )
    // The legacy plaintext is the only value migration can prove remains
    // usable. Always protect it with the current adapter and atomically replace
    // any expected envelope; never decrypt an unknown/retired envelope merely
    // to decide whether it can be reused.
    const ciphertext = this.protectWebhookSecret(
      candidate.tenantId,
      candidate.workflowId,
      candidate.triggerId,
      candidate.plaintext,
    )
    return this.store.migrateLegacyWorkflowWebhookSecret({
      tenantId: candidate.tenantId,
      workflowId: candidate.workflowId,
      triggerId: candidate.triggerId,
      expectedPlaintext: candidate.plaintext,
      expectedExistingCiphertext: existing?.ciphertext || null,
      expectedExistingEnvelopeVersion: existing?.envelopeVersion || null,
      ciphertext,
      envelopeVersion: WORKFLOW_WEBHOOK_SECRET_ENVELOPE_VERSION,
    })
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
    if (
      !updated
      && status === 'active'
      && current.triggers.some((trigger) => trigger.type === 'webhook')
    ) {
      throw new CloudServiceError(
        409,
        'Rotate the workflow webhook secret before activating this workflow.',
      )
    }
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
    )) || null
    let secretRecord = workflow?.status === 'active' && webhook
      ? await this.store.getWorkflowWebhookSecret(workflow.tenantId, workflow.id, webhook.id)
      : null
    if (workflow?.status === 'active' && webhook && !secretRecord) {
      // Rolling-deploy compatibility: an older writer may have committed a
      // legacy trigger after this process completed startup migration.
      const legacy = await this.store.getLegacyWorkflowWebhookSecret(
        workflow.tenantId,
        workflow.id,
        webhook.id,
      )
      if (legacy) {
        try {
          await this.migrateLegacyWebhookSecret(legacy)
        } catch {
          throw new WebhookHttpError(503, 'Workflow webhook authorization is temporarily unavailable.')
        }
        secretRecord = await this.store.getWorkflowWebhookSecret(
          workflow.tenantId,
          workflow.id,
          webhook.id,
        )
      }
    }
    if (
      !workflow
      || workflow.status !== 'active'
      || !webhook
      || !secretRecord
      || secretRecord.triggerId !== webhook.id
      || secretRecord.status !== 'active'
    ) {
      throw new WebhookHttpError(401, 'Workflow webhook authorization failed.')
    }
    let secret: string
    try {
      secret = this.revealWebhookSecret(secretRecord)
    } catch {
      throw new WebhookHttpError(503, 'Workflow webhook authorization is temporarily unavailable.')
    }
    if (!verifyWorkflowWebhookAuth(input.auth, secret, input.now || new Date())) {
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
      ...this.workflowSummary(workflow),
      runs: (await this.store.listWorkflowRuns(workflow.tenantId, workflow.id, 25)).map(toWorkflowRun),
    }
  }

  private workflowSummary(workflow: CloudWorkflowRecord) {
    const summary = toWorkflowSummary(workflow)
    const hasWebhook = summary.triggers.some((trigger) => trigger.type === 'webhook')
    return {
      ...summary,
      webhookUrl: hasWebhook && this.webhookPublicOrigin
        ? `${this.webhookPublicOrigin}/webhooks/workflows/${encodeURIComponent(workflow.id)}`
        : null,
    }
  }

  private protectWebhookSecret(tenantId: string, workflowId: string, triggerId: string, secret: string) {
    if (!this.secretAdapter || this.secretAdapter.mode !== 'envelope-v1') {
      throw new CloudServiceError(503, 'Workflow webhooks require envelope-encrypted Cloud secret storage.')
    }
    return this.secretAdapter.protect(secret, workflowWebhookSecretAad(tenantId, workflowId, triggerId))
  }

  private async observeWorkflowSecretMigrationBatch(
    status: 'ok' | 'error',
    migratedRecords: number,
  ) {
    const attributes = {
      operation: 'legacy_migration_batch',
      status,
    }
    await Promise.all([
      recordCloudMetric(this.observability, {
        name: 'open_cowork_cloud_workflow_secret_operations_total',
        value: 1,
        unit: '1',
        attributes,
      }),
      recordCloudMetric(this.observability, {
        name: 'open_cowork_cloud_workflow_secret_records_total',
        value: migratedRecords,
        unit: '1',
        attributes,
      }),
      status === 'error'
        ? recordCloudLog(this.observability, {
            level: 'error',
            name: 'cloud.workflow_secrets.operation_failed',
            message: 'Workflow webhook secret migration batch failed.',
            attributes: {
              ...attributes,
              migrated_records: migratedRecords,
            },
          })
        : Promise.resolve(),
    ])
  }

  private revealWebhookSecret(secret: {
    tenantId: string
    workflowId: string
    triggerId: string
    ciphertext: string
    envelopeVersion: number
  }) {
    if (
      !this.secretAdapter
      || this.secretAdapter.mode !== 'envelope-v1'
      || secret.envelopeVersion !== WORKFLOW_WEBHOOK_SECRET_ENVELOPE_VERSION
    ) {
      throw new Error('Workflow webhook secret storage is unavailable.')
    }
    return this.secretAdapter.reveal(
      secret.ciphertext,
      workflowWebhookSecretAad(secret.tenantId, secret.workflowId, secret.triggerId),
    )
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
        ...this.workflowSummary(workflow),
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

  async workflowSummaryForSession(tenantId: string, sessionId: string) {
    const projection = await this.store.getSessionProjection(tenantId, sessionId)
    const messages = asRecord(projection?.view).messages
    const assistant = Array.isArray(messages)
      ? messages.slice().reverse().find((message) => asRecord(message).role === 'assistant')
      : null
    const content = assistant ? readString(asRecord(assistant).content) : ''
    return content ? content.slice(0, 500) : null
  }

  async completeWorkflowRunForSession(
    tenantId: string,
    sessionId: string,
    summary: string | null,
    leaseToken?: string | null,
  ) {
    const completion = await this.prepareWorkflowRunCompletion(tenantId, sessionId, summary, leaseToken)
    if (!completion) return
    await this.store.completeWorkflowRun(completion)
    await this.publishWorkflowRunCompletion(sessionId, completion)
  }

  async prepareWorkflowRunCompletion(
    tenantId: string,
    sessionId: string,
    summary: string | null,
    leaseToken?: string | null,
  ): Promise<CompleteWorkflowRunInput | null> {
    const run = await this.store.getWorkflowRunBySession(tenantId, sessionId)
    if (!run || (workflowRunTerminal(run.status) && run.status !== 'completed')) return null
    const workflow = await this.store.getWorkflowForTenant(tenantId, run.workflowId)
    if (!workflow) return null
    const now = run.status === 'completed' && run.finishedAt ? new Date(run.finishedAt) : new Date()
    const nextStatus = this.nextWorkflowStatusAfterRun(workflow)
    return {
      tenantId,
      workflowId: workflow.id,
      runId: run.id,
      summary: run.status === 'completed' ? run.summary : summary,
      nextStatus,
      nextRunAt: nextStatus === 'active' ? computeNextWorkflowRunAt(workflow.triggers, now) : null,
      leaseToken,
      finishedAt: now,
    }
  }

  async publishWorkflowRunCompletion(sessionId: string, completion: CompleteWorkflowRunInput) {
    const finishedAt = completion.finishedAt || new Date()
    await this.enqueueWorkflowChannelDeliveries(completion.tenantId, sessionId, {
      eventType: 'workflow.completed',
      workflowId: completion.workflowId,
      runId: completion.runId,
      status: 'completed',
      summary: completion.summary,
      finishedAt: finishedAt.toISOString(),
    })
  }

  async failWorkflowRunForSession(
    tenantId: string,
    sessionId: string,
    error: string,
    leaseToken?: string | null,
  ) {
    const failure = await this.prepareWorkflowRunFailure(tenantId, sessionId, error, leaseToken)
    if (!failure) return
    await this.store.failWorkflowRun(failure)
    await this.publishWorkflowRunFailure(sessionId, failure)
  }

  async prepareWorkflowRunFailure(
    tenantId: string,
    sessionId: string,
    error: string,
    leaseToken?: string | null,
  ): Promise<FailWorkflowRunInput | null> {
    const run = await this.store.getWorkflowRunBySession(tenantId, sessionId)
    if (!run || (workflowRunTerminal(run.status) && run.status !== 'failed')) return null
    const workflow = await this.store.getWorkflowForTenant(tenantId, run.workflowId)
    if (!workflow) return null
    const now = run.status === 'failed' && run.finishedAt ? new Date(run.finishedAt) : new Date()
    const nextStatus = this.nextWorkflowStatusAfterRun(workflow)
    const safeError = redactSecretText(run.status === 'failed' ? run.error || error : error, 1_000)
    return {
      tenantId,
      workflowId: workflow.id,
      runId: run.id,
      error: safeError,
      nextStatus,
      nextRunAt: nextStatus === 'active' ? computeNextWorkflowRunAt(workflow.triggers, now) : null,
      leaseToken,
      finishedAt: now,
    }
  }

  async publishWorkflowRunFailure(sessionId: string, failure: FailWorkflowRunInput) {
    const finishedAt = failure.finishedAt || new Date()
    await this.enqueueWorkflowChannelDeliveries(failure.tenantId, sessionId, {
      eventType: 'workflow.failed',
      workflowId: failure.workflowId,
      runId: failure.runId,
      status: 'failed',
      error: failure.error,
      finishedAt: finishedAt.toISOString(),
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
