// Session command execution engine + runtime-event application, carved out of the
// CloudSessionService god class (ARCH god-class). Owns the enqueue* command producers,
// the worker-side executeCommand dispatcher and its per-kind execute*Command handlers,
// runtime-event projection (appendRuntimeEvent), and session-record creation/binding
// (createCloudSessionRecord and helpers). Moved verbatim so behavior is byte-identical;
// CloudSessionService keeps thin delegators and owns appendProjectedEvent (which composes
// projections + coordination dispatch) that this engine calls back into.
import { CloudServiceError } from './cloud-service-error.ts'
import type {
  ControlPlaneStore,
  SessionCommandRecord,
  SessionEventRecord,
  SessionRecord,
  WorkerLeaseRecord,
} from './control-plane-store.ts'
import type {
  CloudRuntimeAdapter,
  CloudRuntimeEvent,
  CloudRuntimeExecutionContext,
} from './runtime-adapter.ts'
import { type CloudRuntimePolicy } from './cloud-config.ts'
import type { CloudAbuseConfig } from '@open-cowork/shared'
import type { BillingAction } from './billing-adapter.ts'
import type { CloudUsageGovernanceService } from './services/usage-governance-service.ts'
import type { AppendProjectedEventInput } from './session-projection-service.ts'
import type { CloudWorkflowOperationsService } from './session-workflow-operations.ts'
import {
  normalizePermissionPayload,
  normalizePromptPayload,
  normalizeQuestionRejectPayload,
  normalizeQuestionReplyPayload,
  type PermissionRespondPayload,
  type QuestionRejectPayload,
  type QuestionReplyPayload,
} from './services/session-command-service.ts'
import { type RemoteInteractionPolicyInput } from './services/remote-approval-policy.ts'
import { runOnAbort, throwIfAborted } from './cloud-abort-helpers.ts'
import { asRecord, includesAllowed, readString } from './session-input-validation.ts'
import {
  HOUR_MS,
  promptParts,
  type CloudPrincipal,
  type CloudSessionView,
  type CreateCloudSessionRecordInput,
} from './session-service-types.ts'

export type CloudSessionExecutionServiceOptions = {
  store: ControlPlaneStore
  runtime: CloudRuntimeAdapter
  policy: CloudRuntimePolicy
  ids: { randomUUID: () => string }
  abuse: CloudAbuseConfig
  usageGovernance: CloudUsageGovernanceService
  workflowOperations: CloudWorkflowOperationsService
  appendProjectedEvent: (input: AppendProjectedEventInput) => Promise<SessionEventRecord>
  getSessionView: (principal: CloudPrincipal, sessionId: string) => Promise<CloudSessionView>
  principalOrgId: (principal: CloudPrincipal) => string
  assertBillingAllowed: (input: {
    orgId: string
    action: BillingAction
    profileName?: string | null
    providerId?: string | null
  }) => Promise<void>
  assertRemoteInteractionAllowed: (principal: CloudPrincipal, input: RemoteInteractionPolicyInput) => Promise<unknown>
}

export class CloudSessionExecutionService {
  private readonly store: ControlPlaneStore
  private readonly runtime: CloudRuntimeAdapter
  private readonly policy: CloudRuntimePolicy
  private readonly ids: { randomUUID: () => string }
  private readonly abuse: CloudAbuseConfig
  private readonly usageGovernance: CloudUsageGovernanceService
  private readonly workflowOperations: CloudWorkflowOperationsService
  private readonly appendProjectedEvent: CloudSessionExecutionServiceOptions['appendProjectedEvent']
  private readonly getSessionView: CloudSessionExecutionServiceOptions['getSessionView']
  private readonly principalOrgId: CloudSessionExecutionServiceOptions['principalOrgId']
  private readonly assertBillingAllowed: CloudSessionExecutionServiceOptions['assertBillingAllowed']
  private readonly assertRemoteInteractionAllowed: CloudSessionExecutionServiceOptions['assertRemoteInteractionAllowed']

  constructor(options: CloudSessionExecutionServiceOptions) {
    this.store = options.store
    this.runtime = options.runtime
    this.policy = options.policy
    this.ids = options.ids
    this.abuse = options.abuse
    this.usageGovernance = options.usageGovernance
    this.workflowOperations = options.workflowOperations
    this.appendProjectedEvent = options.appendProjectedEvent
    this.getSessionView = options.getSessionView
    this.principalOrgId = options.principalOrgId
    this.assertBillingAllowed = options.assertBillingAllowed
    this.assertRemoteInteractionAllowed = options.assertRemoteInteractionAllowed
  }

  async enqueuePrompt(
    principal: CloudPrincipal,
    sessionId: string,
    input: { text: string, agent?: string | null },
  ): Promise<SessionCommandRecord> {
    const view = await this.getSessionView(principal, sessionId)
    // Enforce the deployer's agent allowlist on the prompt path, mirroring the
    // workflow-draft check (`assertWorkflowDraftAllowed`). Without this, a caller
    // could request an arbitrary agent name on a prompt and bypass a profile that
    // restricts `agents`. `allowedAgents === null` (the default) imposes no limit.
    const agentName = input.agent || 'build'
    if (!includesAllowed(agentName, this.policy.allowedAgents)) {
      throw new CloudServiceError(
        403,
        `Agent "${agentName}" is not enabled for cloud profile "${this.policy.profileName}".`,
        { policyCode: 'policy.agent_not_enabled' },
      )
    }
    await this.assertBillingAllowed({
      orgId: this.principalOrgId(principal),
      action: 'prompt.enqueue',
      profileName: view.session.profileName,
    })
    const orgId = this.principalOrgId(principal)
    const promptQuota = await this.usageGovernance.usageQuotaForOrg({
      orgId,
      quotaKey: 'prompts:hour',
      limit: this.abuse.maxPromptsPerHour,
      entitlementLimitKey: 'maxPromptsPerHour',
      windowMs: HOUR_MS,
      policyCode: 'quota.prompts_per_hour_exceeded',
    })
    const commandId = this.ids.randomUUID()
    let command: SessionCommandRecord
    try {
      command = await this.store.enqueueSessionCommand({
        commandId,
        tenantId: principal.tenantId,
        userId: principal.userId,
        sessionId,
        kind: 'prompt',
        payload: {
          text: input.text,
          agent: input.agent || 'build',
        },
        quota: await this.usageGovernance.commandQueueQuotaForOrg(orgId),
        usageQuotas: [promptQuota].filter((quota) => quota !== null),
      })
    } catch (error) {
      this.usageGovernance.translateQuotaError(error, 'Cloud command queue is full.', 'quota.queued_commands_exceeded')
    }
    await this.usageGovernance.recordUsage({
      orgId,
      accountId: principal.accountId || principal.userId,
      eventType: 'work.queued',
      unit: 'count',
      metadata: { tenantId: principal.tenantId, sessionId, commandId, commandKind: command.kind, source: 'api' },
    })
    await this.usageGovernance.recordUsage({
      orgId,
      accountId: principal.accountId || principal.userId,
      eventType: 'prompt.enqueued',
      unit: 'count',
      metadata: { tenantId: principal.tenantId, sessionId, source: 'api' },
    })
    return command
  }

  async enqueueAbort(principal: CloudPrincipal, sessionId: string): Promise<SessionCommandRecord> {
    await this.getSessionView(principal, sessionId)
    return this.store.enqueueSessionCommand({
      commandId: this.ids.randomUUID(),
      tenantId: principal.tenantId,
      userId: principal.userId,
      sessionId,
      kind: 'abort',
      payload: {},
    })
  }

  async enqueueQuestionReply(
    principal: CloudPrincipal,
    sessionId: string,
    payload: QuestionReplyPayload,
  ): Promise<SessionCommandRecord> {
    await this.getSessionView(principal, sessionId)
    const commandId = this.ids.randomUUID()
    await this.assertRemoteInteractionAllowed(principal, {
      sessionId,
      commandId,
      interaction: 'question-reply',
      targetId: payload.requestId,
    })
    return this.store.enqueueSessionCommand({
      commandId,
      tenantId: principal.tenantId,
      userId: principal.userId,
      sessionId,
      kind: 'question.reply',
      payload,
    })
  }

  async enqueueQuestionReject(
    principal: CloudPrincipal,
    sessionId: string,
    payload: QuestionRejectPayload,
  ): Promise<SessionCommandRecord> {
    await this.getSessionView(principal, sessionId)
    const commandId = this.ids.randomUUID()
    await this.assertRemoteInteractionAllowed(principal, {
      sessionId,
      commandId,
      interaction: 'question-reject',
      targetId: payload.requestId,
    })
    return this.store.enqueueSessionCommand({
      commandId,
      tenantId: principal.tenantId,
      userId: principal.userId,
      sessionId,
      kind: 'question.reject',
      payload,
    })
  }

  async enqueuePermissionResponse(
    principal: CloudPrincipal,
    sessionId: string,
    payload: PermissionRespondPayload,
  ): Promise<SessionCommandRecord> {
    await this.getSessionView(principal, sessionId)
    const commandId = this.ids.randomUUID()
    await this.assertRemoteInteractionAllowed(principal, {
      sessionId,
      commandId,
      interaction: 'permission-approval',
      targetId: payload.permissionId,
    })
    return this.store.enqueueSessionCommand({
      commandId,
      tenantId: principal.tenantId,
      userId: principal.userId,
      sessionId,
      kind: 'permission.respond',
      payload,
    })
  }

  async executeCommand(
    lease: WorkerLeaseRecord,
    command: SessionCommandRecord,
    options: { signal?: AbortSignal, deferAck?: boolean } = {},
  ): Promise<void> {
    try {
      throwIfAborted(options.signal)
      switch (command.kind) {
        case 'prompt':
          await this.executePromptCommand(lease, command, options.signal)
          break
        case 'abort':
          await this.executeAbortCommand(lease, command, options.signal)
          break
        case 'question.reply':
          await this.executeQuestionReplyCommand(lease, command, options.signal)
          break
        case 'question.reject':
          await this.executeQuestionRejectCommand(lease, command, options.signal)
          break
        case 'permission.respond':
          await this.executePermissionCommand(lease, command, options.signal)
          break
        default: {
          const unsupported: never = command.kind
          throw new Error(`Unsupported command kind ${String(unsupported)}.`)
        }
      }
      throwIfAborted(options.signal)
      if (!options.deferAck) await this.store.ackSessionCommand(lease, command.commandId)
    } catch (error) {
      if (options.signal?.aborted) throw error
      const message = error instanceof Error ? error.message : String(error)
      await this.appendProjectedEvent({
        tenantId: command.tenantId,
        sessionId: command.sessionId,
        type: 'runtime.error',
        payload: { commandId: command.commandId, message },
        leaseToken: lease.leaseToken,
      })
      await this.workflowOperations.failWorkflowRunForSession(command.tenantId, command.sessionId, message, lease.leaseToken)
      await this.store.failSessionCommand(lease, command.commandId, message)
      throw error
    }
  }

  appendRuntimeEvent(input: {
    tenantId: string
    sessionId: string
    event: CloudRuntimeEvent
    leaseToken?: string | null
  }): Promise<SessionEventRecord> {
    if (input.event.type === 'session.idle') {
      return this.updateStatusThenAppendRuntimeEvent(input, 'idle')
    } else if (input.event.type === 'session.status') {
      const statusType = readString(input.event.payload.statusType)
      if (statusType === 'busy' || statusType === 'running' || statusType === 'idle') {
        return this.updateStatusThenAppendRuntimeEvent(input, statusType === 'idle' ? 'idle' : 'running')
      }
    } else if (input.event.type === 'runtime.error') {
      return this.updateStatusThenAppendRuntimeEvent(input, 'errored')
    }
    return this.appendProjectedEvent({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      type: input.event.type,
      payload: input.event.payload,
      leaseToken: input.leaseToken,
    })
  }

  private async updateStatusThenAppendRuntimeEvent(
    input: {
      tenantId: string
      sessionId: string
      event: CloudRuntimeEvent
      leaseToken?: string | null
    },
    status: SessionRecord['status'],
  ) {
    await this.store.updateSessionStatus({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      status,
      leaseToken: input.leaseToken,
    })
    return this.appendProjectedEvent({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      type: input.event.type,
      payload: input.event.payload,
      leaseToken: input.leaseToken,
    })
  }

  private async executePromptCommand(lease: WorkerLeaseRecord, command: SessionCommandRecord, signal?: AbortSignal) {
    throwIfAborted(signal)
    const payload = normalizePromptPayload(command.payload)
    const session = await this.requireSessionRecord(command.tenantId, command.sessionId)
    const runtimeSessionId = await this.ensureRuntimeSessionBound(lease)
    const context = this.runtimeContext(session)
    throwIfAborted(signal)
    await this.store.updateSessionStatus({
      tenantId: command.tenantId,
      sessionId: command.sessionId,
      status: 'running',
      leaseToken: lease.leaseToken,
    })
    await this.appendProjectedEvent({
      tenantId: command.tenantId,
      sessionId: command.sessionId,
      type: 'prompt.submitted',
      payload: {
        commandId: command.commandId,
        messageId: `${command.commandId}:user`,
        text: payload.text,
        agent: payload.agent,
      },
      leaseToken: lease.leaseToken,
    })
    const stopAbortHandler = runOnAbort(signal, () => this.runtime.abortSession({
      sessionId: runtimeSessionId,
      context,
    }))
    let result: Awaited<ReturnType<CloudRuntimeAdapter['promptSession']>>
    try {
      result = await this.runtime.promptSession({
        sessionId: runtimeSessionId,
        parts: promptParts(payload.text),
        agent: payload.agent,
        context,
        messageId: command.commandId,
        signal,
      })
    } finally {
      stopAbortHandler()
    }
    throwIfAborted(signal)
    for (const event of result?.events || []) {
      await this.applyRuntimeEvent(lease, command.sessionId, event)
    }
    await this.workflowOperations.completeWorkflowRunForSession(
      command.tenantId,
      command.sessionId,
      this.workflowOperations.workflowSummaryFromRuntimeEvents(result?.events || []),
      lease.leaseToken,
    )
  }

  private async executeAbortCommand(lease: WorkerLeaseRecord, command: SessionCommandRecord, signal?: AbortSignal) {
    throwIfAborted(signal)
    const session = await this.requireSessionRecord(command.tenantId, command.sessionId)
    if (session.opencodeSessionId) {
      await this.runtime.abortSession({
        sessionId: session.opencodeSessionId,
        context: this.runtimeContext(session),
        signal,
      })
    }
    throwIfAborted(signal)
    await this.store.updateSessionStatus({
      tenantId: command.tenantId,
      sessionId: command.sessionId,
      status: 'idle',
      leaseToken: lease.leaseToken,
    })
    await this.appendProjectedEvent({
      tenantId: command.tenantId,
      sessionId: command.sessionId,
      type: 'session.aborted',
      payload: {
        commandId: command.commandId,
      },
      leaseToken: lease.leaseToken,
    })
  }

  private async executeQuestionReplyCommand(lease: WorkerLeaseRecord, command: SessionCommandRecord, signal?: AbortSignal) {
    throwIfAborted(signal)
    const payload = normalizeQuestionReplyPayload(command.payload)
    if (!payload.requestId) throw new Error('Question reply requires a request id.')
    if (!this.runtime.replyToQuestion) throw new Error('OpenCode question replies are not available.')
    const session = await this.requireSessionRecord(command.tenantId, command.sessionId)
    await this.runtime.replyToQuestion({
      requestId: payload.requestId,
      answers: payload.answers,
      context: this.runtimeContext(session),
      signal,
    })
    throwIfAborted(signal)
    await this.appendProjectedEvent({
      tenantId: command.tenantId,
      sessionId: command.sessionId,
      type: 'question.resolved',
      payload: {
        commandId: command.commandId,
        requestId: payload.requestId,
        answers: payload.answers,
      },
      leaseToken: lease.leaseToken,
    })
  }

  private async executeQuestionRejectCommand(lease: WorkerLeaseRecord, command: SessionCommandRecord, signal?: AbortSignal) {
    throwIfAborted(signal)
    const payload = normalizeQuestionRejectPayload(command.payload)
    if (!payload.requestId) throw new Error('Question rejection requires a request id.')
    if (!this.runtime.rejectQuestion) throw new Error('OpenCode question rejection is not available.')
    const session = await this.requireSessionRecord(command.tenantId, command.sessionId)
    await this.runtime.rejectQuestion({
      requestId: payload.requestId,
      context: this.runtimeContext(session),
      signal,
    })
    throwIfAborted(signal)
    await this.appendProjectedEvent({
      tenantId: command.tenantId,
      sessionId: command.sessionId,
      type: 'question.resolved',
      payload: {
        commandId: command.commandId,
        requestId: payload.requestId,
        rejected: true,
      },
      leaseToken: lease.leaseToken,
    })
  }

  private async executePermissionCommand(lease: WorkerLeaseRecord, command: SessionCommandRecord, signal?: AbortSignal) {
    throwIfAborted(signal)
    const payload = normalizePermissionPayload(command.payload)
    if (!payload.permissionId) throw new Error('Permission response requires a permission id.')
    if (!this.runtime.respondToPermission) throw new Error('OpenCode permission responses are not available.')
    const session = await this.requireSessionRecord(command.tenantId, command.sessionId)
    const allowed = asRecord(payload.response).allowed === true
      || payload.response === true
      || payload.response === 'allow'
      || payload.response === 'once'
    await this.runtime.respondToPermission({
      permissionId: payload.permissionId,
      allowed,
      context: this.runtimeContext(session),
      signal,
    })
    throwIfAborted(signal)
    await this.appendProjectedEvent({
      tenantId: command.tenantId,
      sessionId: command.sessionId,
      type: 'permission.resolved',
      payload: {
        commandId: command.commandId,
        permissionId: payload.permissionId,
        allowed,
      },
      leaseToken: lease.leaseToken,
    })
  }

  private async applyRuntimeEvent(lease: WorkerLeaseRecord, sessionId: string, event: CloudRuntimeEvent) {
    await this.appendRuntimeEvent({
      tenantId: lease.tenantId,
      sessionId,
      event,
      leaseToken: lease.leaseToken,
    })
  }

  private async requireSessionRecord(tenantId: string, sessionId: string) {
    const session = await this.store.getSessionForTenant(tenantId, sessionId)
    if (!session) throw new Error(`Unknown session ${sessionId}.`)
    return session
  }

  private shouldCreateRuntimeSessionsEagerly() {
    if (this.runtime.requiresWorkerContext) return false
    return this.policy.role === 'all-in-one' || this.policy.role === 'worker'
  }

  private runtimeContext(input: { tenantId: string, sessionId: string, profileName?: string | null }): CloudRuntimeExecutionContext {
    return {
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      profileName: input.profileName || this.policy.profileName,
    }
  }

  private async createStoredSession(input: {
    tenantId: string
    userId: string
    orgId?: string | null
    accountId?: string | null
    sessionId: string
    opencodeSessionId: string
    profileName: string
    title?: string | null
    createdAt?: Date
  }) {
    try {
      const concurrentSessionLimit = await this.usageGovernance.effectiveQuotaLimit(
        input.orgId || input.tenantId,
        this.abuse.maxConcurrentSessionsPerOrg,
        'maxConcurrentSessionsPerOrg',
      )
      const session = await this.store.createSession({
        tenantId: input.tenantId,
        userId: input.userId,
        sessionId: input.sessionId,
        opencodeSessionId: input.opencodeSessionId,
        profileName: input.profileName,
        title: input.title,
        createdAt: input.createdAt,
        quota: this.usageGovernance.quotaLimit(concurrentSessionLimit)
          ? {
              orgId: input.orgId || input.tenantId,
              maxConcurrentSessionsPerOrg: concurrentSessionLimit,
              policyCode: 'quota.concurrent_sessions_exceeded',
            }
          : null,
      })
      await this.usageGovernance.recordUsage({
        orgId: input.orgId || input.tenantId,
        accountId: input.accountId || input.userId,
        eventType: 'session.created',
        unit: 'count',
        metadata: { tenantId: input.tenantId, userId: input.userId, sessionId: input.sessionId },
      })
      return session
    } catch (error) {
      this.usageGovernance.translateQuotaError(error, 'Concurrent cloud session quota exceeded.', 'quota.concurrent_sessions_exceeded')
    }
  }

  async createCloudSessionRecord(input: CreateCloudSessionRecordInput): Promise<SessionRecord> {
    if (input.sessionId) {
      const existing = await this.store.getSessionForTenant(input.tenantId, input.sessionId)
      if (existing) return existing
      const now = new Date()
      const title = input.title || 'New session'
      await this.createStoredSession({
        tenantId: input.tenantId,
        userId: input.userId,
        orgId: input.orgId,
        accountId: input.accountId,
        sessionId: input.sessionId,
        opencodeSessionId: '',
        profileName: input.profileName,
        title,
        createdAt: now,
      })
      await this.appendProjectedEvent({
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        type: 'session.created',
        payload: {
          title,
          runtimePending: true,
        },
        createdAt: now,
      })
      return this.requireSessionRecord(input.tenantId, input.sessionId)
    }

    if (!input.deferRuntime && this.shouldCreateRuntimeSessionsEagerly() && !this.usageGovernance.quotaLimit(this.abuse.maxConcurrentSessionsPerOrg)) {
      const runtimeSession = await this.runtime.createSession({
        profileName: input.profileName,
        context: this.runtimeContext({
          tenantId: input.tenantId,
          sessionId: input.sessionId || '',
          profileName: input.profileName,
        }),
      })
      const title = input.title || runtimeSession.title
      await this.createStoredSession({
        tenantId: input.tenantId,
        userId: input.userId,
        orgId: input.orgId,
        accountId: input.accountId,
        sessionId: runtimeSession.id,
        opencodeSessionId: runtimeSession.id,
        profileName: input.profileName,
        title,
        createdAt: new Date(runtimeSession.createdAt),
      })
      await this.appendProjectedEvent({
        tenantId: input.tenantId,
        sessionId: runtimeSession.id,
        type: 'session.created',
        payload: { title },
        createdAt: new Date(runtimeSession.updatedAt),
      })
      return this.requireSessionRecord(input.tenantId, runtimeSession.id)
    }

    const now = new Date()
    const sessionId = this.ids.randomUUID()
    const title = input.title || 'New session'
    await this.createStoredSession({
      tenantId: input.tenantId,
      userId: input.userId,
      orgId: input.orgId,
      accountId: input.accountId,
      sessionId,
      opencodeSessionId: '',
      profileName: input.profileName,
      title,
      createdAt: now,
    })
    await this.appendProjectedEvent({
      tenantId: input.tenantId,
      sessionId,
      type: 'session.created',
      payload: {
        title,
        runtimePending: true,
      },
      createdAt: now,
    })
    return this.requireSessionRecord(input.tenantId, sessionId)
  }

  private async ensureRuntimeSessionBound(lease: WorkerLeaseRecord) {
    const session = await this.requireSessionRecord(lease.tenantId, lease.sessionId)
    if (session.opencodeSessionId) return session.opencodeSessionId

    const runtimeSession = await this.runtime.createSession({
      profileName: session.profileName,
      context: this.runtimeContext(session),
    })
    await this.store.bindSessionRuntime({
      tenantId: session.tenantId,
      sessionId: session.sessionId,
      opencodeSessionId: runtimeSession.id,
      title: session.title || runtimeSession.title,
      leaseToken: lease.leaseToken,
      updatedAt: new Date(runtimeSession.updatedAt),
    })
    return runtimeSession.id
  }
}
