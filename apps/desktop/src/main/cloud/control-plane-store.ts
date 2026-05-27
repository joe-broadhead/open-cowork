import type {
  WorkflowDraft,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowStatus,
  WorkflowSummary,
  WorkflowTriggerType,
} from '@open-cowork/shared'

export type ControlPlaneRole = 'owner' | 'member'
export type ControlPlaneSessionStatus = 'idle' | 'running' | 'closed' | 'errored'
export type ControlPlaneCommandKind = 'prompt' | 'abort' | 'permission.respond' | 'question.reply' | 'question.reject'
export type ControlPlaneCommandStatus = 'pending' | 'running' | 'acked' | 'failed'
export type WorkerRole = 'all-in-one' | 'web' | 'worker' | 'scheduler'

export type TenantRecord = {
  tenantId: string
  name: string
  createdAt: string
}

export type UserRecord = {
  tenantId: string
  userId: string
  email: string
  role: ControlPlaneRole
  createdAt: string
}

export type SessionRecord = {
  tenantId: string
  userId: string
  sessionId: string
  opencodeSessionId: string
  profileName: string
  status: ControlPlaneSessionStatus
  title: string | null
  createdAt: string
  updatedAt: string
}

export type SessionEventRecord = {
  tenantId: string
  sessionId: string
  eventId: string
  sequence: number
  type: string
  payload: Record<string, unknown>
  createdAt: string
}

export type WorkspaceEventRecord = {
  tenantId: string
  userId: string
  sessionId: string | null
  eventId: string
  sequence: number
  entityType: string
  entityId: string
  operation: string
  projectionVersion: number
  type: string
  payload: Record<string, unknown>
  createdAt: string
}

export type SessionProjectionRecord = {
  tenantId: string
  sessionId: string
  sequence: number
  view: Record<string, unknown>
  updatedAt: string
}

export type WorkerLeaseRecord = {
  tenantId: string
  sessionId: string
  leasedBy: string
  leaseToken: string
  leaseExpiresAt: number
  checkpointVersion: number
}

export type SessionCommandRecord = {
  commandId: string
  tenantId: string
  userId: string
  sessionId: string
  kind: ControlPlaneCommandKind
  payload: Record<string, unknown>
  targetLeaseToken: string | null
  createdSequence: number
  createdAt: string
  status: ControlPlaneCommandStatus
  claimedBy: string | null
  claimedLeaseToken: string | null
  ackedAt: string | null
  error: string | null
}

export type WorkerHeartbeatRecord = {
  workerId: string
  role: WorkerRole
  activeSessionIds: string[]
  lastSeenAt: string
}

export type SettingMetadataRecord = {
  tenantId: string
  userId: string | null
  key: string
  value: Record<string, unknown>
  updatedAt: string
}

export type ThreadTagRecord = {
  tenantId: string
  tagId: string
  name: string
  color: string
  createdAt: string
  updatedAt: string
}

export type ThreadSmartFilterRecord = {
  tenantId: string
  filterId: string
  name: string
  query: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type ThreadMetadataRecord = {
  tenantId: string
  userId: string
  sessionId: string
  title: string | null
  profileName: string
  status: ControlPlaneSessionStatus
  createdAt: string
  updatedAt: string
  tags: ThreadTagRecord[]
}

export type CloudWorkflowRecord = WorkflowSummary & {
  tenantId: string
  userId: string
}

export type CloudWorkflowRunRecord = WorkflowRun & {
  tenantId: string
  userId: string
}

export type ClaimedWorkflowRunRecord = {
  workflow: CloudWorkflowRecord
  run: CloudWorkflowRunRecord
}

export type SchemaMigrationRecord = {
  id: string
  appliedAt: string
}

type SessionState = {
  record: SessionRecord
  nextEventSequence: number
  nextCommandSequence: number
  nextLeaseAttempt: number
  lease: WorkerLeaseRecord | null
  events: SessionEventRecord[]
  projection: SessionProjectionRecord | null
  commands: SessionCommandRecord[]
}

type WorkflowState = {
  record: CloudWorkflowRecord
  runs: CloudWorkflowRunRecord[]
}

export type CreateSessionInput = {
  tenantId: string
  userId: string
  sessionId: string
  opencodeSessionId: string
  profileName: string
  title?: string | null
  createdAt?: Date
}

export type AppendEventInput = {
  tenantId: string
  sessionId: string
  eventId?: string
  type: string
  payload?: Record<string, unknown>
  createdAt?: Date
}

export type AppendWorkspaceEventInput = {
  tenantId: string
  userId: string
  sessionId?: string | null
  eventId?: string
  entityType?: string
  entityId?: string
  operation?: string
  projectionVersion?: number
  type: string
  payload?: Record<string, unknown>
  createdAt?: Date
}

export type WriteProjectionInput = {
  tenantId: string
  sessionId: string
  sequence: number
  view: Record<string, unknown>
  leaseToken?: string | null
  updatedAt?: Date
}

export type EnqueueCommandInput = {
  commandId: string
  tenantId: string
  userId: string
  sessionId: string
  kind: ControlPlaneCommandKind
  payload?: Record<string, unknown>
  targetLeaseToken?: string | null
  createdAt?: Date
}

export type CreateWorkflowInput = {
  tenantId: string
  userId: string
  workflowId: string
  draft: WorkflowDraft
  nextRunAt?: string | null
  createdAt?: Date
}

export type CreateWorkflowRunInput = {
  tenantId: string
  userId: string
  workflowId: string
  runId: string
  triggerType: WorkflowTriggerType
  triggerPayload?: Record<string, unknown> | null
  createdAt?: Date
}

export type UpdateWorkflowStatusInput = {
  tenantId: string
  userId: string
  workflowId: string
  status: WorkflowStatus
  nextRunAt?: string | null
  updatedAt?: Date
}

export type ClaimDueWorkflowRunInput = {
  runId: string
  now?: Date
}

export type AttachWorkflowRunSessionInput = {
  tenantId: string
  workflowId: string
  runId: string
  sessionId: string
  startedAt?: Date
}

export type CompleteWorkflowRunInput = {
  tenantId: string
  workflowId: string
  runId: string
  summary: string | null
  nextStatus: WorkflowStatus
  nextRunAt: string | null
  finishedAt?: Date
}

export type FailWorkflowRunInput = {
  tenantId: string
  workflowId: string
  runId: string
  error: string
  nextStatus: WorkflowStatus
  nextRunAt: string | null
  finishedAt?: Date
}

export type CreateThreadTagInput = {
  tenantId: string
  tagId: string
  name: string
  color?: string | null
  createdAt?: Date
}

export type UpdateThreadTagInput = {
  tenantId: string
  tagId: string
  name?: string
  color?: string | null
  updatedAt?: Date
}

export type ThreadTagLinkInput = {
  tenantId: string
  sessionIds: string[]
  tagIds: string[]
  createdAt?: Date
}

export type CreateThreadSmartFilterInput = {
  tenantId: string
  filterId: string
  name: string
  query: Record<string, unknown>
  createdAt?: Date
}

export type UpdateThreadSmartFilterInput = {
  tenantId: string
  filterId: string
  name?: string
  query?: Record<string, unknown>
  updatedAt?: Date
}

export type MaybePromise<T> = T | Promise<T>

export type ControlPlaneStore = {
  createTenant(input: { tenantId: string, name: string, createdAt?: Date }): MaybePromise<TenantRecord>
  ensureUser(input: {
    tenantId: string
    userId: string
    email: string
    role?: ControlPlaneRole
    createdAt?: Date
  }): MaybePromise<UserRecord>
  createSession(input: CreateSessionInput): MaybePromise<SessionRecord>
  getSession(tenantId: string, userId: string, sessionId: string): MaybePromise<SessionRecord | null>
  getSessionForTenant(tenantId: string, sessionId: string): MaybePromise<SessionRecord | null>
  findSession(sessionId: string): MaybePromise<SessionRecord | null>
  listSessions(tenantId: string, userId: string): MaybePromise<SessionRecord[]>
  listAllSessions(): MaybePromise<SessionRecord[]>
  bindSessionRuntime(input: {
    tenantId: string
    sessionId: string
    opencodeSessionId: string
    title?: string | null
    updatedAt?: Date
  }): MaybePromise<SessionRecord>
  updateSessionStatus(input: {
    tenantId: string
    sessionId: string
    status: ControlPlaneSessionStatus
    title?: string | null
    updatedAt?: Date
  }): MaybePromise<SessionRecord>
  appendSessionEvent(input: AppendEventInput): MaybePromise<SessionEventRecord>
  listSessionEvents(tenantId: string, sessionId: string, afterSequence?: number): MaybePromise<SessionEventRecord[]>
  appendWorkspaceEvent(input: AppendWorkspaceEventInput): MaybePromise<WorkspaceEventRecord>
  listWorkspaceEvents(tenantId: string, userId: string, afterSequence?: number): MaybePromise<WorkspaceEventRecord[]>
  writeSessionProjection(input: WriteProjectionInput): MaybePromise<SessionProjectionRecord>
  getSessionProjection(tenantId: string, sessionId: string): MaybePromise<SessionProjectionRecord | null>
  claimSessionLease(
    tenantId: string,
    sessionId: string,
    workerId: string,
    now?: Date,
    ttlMs?: number,
  ): MaybePromise<WorkerLeaseRecord | null>
  renewSessionLease(lease: WorkerLeaseRecord, now?: Date, ttlMs?: number): MaybePromise<WorkerLeaseRecord>
  checkpointSession(lease: WorkerLeaseRecord): MaybePromise<WorkerLeaseRecord>
  enqueueSessionCommand(input: EnqueueCommandInput): MaybePromise<SessionCommandRecord>
  claimNextSessionCommand(lease: WorkerLeaseRecord): MaybePromise<SessionCommandRecord | null>
  ackSessionCommand(lease: WorkerLeaseRecord, commandId: string, now?: Date): MaybePromise<SessionCommandRecord>
  failSessionCommand(lease: WorkerLeaseRecord, commandId: string, error: string): MaybePromise<SessionCommandRecord>
  recordWorkerHeartbeat(input: {
    workerId: string
    role: WorkerRole
    activeSessionIds?: string[]
    now?: Date
  }): MaybePromise<WorkerHeartbeatRecord>
  listWorkerHeartbeats(): MaybePromise<WorkerHeartbeatRecord[]>
  setSettingMetadata(input: {
    tenantId: string
    userId?: string | null
    key: string
    value: Record<string, unknown>
    updatedAt?: Date
  }): MaybePromise<SettingMetadataRecord>
  getSettingMetadata(tenantId: string, keyName: string, userId?: string | null): MaybePromise<SettingMetadataRecord | null>
  listSettingMetadata(tenantId: string, userId?: string | null): MaybePromise<SettingMetadataRecord[]>
  createWorkflow(input: CreateWorkflowInput): MaybePromise<CloudWorkflowRecord>
  findWorkflow(workflowId: string): MaybePromise<CloudWorkflowRecord | null>
  listWorkflows(tenantId: string, userId: string): MaybePromise<CloudWorkflowRecord[]>
  getWorkflow(tenantId: string, userId: string, workflowId: string): MaybePromise<CloudWorkflowRecord | null>
  getWorkflowForTenant(tenantId: string, workflowId: string): MaybePromise<CloudWorkflowRecord | null>
  updateWorkflowStatus(input: UpdateWorkflowStatusInput): MaybePromise<CloudWorkflowRecord | null>
  listWorkflowRuns(tenantId: string, workflowId: string, limit?: number): MaybePromise<CloudWorkflowRunRecord[]>
  createWorkflowRun(input: CreateWorkflowRunInput): MaybePromise<CloudWorkflowRunRecord>
  claimDueWorkflowRun(input: ClaimDueWorkflowRunInput): MaybePromise<ClaimedWorkflowRunRecord | null>
  attachWorkflowRunSession(input: AttachWorkflowRunSessionInput): MaybePromise<CloudWorkflowRunRecord | null>
  completeWorkflowRun(input: CompleteWorkflowRunInput): MaybePromise<CloudWorkflowRunRecord | null>
  failWorkflowRun(input: FailWorkflowRunInput): MaybePromise<CloudWorkflowRunRecord | null>
  getWorkflowRun(tenantId: string, runId: string): MaybePromise<CloudWorkflowRunRecord | null>
  getWorkflowRunBySession(tenantId: string, sessionId: string): MaybePromise<CloudWorkflowRunRecord | null>
  listThreadTags(tenantId: string): MaybePromise<ThreadTagRecord[]>
  createThreadTag(input: CreateThreadTagInput): MaybePromise<ThreadTagRecord>
  updateThreadTag(input: UpdateThreadTagInput): MaybePromise<ThreadTagRecord | null>
  deleteThreadTag(tenantId: string, tagId: string): MaybePromise<boolean>
  applyThreadTags(input: ThreadTagLinkInput): MaybePromise<void>
  removeThreadTags(input: ThreadTagLinkInput): MaybePromise<void>
  listThreadSmartFilters(tenantId: string): MaybePromise<ThreadSmartFilterRecord[]>
  createThreadSmartFilter(input: CreateThreadSmartFilterInput): MaybePromise<ThreadSmartFilterRecord>
  updateThreadSmartFilter(input: UpdateThreadSmartFilterInput): MaybePromise<ThreadSmartFilterRecord | null>
  deleteThreadSmartFilter(tenantId: string, filterId: string): MaybePromise<boolean>
  listThreadMetadata(input: {
    tenantId: string
    userId: string
    tagIds?: string[]
    limit?: number
  }): MaybePromise<ThreadMetadataRecord[]>
  recordSchemaMigration(id: string, appliedAt?: Date): MaybePromise<SchemaMigrationRecord>
  listSchemaMigrations(): MaybePromise<SchemaMigrationRecord[]>
  close?(): MaybePromise<void>
}

const THREAD_TAG_NAME_MAX_LENGTH = 48
const THREAD_SMART_FILTER_NAME_MAX_LENGTH = 64
const THREAD_DEFAULT_TAG_COLOR = '#64748b'
const THREAD_FILTER_MAX_VALUES = 50
const THREAD_BULK_MAX_SESSION_IDS = 500
const SMART_FILTER_QUERY_MAX_BYTES = 16_384
const WORKFLOW_RUN_LIST_LIMIT = 100

function nowIso(now: Date | undefined) {
  return (now || new Date()).toISOString()
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([field, entry]) => `${JSON.stringify(field)}:${stableJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function key(...parts: string[]) {
  return parts.join('\0')
}

function workspaceOperationFromType(type: string) {
  if (/\b(created|submitted|uploaded|started)\b/.test(type)) return 'create'
  if (/\b(deleted|removed|archived)\b/.test(type)) return 'delete'
  return 'update'
}

function optionalTrimmedText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function normalizeText(value: unknown, maxLength: number, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
  const normalized = value.trim()
  if (normalized.length > maxLength) {
    throw new Error(`${label} exceeds ${maxLength} characters.`)
  }
  return normalized
}

function normalizeOptionalText(value: unknown, maxLength: number, label: string) {
  if (value === undefined) return undefined
  return normalizeText(value, maxLength, label)
}

function normalizeTagColor(value: unknown) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value.trim())
    ? value.trim()
    : THREAD_DEFAULT_TAG_COLOR
}

function normalizeIdList(values: readonly unknown[], label: string, maxLength: number) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array.`)
  if (values.length > maxLength) throw new Error(`${label} exceeds ${maxLength} entries.`)
  return [...new Set(values.map((value) => normalizeText(value, 256, label)))]
}

function normalizeThreadQuery(value: unknown) {
  const query = value && typeof value === 'object' && !Array.isArray(value)
    ? clone(value as Record<string, unknown>)
    : {}
  const serialized = stableJson(query)
  if (Buffer.byteLength(serialized, 'utf8') > SMART_FILTER_QUERY_MAX_BYTES) {
    throw new Error(`Smart filter query exceeds ${SMART_FILTER_QUERY_MAX_BYTES} bytes.`)
  }
  return query
}

export class InMemoryControlPlaneStore implements ControlPlaneStore {
  private readonly tenants = new Map<string, TenantRecord>()
  private readonly users = new Map<string, UserRecord>()
  private readonly sessions = new Map<string, SessionState>()
  private readonly heartbeats = new Map<string, WorkerHeartbeatRecord>()
  private readonly settings = new Map<string, SettingMetadataRecord>()
  private readonly workflows = new Map<string, WorkflowState>()
  private readonly workflowRuns = new Map<string, CloudWorkflowRunRecord>()
  private readonly threadTags = new Map<string, ThreadTagRecord>()
  private readonly threadTagLinks = new Map<string, Set<string>>()
  private readonly threadSmartFilters = new Map<string, ThreadSmartFilterRecord>()
  private readonly migrations = new Map<string, SchemaMigrationRecord>()
  private readonly workspaceEvents = new Map<string, { nextSequence: number, events: WorkspaceEventRecord[] }>()

  createTenant(input: { tenantId: string, name: string, createdAt?: Date }): TenantRecord {
    const existing = this.tenants.get(input.tenantId)
    if (existing) return clone(existing)
    const record: TenantRecord = {
      tenantId: input.tenantId,
      name: input.name,
      createdAt: nowIso(input.createdAt),
    }
    this.tenants.set(input.tenantId, record)
    return clone(record)
  }

  ensureUser(input: {
    tenantId: string
    userId: string
    email: string
    role?: ControlPlaneRole
    createdAt?: Date
  }): UserRecord {
    this.requireTenant(input.tenantId)
    const userKey = key(input.tenantId, input.userId)
    const existing = this.users.get(userKey)
    if (existing) return clone(existing)
    const record: UserRecord = {
      tenantId: input.tenantId,
      userId: input.userId,
      email: input.email,
      role: input.role || 'member',
      createdAt: nowIso(input.createdAt),
    }
    this.users.set(userKey, record)
    return clone(record)
  }

  createSession(input: CreateSessionInput): SessionRecord {
    this.requireTenantUser(input.tenantId, input.userId)
    const sessionKey = key(input.tenantId, input.sessionId)
    const existing = this.sessions.get(sessionKey)
    if (existing) return clone(existing.record)
    const createdAt = nowIso(input.createdAt)
    const record: SessionRecord = {
      tenantId: input.tenantId,
      userId: input.userId,
      sessionId: input.sessionId,
      opencodeSessionId: input.opencodeSessionId,
      profileName: input.profileName,
      status: 'idle',
      title: input.title || null,
      createdAt,
      updatedAt: createdAt,
    }
    this.sessions.set(sessionKey, {
      record,
      nextEventSequence: 0,
      nextCommandSequence: 0,
      nextLeaseAttempt: 0,
      lease: null,
      events: [],
      projection: null,
      commands: [],
    })
    return clone(record)
  }

  getSession(tenantId: string, userId: string, sessionId: string): SessionRecord | null {
    this.requireTenantUser(tenantId, userId)
    const record = this.sessions.get(key(tenantId, sessionId))?.record || null
    if (!record || record.userId !== userId) return null
    return clone(record)
  }

  getSessionForTenant(tenantId: string, sessionId: string): SessionRecord | null {
    this.requireTenant(tenantId)
    return clone(this.sessions.get(key(tenantId, sessionId))?.record || null)
  }

  findSession(sessionId: string): SessionRecord | null {
    for (const session of this.sessions.values()) {
      if (session.record.sessionId === sessionId || session.record.opencodeSessionId === sessionId) {
        return clone(session.record)
      }
    }
    return null
  }

  listSessions(tenantId: string, userId: string): SessionRecord[] {
    this.requireTenantUser(tenantId, userId)
    return Array.from(this.sessions.values())
      .filter((session) => session.record.tenantId === tenantId && session.record.userId === userId)
      .map((session) => clone(session.record))
  }

  listAllSessions(): SessionRecord[] {
    return Array.from(this.sessions.values()).map((session) => clone(session.record))
  }

  bindSessionRuntime(input: {
    tenantId: string
    sessionId: string
    opencodeSessionId: string
    title?: string | null
    updatedAt?: Date
  }): SessionRecord {
    const session = this.requireSession(input.tenantId, input.sessionId)
    session.record.opencodeSessionId = input.opencodeSessionId
    if (input.title !== undefined) session.record.title = input.title
    session.record.updatedAt = nowIso(input.updatedAt)
    return clone(session.record)
  }

  updateSessionStatus(input: {
    tenantId: string
    sessionId: string
    status: ControlPlaneSessionStatus
    title?: string | null
    updatedAt?: Date
  }): SessionRecord {
    const session = this.requireSession(input.tenantId, input.sessionId)
    session.record.status = input.status
    if (input.title !== undefined) session.record.title = input.title
    session.record.updatedAt = nowIso(input.updatedAt)
    return clone(session.record)
  }

  appendSessionEvent(input: AppendEventInput): SessionEventRecord {
    const session = this.requireSession(input.tenantId, input.sessionId)
    const payload = input.payload || {}
    const eventId = input.eventId || `${input.sessionId}:${session.nextEventSequence + 1}`
    const existing = session.events.find((event) => event.eventId === eventId)
    if (existing) {
      if (
        existing.type !== input.type
        || stableJson(existing.payload) !== stableJson(payload)
      ) {
        throw new Error(`Event id ${eventId} was reused with different content.`)
      }
      return clone(existing)
    }
    const event: SessionEventRecord = {
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      eventId,
      sequence: session.nextEventSequence += 1,
      type: input.type,
      payload,
      createdAt: nowIso(input.createdAt),
    }
    session.events.push(event)
    session.record.updatedAt = event.createdAt
    return clone(event)
  }

  listSessionEvents(tenantId: string, sessionId: string, afterSequence = 0): SessionEventRecord[] {
    const session = this.requireSession(tenantId, sessionId)
    return session.events
      .filter((event) => event.sequence > afterSequence)
      .map((event) => clone(event))
  }

  appendWorkspaceEvent(input: AppendWorkspaceEventInput): WorkspaceEventRecord {
    this.requireTenantUser(input.tenantId, input.userId)
    if (input.sessionId) {
      const session = this.requireSession(input.tenantId, input.sessionId)
      if (session.record.userId !== input.userId) {
        throw new Error(`Session ${input.sessionId} does not belong to user ${input.userId}.`)
      }
    }
    const workspaceKey = `${input.tenantId}:${input.userId}`
    const state = this.workspaceEvents.get(workspaceKey) || { nextSequence: 0, events: [] }
    const payload = input.payload || {}
    const eventId = input.eventId || `${input.userId}:${state.nextSequence + 1}`
    const sequence = state.nextSequence + 1
    const entityType = optionalTrimmedText(input.entityType) || (input.sessionId ? 'session' : 'workspace')
    const entityId = optionalTrimmedText(input.entityId) || input.sessionId || input.userId
    const operation = optionalTrimmedText(input.operation) || workspaceOperationFromType(input.type)
    const projectionVersion = Number.isFinite(input.projectionVersion)
      ? Math.max(0, Math.floor(input.projectionVersion || 0))
      : sequence
    const existing = state.events.find((event) => event.eventId === eventId)
    if (existing) {
      const expectedProjectionVersion = Number.isFinite(input.projectionVersion)
        ? projectionVersion
        : existing.projectionVersion
      if (
        existing.type !== input.type
        || stableJson(existing.payload) !== stableJson(payload)
        || (existing.sessionId || null) !== (input.sessionId || null)
        || existing.entityType !== entityType
        || existing.entityId !== entityId
        || existing.operation !== operation
        || existing.projectionVersion !== expectedProjectionVersion
      ) {
        throw new Error(`Workspace event id ${eventId} was reused with different content.`)
      }
      return clone(existing)
    }
    const event: WorkspaceEventRecord = {
      tenantId: input.tenantId,
      userId: input.userId,
      sessionId: input.sessionId || null,
      eventId,
      sequence,
      entityType,
      entityId,
      operation,
      projectionVersion,
      type: input.type,
      payload,
      createdAt: nowIso(input.createdAt),
    }
    state.nextSequence = sequence
    state.events.push(event)
    this.workspaceEvents.set(workspaceKey, state)
    return clone(event)
  }

  listWorkspaceEvents(tenantId: string, userId: string, afterSequence = 0): WorkspaceEventRecord[] {
    this.requireTenantUser(tenantId, userId)
    const workspaceKey = `${tenantId}:${userId}`
    return (this.workspaceEvents.get(workspaceKey)?.events || [])
      .filter((event) => event.sequence > afterSequence)
      .map((event) => clone(event))
  }

  writeSessionProjection(input: WriteProjectionInput): SessionProjectionRecord {
    const session = this.requireSession(input.tenantId, input.sessionId)
    if (session.lease && session.lease.leaseToken !== input.leaseToken) {
      throw new Error('Projection write used a stale worker lease.')
    }
    if (input.sequence < (session.projection?.sequence || 0)) {
      throw new Error('Projection sequence must be monotonic.')
    }
    if (input.sequence === session.projection?.sequence) {
      if (stableJson(session.projection.view) !== stableJson(input.view)) {
        throw new Error('Projection sequence was reused with different content.')
      }
      return clone(session.projection)
    }
    const projection: SessionProjectionRecord = {
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      sequence: input.sequence,
      view: input.view,
      updatedAt: nowIso(input.updatedAt),
    }
    session.projection = projection
    session.record.updatedAt = projection.updatedAt
    return clone(projection)
  }

  getSessionProjection(tenantId: string, sessionId: string): SessionProjectionRecord | null {
    const session = this.requireSession(tenantId, sessionId)
    return clone(session.projection)
  }

  claimSessionLease(
    tenantId: string,
    sessionId: string,
    workerId: string,
    now = new Date(),
    ttlMs = 30_000,
  ): WorkerLeaseRecord | null {
    const session = this.requireSession(tenantId, sessionId)
    const nowMs = now.getTime()
    if (session.lease && session.lease.leaseExpiresAt > nowMs) return null
    const attempt = session.nextLeaseAttempt += 1
    const lease: WorkerLeaseRecord = {
      tenantId,
      sessionId,
      leasedBy: workerId,
      leaseToken: `${tenantId}:${sessionId}:${attempt}:${workerId}`,
      leaseExpiresAt: nowMs + ttlMs,
      checkpointVersion: session.lease?.checkpointVersion || 0,
    }
    session.lease = lease
    session.record.status = 'running'
    session.record.updatedAt = now.toISOString()
    return clone(lease)
  }

  renewSessionLease(lease: WorkerLeaseRecord, now = new Date(), ttlMs = 30_000): WorkerLeaseRecord {
    const session = this.requireSession(lease.tenantId, lease.sessionId)
    this.assertCurrentLease(session, lease)
    session.lease = {
      ...session.lease!,
      leaseExpiresAt: now.getTime() + ttlMs,
    }
    return clone(session.lease)
  }

  checkpointSession(lease: WorkerLeaseRecord): WorkerLeaseRecord {
    const session = this.requireSession(lease.tenantId, lease.sessionId)
    this.assertCurrentLease(session, lease)
    if (lease.checkpointVersion !== session.lease?.checkpointVersion) {
      throw new Error('Checkpoint version is stale.')
    }
    session.lease = {
      ...session.lease!,
      checkpointVersion: session.lease!.checkpointVersion + 1,
    }
    return clone(session.lease)
  }

  enqueueSessionCommand(input: EnqueueCommandInput): SessionCommandRecord {
    this.requireTenantUser(input.tenantId, input.userId)
    const session = this.requireSession(input.tenantId, input.sessionId)
    const payload = input.payload || {}
    const existing = session.commands.find((command) => command.commandId === input.commandId)
    if (existing) {
      if (
        existing.userId !== input.userId
        || existing.kind !== input.kind
        || existing.targetLeaseToken !== (input.targetLeaseToken ?? null)
        || stableJson(existing.payload) !== stableJson(payload)
      ) {
        throw new Error(`Command id ${input.commandId} was reused with different content.`)
      }
      return clone(existing)
    }
    const command: SessionCommandRecord = {
      commandId: input.commandId,
      tenantId: input.tenantId,
      userId: input.userId,
      sessionId: input.sessionId,
      kind: input.kind,
      payload,
      targetLeaseToken: input.targetLeaseToken ?? null,
      createdSequence: session.nextCommandSequence += 1,
      createdAt: nowIso(input.createdAt),
      status: 'pending',
      claimedBy: null,
      claimedLeaseToken: null,
      ackedAt: null,
      error: null,
    }
    session.commands.push(command)
    return clone(command)
  }

  claimNextSessionCommand(lease: WorkerLeaseRecord): SessionCommandRecord | null {
    const session = this.requireSession(lease.tenantId, lease.sessionId)
    this.assertCurrentLease(session, lease)
    const command = session.commands.find((entry) => (
      (entry.status === 'pending'
        && (entry.targetLeaseToken === null || entry.targetLeaseToken === lease.leaseToken))
      || (entry.status === 'running'
        && entry.claimedLeaseToken !== lease.leaseToken
        && entry.targetLeaseToken === null)
    ))
    if (!command) return null
    command.status = 'running'
    command.claimedBy = lease.leasedBy
    command.claimedLeaseToken = lease.leaseToken
    return clone(command)
  }

  ackSessionCommand(lease: WorkerLeaseRecord, commandId: string, now = new Date()): SessionCommandRecord {
    const session = this.requireSession(lease.tenantId, lease.sessionId)
    this.assertCurrentLease(session, lease)
    const command = this.requireCommand(session, commandId)
    if (command.status === 'acked') return clone(command)
    if (command.status !== 'running' || command.claimedLeaseToken !== lease.leaseToken) {
      throw new Error(`Command ${commandId} is not owned by this worker.`)
    }
    command.status = 'acked'
    command.ackedAt = now.toISOString()
    command.error = null
    return clone(command)
  }

  failSessionCommand(lease: WorkerLeaseRecord, commandId: string, error: string): SessionCommandRecord {
    const session = this.requireSession(lease.tenantId, lease.sessionId)
    this.assertCurrentLease(session, lease)
    const command = this.requireCommand(session, commandId)
    if (command.status !== 'running' || command.claimedLeaseToken !== lease.leaseToken) {
      throw new Error(`Command ${commandId} is not owned by this worker.`)
    }
    command.status = 'failed'
    command.error = error
    return clone(command)
  }

  recordWorkerHeartbeat(input: {
    workerId: string
    role: WorkerRole
    activeSessionIds?: string[]
    now?: Date
  }): WorkerHeartbeatRecord {
    const record: WorkerHeartbeatRecord = {
      workerId: input.workerId,
      role: input.role,
      activeSessionIds: [...new Set(input.activeSessionIds || [])],
      lastSeenAt: nowIso(input.now),
    }
    this.heartbeats.set(input.workerId, record)
    return clone(record)
  }

  listWorkerHeartbeats(): WorkerHeartbeatRecord[] {
    return Array.from(this.heartbeats.values()).map((record) => clone(record))
  }

  setSettingMetadata(input: {
    tenantId: string
    userId?: string | null
    key: string
    value: Record<string, unknown>
    updatedAt?: Date
  }): SettingMetadataRecord {
    this.requireTenant(input.tenantId)
    if (input.userId) this.requireTenantUser(input.tenantId, input.userId)
    const record: SettingMetadataRecord = {
      tenantId: input.tenantId,
      userId: input.userId || null,
      key: input.key,
      value: input.value,
      updatedAt: nowIso(input.updatedAt),
    }
    this.settings.set(key(input.tenantId, input.userId || '', input.key), record)
    return clone(record)
  }

  getSettingMetadata(tenantId: string, keyName: string, userId?: string | null): SettingMetadataRecord | null {
    this.requireTenant(tenantId)
    return clone(this.settings.get(key(tenantId, userId || '', keyName)) || null)
  }

  listSettingMetadata(tenantId: string, userId?: string | null): SettingMetadataRecord[] {
    this.requireTenant(tenantId)
    if (userId) this.requireTenantUser(tenantId, userId)
    return Array.from(this.settings.values())
      .filter((setting) => setting.tenantId === tenantId && setting.userId === (userId || null))
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((setting) => clone(setting))
  }

  createWorkflow(input: CreateWorkflowInput): CloudWorkflowRecord {
    this.requireTenantUser(input.tenantId, input.userId)
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
    for (const workflow of this.workflows.values()) {
      if (workflow.record.id === workflowId) return clone(workflow.record)
    }
    return null
  }

  listWorkflows(tenantId: string, userId: string): CloudWorkflowRecord[] {
    this.requireTenantUser(tenantId, userId)
    return Array.from(this.workflows.values())
      .filter((workflow) => workflow.record.tenantId === tenantId && workflow.record.userId === userId)
      .sort((left, right) => right.record.updatedAt.localeCompare(left.record.updatedAt))
      .map((workflow) => clone(workflow.record))
  }

  getWorkflow(tenantId: string, userId: string, workflowId: string): CloudWorkflowRecord | null {
    this.requireTenantUser(tenantId, userId)
    const workflow = this.workflows.get(key(tenantId, workflowId))?.record || null
    if (!workflow || workflow.userId !== userId) return null
    return clone(workflow)
  }

  getWorkflowForTenant(tenantId: string, workflowId: string): CloudWorkflowRecord | null {
    this.requireTenant(tenantId)
    return clone(this.workflows.get(key(tenantId, workflowId))?.record || null)
  }

  updateWorkflowStatus(input: UpdateWorkflowStatusInput): CloudWorkflowRecord | null {
    this.requireTenantUser(input.tenantId, input.userId)
    const workflow = this.workflows.get(key(input.tenantId, input.workflowId))
    if (!workflow || workflow.record.userId !== input.userId) return null
    workflow.record.status = input.status
    workflow.record.nextRunAt = input.nextRunAt ?? null
    workflow.record.updatedAt = nowIso(input.updatedAt)
    return clone(workflow.record)
  }

  listWorkflowRuns(tenantId: string, workflowId: string, limit = 25): CloudWorkflowRunRecord[] {
    this.requireTenant(tenantId)
    const workflow = this.requireWorkflow(tenantId, workflowId)
    return workflow.runs
      .slice()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, Math.min(Math.max(1, limit), WORKFLOW_RUN_LIST_LIMIT))
      .map((run) => clone(run))
  }

  createWorkflowRun(input: CreateWorkflowRunInput): CloudWorkflowRunRecord {
    this.requireTenantUser(input.tenantId, input.userId)
    const workflow = this.requireWorkflow(input.tenantId, input.workflowId)
    if (workflow.record.userId !== input.userId) throw new Error(`Unknown workflow ${input.workflowId}.`)
    this.assertWorkflowRunnable(workflow.record)
    const runKey = key(input.tenantId, input.runId)
    const existing = this.workflowRuns.get(runKey)
    if (existing) return clone(existing)
    const createdAt = nowIso(input.createdAt)
    const run: CloudWorkflowRunRecord = {
      tenantId: input.tenantId,
      userId: input.userId,
      id: input.runId,
      workflowId: input.workflowId,
      sessionId: null,
      triggerType: input.triggerType,
      triggerPayload: input.triggerPayload || null,
      status: 'queued',
      title: `Run ${workflow.record.title}`,
      summary: null,
      error: null,
      createdAt,
      startedAt: null,
      finishedAt: null,
    }
    workflow.runs.push(run)
    this.workflowRuns.set(runKey, run)
    workflow.record.status = 'running'
    workflow.record.latestRunId = run.id
    workflow.record.latestRunStatus = run.status
    workflow.record.updatedAt = createdAt
    return clone(run)
  }

  claimDueWorkflowRun(input: ClaimDueWorkflowRunInput): ClaimedWorkflowRunRecord | null {
    const now = input.now || new Date()
    const claimedAt = now.toISOString()
    const workflow = Array.from(this.workflows.values())
      .filter((entry) => (
        entry.record.status === 'active'
        && entry.record.nextRunAt !== null
        && entry.record.nextRunAt <= claimedAt
      ))
      .sort((left, right) => String(left.record.nextRunAt).localeCompare(String(right.record.nextRunAt)))[0]
    if (!workflow) return null
    const scheduledFor = workflow.record.nextRunAt
    const run: CloudWorkflowRunRecord = {
      tenantId: workflow.record.tenantId,
      userId: workflow.record.userId,
      id: input.runId,
      workflowId: workflow.record.id,
      sessionId: null,
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
    }
    workflow.runs.push(run)
    this.workflowRuns.set(key(run.tenantId, run.id), run)
    workflow.record.status = 'running'
    workflow.record.latestRunId = run.id
    workflow.record.latestRunStatus = run.status
    workflow.record.updatedAt = claimedAt
    return {
      workflow: clone(workflow.record),
      run: clone(run),
    }
  }

  attachWorkflowRunSession(input: AttachWorkflowRunSessionInput): CloudWorkflowRunRecord | null {
    const workflow = this.requireWorkflow(input.tenantId, input.workflowId)
    const run = this.workflowRuns.get(key(input.tenantId, input.runId))
    if (!run || run.workflowId !== input.workflowId) return null
    const startedAt = nowIso(input.startedAt)
    run.sessionId = input.sessionId
    run.status = 'running'
    run.startedAt ||= startedAt
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
      finishedAt: input.finishedAt,
    })
  }

  getWorkflowRun(tenantId: string, runId: string): CloudWorkflowRunRecord | null {
    this.requireTenant(tenantId)
    return clone(this.workflowRuns.get(key(tenantId, runId)) || null)
  }

  getWorkflowRunBySession(tenantId: string, sessionId: string): CloudWorkflowRunRecord | null {
    this.requireTenant(tenantId)
    for (const run of this.workflowRuns.values()) {
      if (run.tenantId === tenantId && run.sessionId === sessionId) return clone(run)
    }
    return null
  }

  listThreadTags(tenantId: string): ThreadTagRecord[] {
    this.requireTenant(tenantId)
    return Array.from(this.threadTags.values())
      .filter((tag) => tag.tenantId === tenantId)
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
      .map((tag) => clone(tag))
  }

  createThreadTag(input: CreateThreadTagInput): ThreadTagRecord {
    this.requireTenant(input.tenantId)
    const tagKey = key(input.tenantId, input.tagId)
    const name = normalizeText(input.name, THREAD_TAG_NAME_MAX_LENGTH, 'Tag name')
    const color = normalizeTagColor(input.color)
    const existing = this.threadTags.get(tagKey)
    if (existing) {
      if (existing.name !== name || existing.color !== color) {
        throw new Error(`Tag id ${input.tagId} was reused with different content.`)
      }
      return clone(existing)
    }
    this.assertUniqueThreadTagName(input.tenantId, input.tagId, name)
    const createdAt = nowIso(input.createdAt)
    const record: ThreadTagRecord = {
      tenantId: input.tenantId,
      tagId: input.tagId,
      name,
      color,
      createdAt,
      updatedAt: createdAt,
    }
    this.threadTags.set(tagKey, record)
    return clone(record)
  }

  updateThreadTag(input: UpdateThreadTagInput): ThreadTagRecord | null {
    this.requireTenant(input.tenantId)
    const tag = this.threadTags.get(key(input.tenantId, input.tagId))
    if (!tag) return null
    const name = normalizeOptionalText(input.name, THREAD_TAG_NAME_MAX_LENGTH, 'Tag name') ?? tag.name
    this.assertUniqueThreadTagName(input.tenantId, input.tagId, name)
    tag.name = name
    if (input.color !== undefined) tag.color = normalizeTagColor(input.color)
    tag.updatedAt = nowIso(input.updatedAt)
    return clone(tag)
  }

  deleteThreadTag(tenantId: string, tagId: string): boolean {
    this.requireTenant(tenantId)
    const deleted = this.threadTags.delete(key(tenantId, tagId))
    for (const [linkKey, tags] of this.threadTagLinks.entries()) {
      if (!linkKey.startsWith(`${tenantId}\0`)) continue
      tags.delete(tagId)
      if (tags.size === 0) this.threadTagLinks.delete(linkKey)
    }
    return deleted
  }

  applyThreadTags(input: ThreadTagLinkInput): void {
    this.requireTenant(input.tenantId)
    const sessionIds = normalizeIdList(input.sessionIds, 'sessionIds', THREAD_BULK_MAX_SESSION_IDS)
    const tagIds = normalizeIdList(input.tagIds, 'tagIds', THREAD_FILTER_MAX_VALUES)
    for (const sessionId of sessionIds) this.requireSession(input.tenantId, sessionId)
    for (const tagId of tagIds) this.requireThreadTag(input.tenantId, tagId)
    for (const sessionId of sessionIds) {
      const linkKey = key(input.tenantId, sessionId)
      const tags = this.threadTagLinks.get(linkKey) || new Set<string>()
      for (const tagId of tagIds) tags.add(tagId)
      this.threadTagLinks.set(linkKey, tags)
    }
  }

  removeThreadTags(input: ThreadTagLinkInput): void {
    this.requireTenant(input.tenantId)
    const sessionIds = normalizeIdList(input.sessionIds, 'sessionIds', THREAD_BULK_MAX_SESSION_IDS)
    const tagIds = normalizeIdList(input.tagIds, 'tagIds', THREAD_FILTER_MAX_VALUES)
    for (const sessionId of sessionIds) this.requireSession(input.tenantId, sessionId)
    for (const tagId of tagIds) this.requireThreadTag(input.tenantId, tagId)
    for (const sessionId of sessionIds) {
      const linkKey = key(input.tenantId, sessionId)
      const tags = this.threadTagLinks.get(linkKey)
      if (!tags) continue
      for (const tagId of tagIds) tags.delete(tagId)
      if (tags.size === 0) this.threadTagLinks.delete(linkKey)
    }
  }

  listThreadSmartFilters(tenantId: string): ThreadSmartFilterRecord[] {
    this.requireTenant(tenantId)
    return Array.from(this.threadSmartFilters.values())
      .filter((filter) => filter.tenantId === tenantId)
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
      .map((filter) => clone(filter))
  }

  createThreadSmartFilter(input: CreateThreadSmartFilterInput): ThreadSmartFilterRecord {
    this.requireTenant(input.tenantId)
    const filterKey = key(input.tenantId, input.filterId)
    const name = normalizeText(input.name, THREAD_SMART_FILTER_NAME_MAX_LENGTH, 'Smart filter name')
    const query = normalizeThreadQuery(input.query)
    const existing = this.threadSmartFilters.get(filterKey)
    if (existing) {
      if (existing.name !== name || stableJson(existing.query) !== stableJson(query)) {
        throw new Error(`Smart filter id ${input.filterId} was reused with different content.`)
      }
      return clone(existing)
    }
    const createdAt = nowIso(input.createdAt)
    const record: ThreadSmartFilterRecord = {
      tenantId: input.tenantId,
      filterId: input.filterId,
      name,
      query,
      createdAt,
      updatedAt: createdAt,
    }
    this.threadSmartFilters.set(filterKey, record)
    return clone(record)
  }

  updateThreadSmartFilter(input: UpdateThreadSmartFilterInput): ThreadSmartFilterRecord | null {
    this.requireTenant(input.tenantId)
    const filter = this.threadSmartFilters.get(key(input.tenantId, input.filterId))
    if (!filter) return null
    filter.name = normalizeOptionalText(input.name, THREAD_SMART_FILTER_NAME_MAX_LENGTH, 'Smart filter name') ?? filter.name
    if (input.query !== undefined) filter.query = normalizeThreadQuery(input.query)
    filter.updatedAt = nowIso(input.updatedAt)
    return clone(filter)
  }

  deleteThreadSmartFilter(tenantId: string, filterId: string): boolean {
    this.requireTenant(tenantId)
    return this.threadSmartFilters.delete(key(tenantId, filterId))
  }

  listThreadMetadata(input: {
    tenantId: string
    userId: string
    tagIds?: string[]
    limit?: number
  }): ThreadMetadataRecord[] {
    this.requireTenantUser(input.tenantId, input.userId)
    const tagIds = input.tagIds
      ? normalizeIdList(input.tagIds, 'tagIds', THREAD_FILTER_MAX_VALUES)
      : []
    const limit = Number.isInteger(input.limit) && input.limit && input.limit > 0
      ? Math.min(input.limit, THREAD_BULK_MAX_SESSION_IDS)
      : THREAD_BULK_MAX_SESSION_IDS
    return Array.from(this.sessions.values())
      .filter((session) => session.record.tenantId === input.tenantId && session.record.userId === input.userId)
      .filter((session) => {
        if (tagIds.length === 0) return true
        const sessionTagIds = this.threadTagLinks.get(key(input.tenantId, session.record.sessionId))
        return Boolean(sessionTagIds && tagIds.some((tagId) => sessionTagIds.has(tagId)))
      })
      .sort((left, right) => right.record.updatedAt.localeCompare(left.record.updatedAt))
      .slice(0, limit)
      .map((session) => ({
        tenantId: session.record.tenantId,
        userId: session.record.userId,
        sessionId: session.record.sessionId,
        title: session.record.title,
        profileName: session.record.profileName,
        status: session.record.status,
        createdAt: session.record.createdAt,
        updatedAt: session.record.updatedAt,
        tags: this.tagsForSession(session.record.tenantId, session.record.sessionId),
      }))
  }

  recordSchemaMigration(id: string, appliedAt = new Date()): SchemaMigrationRecord {
    const existing = this.migrations.get(id)
    if (existing) return clone(existing)
    const record: SchemaMigrationRecord = {
      id,
      appliedAt: appliedAt.toISOString(),
    }
    this.migrations.set(id, record)
    return clone(record)
  }

  listSchemaMigrations(): SchemaMigrationRecord[] {
    return Array.from(this.migrations.values()).map((record) => clone(record))
  }

  private requireTenant(tenantId: string) {
    const tenant = this.tenants.get(tenantId)
    if (!tenant) throw new Error(`Unknown tenant ${tenantId}.`)
    return tenant
  }

  private requireTenantUser(tenantId: string, userId: string) {
    this.requireTenant(tenantId)
    const user = this.users.get(key(tenantId, userId))
    if (!user) throw new Error(`User ${userId} does not belong to tenant ${tenantId}.`)
    return user
  }

  private requireSession(tenantId: string, sessionId: string) {
    this.requireTenant(tenantId)
    const session = this.sessions.get(key(tenantId, sessionId))
    if (!session) throw new Error(`Unknown session ${sessionId}.`)
    return session
  }

  private requireWorkflow(tenantId: string, workflowId: string) {
    this.requireTenant(tenantId)
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
    finishedAt?: Date
  }) {
    const workflow = this.requireWorkflow(input.tenantId, input.workflowId)
    const run = this.workflowRuns.get(key(input.tenantId, input.runId))
    if (!run || run.workflowId !== input.workflowId) return null
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') return clone(run)
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

  private requireThreadTag(tenantId: string, tagId: string) {
    const tag = this.threadTags.get(key(tenantId, tagId))
    if (!tag) throw new Error(`Unknown thread tag ${tagId}.`)
    return tag
  }

  private requireCommand(session: SessionState, commandId: string) {
    const command = session.commands.find((entry) => entry.commandId === commandId)
    if (!command) throw new Error(`Unknown command ${commandId}.`)
    return command
  }

  private assertUniqueThreadTagName(tenantId: string, tagId: string, name: string) {
    const normalized = name.toLocaleLowerCase()
    const duplicate = Array.from(this.threadTags.values()).find((tag) => (
      tag.tenantId === tenantId
      && tag.tagId !== tagId
      && tag.name.toLocaleLowerCase() === normalized
    ))
    if (duplicate) throw new Error(`Thread tag "${name}" already exists.`)
  }

  private tagsForSession(tenantId: string, sessionId: string) {
    const tagIds = this.threadTagLinks.get(key(tenantId, sessionId))
    if (!tagIds) return []
    return Array.from(tagIds)
      .map((tagId) => this.threadTags.get(key(tenantId, tagId)))
      .filter((tag): tag is ThreadTagRecord => Boolean(tag))
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
      .map((tag) => clone(tag))
  }

  private assertCurrentLease(session: SessionState, lease: WorkerLeaseRecord) {
    if (!session.lease || session.lease.leaseToken !== lease.leaseToken) {
      throw new Error('Worker lease is stale.')
    }
  }
}
