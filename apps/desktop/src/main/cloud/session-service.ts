import { createHash, randomUUID } from 'crypto'
import type {
  CapabilitySkill,
  CapabilityTool,
  WorkflowDetail,
  WorkflowDraft,
  WorkflowListPayload,
  WorkflowRun,
  WorkflowStatus,
  WorkflowTrigger,
  WorkflowTriggerType,
} from '@open-cowork/shared'
import {
  getCapabilitySkillBundle,
  getCapabilityTool,
  listCapabilitySkills,
  listCapabilityTools,
} from '../capability-catalog.ts'
import type {
  ClaimedWorkflowRunRecord,
  CloudWorkflowRecord,
  CloudWorkflowRunRecord,
  ControlPlaneStore,
  SessionCommandRecord,
  SessionEventRecord,
  SessionProjectionRecord,
  SessionRecord,
  ThreadSmartFilterRecord,
  ThreadTagRecord,
  WorkerLeaseRecord,
} from './control-plane-store.ts'
import type { CloudRuntimeAdapter, CloudRuntimeEvent, CloudRuntimePromptPart } from './runtime-adapter.ts'
import { evaluateCloudProjectDirectoryPolicy, type CloudRuntimePolicy } from './cloud-config.ts'
import { CloudSessionEventBus } from './session-event-bus.ts'
import { computeNextWorkflowRunAt, validateWorkflowSchedule } from '../workflow/workflow-schedule.ts'
import {
  verifyWorkflowWebhookAuth,
  WebhookHttpError,
  type WorkflowWebhookAuth,
  type WorkflowWebhookSecurityStore,
} from '../workflow/workflow-webhook-server.ts'

export type CloudPrincipal = {
  tenantId: string
  tenantName?: string
  userId: string
  email: string
}

export type CloudSessionMessage = {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: string
}

export type CloudSessionProjectionView = {
  sessionId: string
  title: string
  status: 'idle' | 'running' | 'closed' | 'errored'
  profileName: string
  isGenerating: boolean
  messages: CloudSessionMessage[]
  lastError: string | null
  updatedAt: string
}

export type CloudSessionView = {
  session: SessionRecord
  projection: SessionProjectionRecord | null
}

type CreateCloudSessionRecordInput = {
  tenantId: string
  userId: string
  profileName: string
  title?: string | null
}

export type CloudWorkflowStartResult = {
  tenantId: string
  workflow: WorkflowDetail
  run: WorkflowRun
  sessionId: string
  command: SessionCommandRecord
}

type AppendProjectedEventInput = {
  tenantId: string
  sessionId: string
  type: string
  payload?: Record<string, unknown>
  leaseToken?: string | null
  createdAt?: Date
}

type PromptCommandPayload = {
  text: string
  agent: string
}

type QuestionReplyPayload = {
  requestId: string
  answers: unknown[]
}

type PermissionRespondPayload = {
  permissionId: string
  response: unknown
}

const WORKFLOW_MAX_TEXT = 50_000
const WORKFLOW_TITLE_MAX_LENGTH = 512
const WORKFLOW_FIELD_MAX_LENGTH = 4096
const WORKFLOW_MAX_LIST_VALUES = 100
const WORKFLOW_VALID_TRIGGER_TYPES = new Set<WorkflowTriggerType>(['manual', 'schedule', 'webhook'])
const WEBHOOK_SIGNATURE_REPLAY_WINDOW_MS = 5 * 60 * 1000
const WEBHOOK_SIGNATURE_REPLAY_CACHE_LIMIT = 512

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function readString(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value : fallback
}

function readNullableString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function boundedText(value: unknown, label: string, maxLength: number) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
  const normalized = value.trim()
  if (normalized.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters.`)
  return normalized
}

function boundedOptionalText(value: unknown, label: string, maxLength: number) {
  if (value === undefined || value === null || value === '') return null
  return boundedText(value, label, maxLength)
}

function normalizeWorkflowStringList(value: unknown, label: string) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`)
  return [...new Set(value.slice(0, WORKFLOW_MAX_LIST_VALUES).map((entry) => boundedText(entry, label, 256)))]
}

function readStatus(value: unknown): CloudSessionProjectionView['status'] | null {
  return value === 'idle' || value === 'running' || value === 'closed' || value === 'errored'
    ? value
    : null
}

function toMessage(value: unknown): CloudSessionMessage | null {
  const record = asRecord(value)
  const role = record.role
  if (role !== 'user' && role !== 'assistant' && role !== 'system') return null
  return {
    id: readString(record.id, randomUUID()),
    role,
    content: readString(record.content),
    createdAt: readString(record.createdAt, new Date().toISOString()),
  }
}

function projectionViewFromRecord(session: SessionRecord): CloudSessionProjectionView {
  return {
    sessionId: session.sessionId,
    title: session.title || 'New session',
    status: session.status,
    profileName: session.profileName,
    isGenerating: session.status === 'running',
    messages: [],
    lastError: null,
    updatedAt: session.updatedAt,
  }
}

function normalizeProjectionView(value: unknown, session: SessionRecord): CloudSessionProjectionView {
  const record = asRecord(value)
  const messages = Array.isArray(record.messages)
    ? record.messages.map(toMessage).filter((entry): entry is CloudSessionMessage => Boolean(entry))
    : []
  return {
    ...projectionViewFromRecord(session),
    sessionId: readString(record.sessionId, session.sessionId),
    title: readString(record.title, session.title || 'New session'),
    status: readStatus(record.status) || session.status,
    profileName: readString(record.profileName, session.profileName),
    isGenerating: typeof record.isGenerating === 'boolean' ? record.isGenerating : session.status === 'running',
    messages,
    lastError: typeof record.lastError === 'string' ? record.lastError : null,
    updatedAt: readString(record.updatedAt, session.updatedAt),
  }
}

function addMessage(
  view: CloudSessionProjectionView,
  message: CloudSessionMessage,
): CloudSessionProjectionView {
  if (view.messages.some((entry) => entry.id === message.id)) return view
  return {
    ...view,
    messages: [...view.messages, message],
  }
}

function reduceProjectedEvent(
  session: SessionRecord,
  current: CloudSessionProjectionView,
  event: SessionEventRecord,
): CloudSessionProjectionView {
  const payload = asRecord(event.payload)
  const eventTime = event.createdAt
  switch (event.type) {
    case 'session.created':
      return {
        ...current,
        title: readString(payload.title, current.title),
        status: 'idle',
        isGenerating: false,
        lastError: null,
        updatedAt: eventTime,
      }
    case 'prompt.submitted':
      return addMessage({
        ...current,
        status: 'running',
        isGenerating: true,
        lastError: null,
        updatedAt: eventTime,
      }, {
        id: readString(payload.messageId, `${session.sessionId}:${event.sequence}:user`),
        role: 'user',
        content: readString(payload.text),
        createdAt: eventTime,
      })
    case 'assistant.message':
      return addMessage({
        ...current,
        status: 'idle',
        isGenerating: false,
        lastError: null,
        updatedAt: eventTime,
      }, {
        id: readString(payload.messageId, `${session.sessionId}:${event.sequence}:assistant`),
        role: 'assistant',
        content: readString(payload.content),
        createdAt: eventTime,
      })
    case 'session.aborted':
      return {
        ...current,
        status: 'idle',
        isGenerating: false,
        updatedAt: eventTime,
      }
    case 'session.idle':
      return {
        ...current,
        status: 'idle',
        isGenerating: false,
        updatedAt: eventTime,
      }
    case 'session.status': {
      const statusType = readString(payload.statusType)
      const status = statusType === 'busy' || statusType === 'running'
        ? 'running'
        : statusType === 'idle'
          ? 'idle'
          : current.status
      return {
        ...current,
        status,
        isGenerating: status === 'running',
        updatedAt: eventTime,
      }
    }
    case 'runtime.error':
      return {
        ...current,
        status: 'errored',
        isGenerating: false,
        lastError: readString(payload.message, 'Runtime command failed.'),
        updatedAt: eventTime,
      }
    default:
      return {
        ...current,
        updatedAt: eventTime,
      }
  }
}

function promptParts(text: string): CloudRuntimePromptPart[] {
  return [{ type: 'text', text }]
}

function includesAllowed(value: string | null | undefined, allowed: string[] | null) {
  return !allowed || Boolean(value && allowed.includes(value))
}

function toWorkflowSummary(record: CloudWorkflowRecord) {
  const { tenantId: _tenantId, userId: _userId, ...workflow } = record
  return workflow
}

function toWorkflowRun(record: CloudWorkflowRunRecord): WorkflowRun {
  const { tenantId: _tenantId, userId: _userId, ...run } = record
  return run
}

function workflowRunTerminal(status: WorkflowRun['status']) {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function workflowWebhookReplayKey(workflowId: string, auth: Extract<WorkflowWebhookAuth, { kind: 'signature' }>) {
  const workflowKey = createHash('sha256').update(workflowId).digest('hex').slice(0, 16)
  return `${workflowKey}:${auth.timestamp}:${auth.signature}`
}

function normalizePromptPayload(payload: Record<string, unknown>): PromptCommandPayload {
  return {
    text: readString(payload.text),
    agent: readString(payload.agent, 'build'),
  }
}

function normalizeQuestionReplyPayload(payload: Record<string, unknown>): QuestionReplyPayload {
  return {
    requestId: readString(payload.requestId),
    answers: Array.isArray(payload.answers) ? payload.answers : [],
  }
}

function normalizePermissionPayload(payload: Record<string, unknown>): PermissionRespondPayload {
  return {
    permissionId: readString(payload.permissionId),
    response: payload.response ?? null,
  }
}

export class CloudSessionService {
  private readonly store: ControlPlaneStore
  private readonly runtime: CloudRuntimeAdapter
  private readonly policy: CloudRuntimePolicy
  private readonly events: CloudSessionEventBus
  private readonly ids: { randomUUID: () => string }

  constructor(
    store: ControlPlaneStore,
    runtime: CloudRuntimeAdapter,
    policy: CloudRuntimePolicy,
    events = new CloudSessionEventBus(),
    ids: { randomUUID: () => string } = { randomUUID },
  ) {
    this.store = store
    this.runtime = runtime
    this.policy = policy
    this.events = events
    this.ids = ids
  }

  get eventBus() {
    return this.events
  }

  async ensurePrincipal(principal: CloudPrincipal) {
    await this.store.createTenant({
      tenantId: principal.tenantId,
      name: principal.tenantName || principal.tenantId,
    })
    await this.store.ensureUser({
      tenantId: principal.tenantId,
      userId: principal.userId,
      email: principal.email,
    })
  }

  async createSession(principal: CloudPrincipal, input: { profileName?: string | null } = {}): Promise<CloudSessionView> {
    await this.ensurePrincipal(principal)
    if (!this.policy.features.chat) throw new Error('Chat is disabled for this cloud profile.')
    const profileName = input.profileName || this.policy.profileName
    const session = await this.createCloudSessionRecord({
      tenantId: principal.tenantId,
      userId: principal.userId,
      profileName,
    })
    return this.getSessionView(principal, session.sessionId)
  }

  async listSessions(principal: CloudPrincipal): Promise<SessionRecord[]> {
    await this.ensurePrincipal(principal)
    return this.store.listSessions(principal.tenantId, principal.userId)
  }

  async getSessionView(principal: CloudPrincipal, sessionId: string): Promise<CloudSessionView> {
    await this.ensurePrincipal(principal)
    const session = await this.store.getSession(principal.tenantId, principal.userId, sessionId)
    if (!session) throw new Error(`Unknown session ${sessionId}.`)
    return {
      session,
      projection: await this.store.getSessionProjection(principal.tenantId, sessionId),
    }
  }

  async listEvents(principal: CloudPrincipal, sessionId: string, afterSequence = 0): Promise<SessionEventRecord[]> {
    await this.getSessionView(principal, sessionId)
    return this.store.listSessionEvents(principal.tenantId, sessionId, afterSequence)
  }

  async listWorkerHeartbeats() {
    return this.store.listWorkerHeartbeats()
  }

  async listSettingMetadata(principal: CloudPrincipal) {
    await this.ensurePrincipal(principal)
    this.assertSettingsEnabled()
    return this.store.listSettingMetadata(principal.tenantId, principal.userId)
  }

  async getSettingMetadata(principal: CloudPrincipal, key: string) {
    await this.ensurePrincipal(principal)
    this.assertSettingsEnabled()
    return this.store.getSettingMetadata(principal.tenantId, key, principal.userId)
  }

  async setSettingMetadata(
    principal: CloudPrincipal,
    input: { key: string, value: Record<string, unknown> },
  ) {
    await this.ensurePrincipal(principal)
    this.assertSettingsEnabled()
    return this.store.setSettingMetadata({
      tenantId: principal.tenantId,
      userId: principal.userId,
      key: input.key,
      value: input.value,
    })
  }

  async listCapabilityCatalog(principal: CloudPrincipal) {
    await this.ensurePrincipal(principal)
    this.assertCapabilitiesEnabled()
    const [tools, skills] = await Promise.all([
      this.listCapabilityTools(principal),
      this.listCapabilitySkills(principal),
    ])
    return { tools, skills }
  }

  async listCapabilityTools(principal: CloudPrincipal): Promise<CapabilityTool[]> {
    await this.ensurePrincipal(principal)
    this.assertCapabilitiesEnabled()
    return (await listCapabilityTools())
      .map((tool) => this.filterCapabilityTool(tool))
      .filter((tool): tool is CapabilityTool => Boolean(tool))
  }

  async getCapabilityTool(principal: CloudPrincipal, toolId: string): Promise<CapabilityTool | null> {
    await this.ensurePrincipal(principal)
    this.assertCapabilitiesEnabled()
    const tool = await getCapabilityTool(toolId)
    return tool ? this.filterCapabilityTool(tool) : null
  }

  async listCapabilitySkills(principal: CloudPrincipal): Promise<CapabilitySkill[]> {
    await this.ensurePrincipal(principal)
    this.assertCapabilitiesEnabled()
    return (await listCapabilitySkills())
      .map((skill) => this.filterCapabilitySkill(skill))
      .filter((skill): skill is CapabilitySkill => Boolean(skill))
  }

  async getCapabilitySkill(principal: CloudPrincipal, skillName: string): Promise<CapabilitySkill | null> {
    const skills = await this.listCapabilitySkills(principal)
    return skills.find((skill) => skill.name === skillName) || null
  }

  async getCapabilitySkillBundle(principal: CloudPrincipal, skillName: string) {
    const skill = await this.getCapabilitySkill(principal, skillName)
    if (!skill) return null
    return getCapabilitySkillBundle(skillName)
  }

  async listThreadTags(principal: CloudPrincipal): Promise<ThreadTagRecord[]> {
    await this.ensurePrincipal(principal)
    this.assertThreadIndexEnabled()
    return this.store.listThreadTags(principal.tenantId)
  }

  async createThreadTag(
    principal: CloudPrincipal,
    input: { name: string, color?: string | null },
  ): Promise<ThreadTagRecord> {
    await this.ensurePrincipal(principal)
    this.assertThreadIndexEnabled()
    return this.store.createThreadTag({
      tenantId: principal.tenantId,
      tagId: this.ids.randomUUID(),
      name: input.name,
      color: input.color,
    })
  }

  async updateThreadTag(
    principal: CloudPrincipal,
    tagId: string,
    input: { name?: string, color?: string | null },
  ): Promise<ThreadTagRecord | null> {
    await this.ensurePrincipal(principal)
    this.assertThreadIndexEnabled()
    return this.store.updateThreadTag({
      tenantId: principal.tenantId,
      tagId,
      name: input.name,
      color: input.color,
    })
  }

  async deleteThreadTag(principal: CloudPrincipal, tagId: string): Promise<boolean> {
    await this.ensurePrincipal(principal)
    this.assertThreadIndexEnabled()
    return this.store.deleteThreadTag(principal.tenantId, tagId)
  }

  async applyThreadTag(principal: CloudPrincipal, tagId: string, sessionIds: string[]): Promise<void> {
    await this.ensurePrincipal(principal)
    this.assertThreadIndexEnabled()
    await this.requireOwnedSessions(principal, sessionIds)
    await this.store.applyThreadTags({
      tenantId: principal.tenantId,
      sessionIds,
      tagIds: [tagId],
    })
  }

  async removeThreadTag(principal: CloudPrincipal, tagId: string, sessionIds: string[]): Promise<void> {
    await this.ensurePrincipal(principal)
    this.assertThreadIndexEnabled()
    await this.requireOwnedSessions(principal, sessionIds)
    await this.store.removeThreadTags({
      tenantId: principal.tenantId,
      sessionIds,
      tagIds: [tagId],
    })
  }

  async listThreadMetadata(principal: CloudPrincipal, input: { tagIds?: string[], limit?: number } = {}) {
    await this.ensurePrincipal(principal)
    this.assertThreadIndexEnabled()
    return this.store.listThreadMetadata({
      tenantId: principal.tenantId,
      userId: principal.userId,
      tagIds: input.tagIds,
      limit: input.limit,
    })
  }

  async listThreadSmartFilters(principal: CloudPrincipal): Promise<ThreadSmartFilterRecord[]> {
    await this.ensurePrincipal(principal)
    this.assertThreadIndexEnabled()
    return this.store.listThreadSmartFilters(principal.tenantId)
  }

  async createThreadSmartFilter(
    principal: CloudPrincipal,
    input: { name: string, query: Record<string, unknown> },
  ): Promise<ThreadSmartFilterRecord> {
    await this.ensurePrincipal(principal)
    this.assertThreadIndexEnabled()
    return this.store.createThreadSmartFilter({
      tenantId: principal.tenantId,
      filterId: this.ids.randomUUID(),
      name: input.name,
      query: input.query,
    })
  }

  async updateThreadSmartFilter(
    principal: CloudPrincipal,
    filterId: string,
    input: { name?: string, query?: Record<string, unknown> },
  ): Promise<ThreadSmartFilterRecord | null> {
    await this.ensurePrincipal(principal)
    this.assertThreadIndexEnabled()
    return this.store.updateThreadSmartFilter({
      tenantId: principal.tenantId,
      filterId,
      name: input.name,
      query: input.query,
    })
  }

  async deleteThreadSmartFilter(principal: CloudPrincipal, filterId: string): Promise<boolean> {
    await this.ensurePrincipal(principal)
    this.assertThreadIndexEnabled()
    return this.store.deleteThreadSmartFilter(principal.tenantId, filterId)
  }

  async listWorkflows(principal: CloudPrincipal): Promise<WorkflowListPayload> {
    await this.ensurePrincipal(principal)
    this.assertWorkflowsEnabled()
    const workflows = await this.store.listWorkflows(principal.tenantId, principal.userId)
    const runs = (await Promise.all(workflows.map((workflow) => (
      this.store.listWorkflowRuns(principal.tenantId, workflow.id, 25)
    )))).flat()
    return {
      workflows: workflows.map(toWorkflowSummary),
      runs: runs
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, 100)
        .map(toWorkflowRun),
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
    const normalized = this.normalizeWorkflowDraft(draft)
    this.assertWorkflowDraftAllowed(normalized)
    const now = new Date()
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
    const run = await this.store.createWorkflowRun({
      tenantId: principal.tenantId,
      userId: principal.userId,
      workflowId,
      runId: this.ids.randomUUID(),
      triggerType,
      triggerPayload: input.triggerPayload || null,
    })
    return this.startWorkflowRun(workflow, run)
  }

  async claimAndStartDueWorkflow(now = new Date()): Promise<CloudWorkflowStartResult | null> {
    this.assertWorkflowsEnabled()
    const claimed = await this.store.claimDueWorkflowRun({
      runId: this.ids.randomUUID(),
      now,
    })
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
      const run = await this.store.createWorkflowRun({
        tenantId: workflow.tenantId,
        userId: workflow.userId,
        workflowId: workflow.id,
        runId: this.ids.randomUUID(),
        triggerType: 'webhook',
        triggerPayload: input.payload,
      })
      const started = await this.startWorkflowRun(workflow, run)
      await replayClaim.accept()
      return started
    } catch (error) {
      await replayClaim.release()
      throw error
    }
  }

  async appendProductEvent(
    principal: CloudPrincipal,
    sessionId: string,
    input: {
      type: string
      payload?: Record<string, unknown>
      createdAt?: Date
    },
  ) {
    await this.getSessionView(principal, sessionId)
    return this.appendProjectedEvent({
      tenantId: principal.tenantId,
      sessionId,
      type: input.type,
      payload: input.payload || {},
      createdAt: input.createdAt,
    })
  }

  async enqueuePrompt(
    principal: CloudPrincipal,
    sessionId: string,
    input: { text: string, agent?: string | null },
  ): Promise<SessionCommandRecord> {
    await this.getSessionView(principal, sessionId)
    const commandId = this.ids.randomUUID()
    return this.store.enqueueSessionCommand({
      commandId,
      tenantId: principal.tenantId,
      userId: principal.userId,
      sessionId,
      kind: 'prompt',
      payload: {
        text: input.text,
        agent: input.agent || 'build',
      },
    })
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
    return this.store.enqueueSessionCommand({
      commandId: this.ids.randomUUID(),
      tenantId: principal.tenantId,
      userId: principal.userId,
      sessionId,
      kind: 'question.reply',
      payload,
    })
  }

  async enqueuePermissionResponse(
    principal: CloudPrincipal,
    sessionId: string,
    payload: PermissionRespondPayload,
  ): Promise<SessionCommandRecord> {
    await this.getSessionView(principal, sessionId)
    return this.store.enqueueSessionCommand({
      commandId: this.ids.randomUUID(),
      tenantId: principal.tenantId,
      userId: principal.userId,
      sessionId,
      kind: 'permission.respond',
      payload,
    })
  }

  async executeCommand(lease: WorkerLeaseRecord, command: SessionCommandRecord): Promise<void> {
    try {
      switch (command.kind) {
        case 'prompt':
          await this.executePromptCommand(lease, command)
          break
        case 'abort':
          await this.executeAbortCommand(lease, command)
          break
        case 'question.reply':
          await this.executeQuestionReplyCommand(lease, command)
          break
        case 'permission.respond':
          await this.executePermissionCommand(lease, command)
          break
        default: {
          const unsupported: never = command.kind
          throw new Error(`Unsupported command kind ${String(unsupported)}.`)
        }
      }
      await this.store.ackSessionCommand(lease, command.commandId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.appendProjectedEvent({
        tenantId: command.tenantId,
        sessionId: command.sessionId,
        type: 'runtime.error',
        payload: { commandId: command.commandId, message },
        leaseToken: lease.leaseToken,
      })
      await this.failWorkflowRunForSession(command.tenantId, command.sessionId, message)
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
    if (input.event.type === 'assistant.message' || input.event.type === 'session.idle') {
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
    })
    return this.appendProjectedEvent({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      type: input.event.type,
      payload: input.event.payload,
      leaseToken: input.leaseToken,
    })
  }

  private async executePromptCommand(lease: WorkerLeaseRecord, command: SessionCommandRecord) {
    const payload = normalizePromptPayload(command.payload)
    const runtimeSessionId = await this.ensureRuntimeSessionBound(lease)
    await this.store.updateSessionStatus({
      tenantId: command.tenantId,
      sessionId: command.sessionId,
      status: 'running',
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
    const result = await this.runtime.promptSession({
      sessionId: runtimeSessionId,
      parts: promptParts(payload.text),
      agent: payload.agent,
    })
    for (const event of result?.events || []) {
      await this.applyRuntimeEvent(lease, command.sessionId, event)
    }
    await this.completeWorkflowRunForSession(
      command.tenantId,
      command.sessionId,
      this.workflowSummaryFromRuntimeEvents(result?.events || []),
    )
  }

  private async executeAbortCommand(lease: WorkerLeaseRecord, command: SessionCommandRecord) {
    const session = await this.requireSessionRecord(command.tenantId, command.sessionId)
    if (session.opencodeSessionId) {
      await this.runtime.abortSession({ sessionId: session.opencodeSessionId })
    }
    await this.store.updateSessionStatus({
      tenantId: command.tenantId,
      sessionId: command.sessionId,
      status: 'idle',
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

  private async executeQuestionReplyCommand(lease: WorkerLeaseRecord, command: SessionCommandRecord) {
    const payload = normalizeQuestionReplyPayload(command.payload)
    if (!payload.requestId) throw new Error('Question reply requires a request id.')
    if (!this.runtime.replyToQuestion) throw new Error('OpenCode question replies are not available.')
    await this.runtime.replyToQuestion({
      requestId: payload.requestId,
      answers: payload.answers,
    })
    await this.appendProjectedEvent({
      tenantId: command.tenantId,
      sessionId: command.sessionId,
      type: 'question.resolved',
      payload: {
        commandId: command.commandId,
        requestId: payload.requestId,
      },
      leaseToken: lease.leaseToken,
    })
  }

  private async executePermissionCommand(lease: WorkerLeaseRecord, command: SessionCommandRecord) {
    const payload = normalizePermissionPayload(command.payload)
    if (!payload.permissionId) throw new Error('Permission response requires a permission id.')
    if (!this.runtime.respondToPermission) throw new Error('OpenCode permission responses are not available.')
    const allowed = asRecord(payload.response).allowed === true
      || payload.response === true
      || payload.response === 'allow'
      || payload.response === 'once'
    await this.runtime.respondToPermission({
      permissionId: payload.permissionId,
      allowed,
    })
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

  private async appendProjectedEvent(input: AppendProjectedEventInput) {
    const event = await this.store.appendSessionEvent({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      type: input.type,
      payload: input.payload || {},
      createdAt: input.createdAt,
    })
    const session = await this.requireSessionRecord(input.tenantId, input.sessionId)
    const currentProjection = await this.store.getSessionProjection(input.tenantId, input.sessionId)
    const currentView = normalizeProjectionView(currentProjection?.view, session)
    const nextView = reduceProjectedEvent(session, currentView, event)
    await this.store.writeSessionProjection({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      sequence: event.sequence,
      view: nextView,
      leaseToken: input.leaseToken,
      updatedAt: new Date(event.createdAt),
    })
    this.events.publish(event)
    return event
  }

  private async requireSessionRecord(tenantId: string, sessionId: string) {
    const session = await this.store.getSessionForTenant(tenantId, sessionId)
    if (!session) throw new Error(`Unknown session ${sessionId}.`)
    return session
  }

  private shouldCreateRuntimeSessionsEagerly() {
    return this.policy.role === 'all-in-one' || this.policy.role === 'worker'
  }

  private async createCloudSessionRecord(input: CreateCloudSessionRecordInput): Promise<SessionRecord> {
    if (this.shouldCreateRuntimeSessionsEagerly()) {
      const runtimeSession = await this.runtime.createSession({ profileName: input.profileName })
      const title = input.title || runtimeSession.title
      await this.store.createSession({
        tenantId: input.tenantId,
        userId: input.userId,
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
    await this.store.createSession({
      tenantId: input.tenantId,
      userId: input.userId,
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

    const runtimeSession = await this.runtime.createSession({ profileName: session.profileName })
    await this.store.bindSessionRuntime({
      tenantId: session.tenantId,
      sessionId: session.sessionId,
      opencodeSessionId: runtimeSession.id,
      title: session.title || runtimeSession.title,
      updatedAt: new Date(runtimeSession.updatedAt),
    })
    await this.appendProjectedEvent({
      tenantId: session.tenantId,
      sessionId: session.sessionId,
      type: 'session.runtime.bound',
      payload: {
        opencodeSessionId: runtimeSession.id,
      },
      leaseToken: lease.leaseToken,
      createdAt: new Date(runtimeSession.updatedAt),
    })
    return runtimeSession.id
  }

  private async workflowDetail(workflow: CloudWorkflowRecord): Promise<WorkflowDetail> {
    return {
      ...toWorkflowSummary(workflow),
      runs: (await this.store.listWorkflowRuns(workflow.tenantId, workflow.id, 25)).map(toWorkflowRun),
    }
  }

  private normalizeWorkflowDraft(draft: WorkflowDraft): WorkflowDraft {
    const triggers = this.normalizeWorkflowTriggers(draft.triggers)
    if (!triggers.some((trigger) => trigger.type === 'manual')) {
      triggers.unshift({ id: this.ids.randomUUID(), type: 'manual', enabled: true })
    }
    return {
      title: boundedText(draft.title, 'Workflow title', WORKFLOW_TITLE_MAX_LENGTH),
      instructions: boundedText(draft.instructions, 'Workflow instructions', WORKFLOW_MAX_TEXT),
      agentName: boundedText(draft.agentName || 'build', 'Workflow agent', 256),
      skillNames: normalizeWorkflowStringList(draft.skillNames, 'Workflow skillNames'),
      toolIds: normalizeWorkflowStringList(draft.toolIds, 'Workflow toolIds'),
      projectDirectory: boundedOptionalText(draft.projectDirectory, 'Workflow projectDirectory', WORKFLOW_FIELD_MAX_LENGTH),
      draftSessionId: boundedOptionalText(draft.draftSessionId, 'Workflow draftSessionId', 256),
      triggers,
    }
  }

  private normalizeWorkflowTriggers(value: unknown): WorkflowTrigger[] {
    if (!Array.isArray(value) || value.length === 0) {
      throw new Error('Workflow requires at least one trigger.')
    }
    return value.slice(0, 8).map((entry) => {
      const trigger = asRecord(entry)
      const type = readString(trigger.type) as WorkflowTriggerType
      if (!WORKFLOW_VALID_TRIGGER_TYPES.has(type)) throw new Error('Workflow trigger type is invalid.')
      const normalized: WorkflowTrigger = {
        id: readString(trigger.id, this.ids.randomUUID()),
        type,
        enabled: trigger.enabled !== false,
        schedule: null,
        webhookSecret: null,
      }
      if (type === 'schedule') {
        const schedule = asRecord(trigger.schedule) as unknown as WorkflowTrigger['schedule']
        if (!schedule) throw new Error('Scheduled workflow trigger requires a schedule.')
        const scheduleError = validateWorkflowSchedule(schedule)
        if (scheduleError) throw new Error(scheduleError)
        normalized.schedule = schedule
      }
      if (type === 'webhook') {
        normalized.webhookSecret = readNullableString(trigger.webhookSecret) || this.ids.randomUUID()
      }
      return normalized
    })
  }

  private assertWorkflowDraftAllowed(draft: WorkflowDraft) {
    if (!includesAllowed(draft.agentName, this.policy.allowedAgents)) {
      throw new Error(`Agent "${draft.agentName}" is not enabled for cloud profile "${this.policy.profileName}".`)
    }
    for (const toolId of draft.toolIds || []) {
      if (!includesAllowed(toolId, this.policy.allowedTools)) {
        throw new Error(`Tool "${toolId}" is not enabled for cloud profile "${this.policy.profileName}".`)
      }
    }
    if (draft.projectDirectory) {
      const verdict = evaluateCloudProjectDirectoryPolicy(draft.projectDirectory, this.policy)
      if (!verdict.allowed) throw new Error(verdict.reason || 'Workflow project directory is not allowed.')
    }
  }

  private async startClaimedWorkflowRun(claimed: ClaimedWorkflowRunRecord): Promise<CloudWorkflowStartResult> {
    return this.startWorkflowRun(claimed.workflow, claimed.run)
  }

  private async startWorkflowRun(
    workflow: CloudWorkflowRecord,
    run: CloudWorkflowRunRecord,
  ): Promise<CloudWorkflowStartResult> {
    const session = await this.createCloudSessionRecord({
      tenantId: workflow.tenantId,
      userId: workflow.userId,
      profileName: this.policy.profileName,
      title: `Run ${workflow.title}`,
    })
    const attached = await this.store.attachWorkflowRunSession({
      tenantId: workflow.tenantId,
      workflowId: workflow.id,
      runId: run.id,
      sessionId: session.sessionId,
    })
    const command = await this.store.enqueueSessionCommand({
      commandId: this.ids.randomUUID(),
      tenantId: workflow.tenantId,
      userId: workflow.userId,
      sessionId: session.sessionId,
      kind: 'prompt',
      payload: {
        text: workflow.instructions,
        agent: workflow.agentName,
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

  private workflowSummaryFromRuntimeEvents(events: CloudRuntimeEvent[]) {
    const assistant = events
      .slice()
      .reverse()
      .find((event) => event.type === 'assistant.message')
    const content = assistant ? readString(asRecord(assistant.payload).content) : ''
    return content ? content.slice(0, 500) : null
  }

  private async completeWorkflowRunForSession(tenantId: string, sessionId: string, summary: string | null) {
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
      finishedAt: now,
    })
  }

  private async failWorkflowRunForSession(tenantId: string, sessionId: string, error: string) {
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
      finishedAt: now,
    })
  }

  private nextWorkflowStatusAfterRun(workflow: CloudWorkflowRecord): WorkflowStatus {
    return workflow.status === 'paused' || workflow.status === 'archived'
      ? workflow.status
      : 'active'
  }

  private assertWorkflowsEnabled() {
    if (!this.policy.features.workflows) {
      throw new Error('Workflows are disabled for this cloud profile.')
    }
  }

  private assertThreadIndexEnabled() {
    if (!this.policy.features.threadIndex) {
      throw new Error('Thread index is disabled for this cloud profile.')
    }
  }

  private assertSettingsEnabled() {
    if (!this.policy.features.settings) {
      throw new Error('Settings are disabled for this cloud profile.')
    }
  }

  private assertCapabilitiesEnabled() {
    if (!this.policy.features.agents && !this.policy.features.customSkills && !this.policy.features.customMcps) {
      throw new Error('Capabilities are disabled for this cloud profile.')
    }
  }

  private filterCapabilityTool(tool: CapabilityTool): CapabilityTool | null {
    if (tool.source === 'custom' && !this.policy.features.customMcps) return null
    if (!includesAllowed(tool.id, this.policy.allowedTools)) return null
    if (tool.kind === 'mcp' && !includesAllowed(tool.namespace || tool.id, this.policy.allowedMcps)) return null
    return {
      ...tool,
      agentNames: this.policy.features.agents
        ? this.filterAgentNames(tool.agentNames)
        : [],
    }
  }

  private filterCapabilitySkill(skill: CapabilitySkill): CapabilitySkill | null {
    if (skill.source === 'custom' && !this.policy.features.customSkills) return null
    if (this.policy.allowedTools && skill.toolIds?.length) {
      const hasAllowedTool = skill.toolIds.some((toolId) => this.policy.allowedTools?.includes(toolId))
      if (!hasAllowedTool) return null
    }
    return {
      ...skill,
      agentNames: this.policy.features.agents
        ? this.filterAgentNames(skill.agentNames)
        : [],
    }
  }

  private filterAgentNames(agentNames: string[]) {
    return this.policy.allowedAgents
      ? agentNames.filter((agentName) => this.policy.allowedAgents?.includes(agentName))
      : agentNames
  }

  private async requireOwnedSessions(principal: CloudPrincipal, sessionIds: string[]) {
    for (const sessionId of sessionIds) {
      const session = await this.store.getSession(principal.tenantId, principal.userId, sessionId)
      if (!session) throw new Error(`Unknown session ${sessionId}.`)
    }
  }
}

export type CloudWorkerCheckpointHooks = {
  restoreBeforeCommands?: (lease: WorkerLeaseRecord) => Promise<void>
  saveAfterCommand?: (lease: WorkerLeaseRecord) => Promise<void>
}

export class CloudWorker {
  private readonly leases = new Map<string, WorkerLeaseRecord>()
  private readonly restoredLeaseTokens = new Set<string>()
  private readonly store: ControlPlaneStore
  private readonly service: CloudSessionService
  private readonly workerId: string
  private readonly leaseTtlMs: number
  private readonly checkpointHooks: CloudWorkerCheckpointHooks

  constructor(
    store: ControlPlaneStore,
    service: CloudSessionService,
    workerId: string,
    leaseTtlMs = 30_000,
    checkpointHooks: CloudWorkerCheckpointHooks = {},
  ) {
    this.store = store
    this.service = service
    this.workerId = workerId
    this.leaseTtlMs = leaseTtlMs
    this.checkpointHooks = checkpointHooks
  }

  async processSessionCommands(tenantId: string, sessionId: string): Promise<number> {
    let lease = await this.getOrClaimLease(tenantId, sessionId)
    if (!lease) return 0
    let processed = 0
    await this.restoreCheckpointOnce(lease)
    await this.store.recordWorkerHeartbeat({
      workerId: this.workerId,
      role: 'worker',
      activeSessionIds: [sessionId],
    })
    while (true) {
      const command = await this.store.claimNextSessionCommand(lease)
      if (!command) break
      await this.service.executeCommand(lease, command)
      lease = await this.store.checkpointSession(lease)
      await this.checkpointHooks.saveAfterCommand?.(lease)
      this.leases.set(this.leaseKey(tenantId, sessionId), lease)
      processed += 1
    }
    return processed
  }

  async processAllSessionCommands(): Promise<number> {
    let processed = 0
    for (const session of await this.store.listAllSessions()) {
      processed += await this.processSessionCommands(session.tenantId, session.sessionId)
    }
    return processed
  }

  async appendRuntimeEvent(tenantId: string, sessionId: string, event: CloudRuntimeEvent): Promise<boolean> {
    let lease = await this.getOrClaimLease(tenantId, sessionId)
    if (!lease) return false
    await this.service.appendRuntimeEvent({
      tenantId,
      sessionId,
      event,
      leaseToken: lease.leaseToken,
    })
    lease = await this.store.checkpointSession(lease)
    await this.checkpointHooks.saveAfterCommand?.(lease)
    this.leases.set(this.leaseKey(tenantId, sessionId), lease)
    return true
  }

  private async restoreCheckpointOnce(lease: WorkerLeaseRecord) {
    if (!this.checkpointHooks.restoreBeforeCommands || this.restoredLeaseTokens.has(lease.leaseToken)) return
    await this.checkpointHooks.restoreBeforeCommands(lease)
    this.restoredLeaseTokens.add(lease.leaseToken)
  }

  private async getOrClaimLease(tenantId: string, sessionId: string): Promise<WorkerLeaseRecord | null> {
    const leaseKey = this.leaseKey(tenantId, sessionId)
    const existing = this.leases.get(leaseKey)
    if (existing) {
      try {
        const renewed = await this.store.renewSessionLease(existing, new Date(), this.leaseTtlMs)
        this.leases.set(leaseKey, renewed)
        return renewed
      } catch {
        this.leases.delete(leaseKey)
      }
    }
    const claimed = await this.store.claimSessionLease(tenantId, sessionId, this.workerId, new Date(), this.leaseTtlMs)
    if (claimed) this.leases.set(leaseKey, claimed)
    return claimed
  }

  private leaseKey(tenantId: string, sessionId: string) {
    return `${tenantId}\0${sessionId}`
  }
}

export class CloudScheduler {
  private readonly store: ControlPlaneStore
  private readonly service: CloudSessionService
  private readonly schedulerId: string

  constructor(
    store: ControlPlaneStore,
    service: CloudSessionService,
    schedulerId: string,
  ) {
    this.store = store
    this.service = service
    this.schedulerId = schedulerId
  }

  async processDueWorkflows(now = new Date()): Promise<number> {
    let claimed = 0
    const activeSessionIds: string[] = []
    await this.store.recordWorkerHeartbeat({
      workerId: this.schedulerId,
      role: 'scheduler',
      activeSessionIds,
      now,
    })
    while (true) {
      const started = await this.service.claimAndStartDueWorkflow(now)
      if (!started) break
      claimed += 1
      activeSessionIds.push(started.sessionId)
      await this.store.recordWorkerHeartbeat({
        workerId: this.schedulerId,
        role: 'scheduler',
        activeSessionIds,
        now,
      })
    }
    return claimed
  }
}
