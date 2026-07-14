import { normalizeCloudProjectSource, summarizeCloudProjectSource } from '@open-cowork/shared'
import { redactOperationalText } from '../operational-text-redaction.ts'
import { publicQuotaMessage, quotaExceeded, type QuotaPolicyCode } from '../control-plane-errors.ts'
import { decodeSessionPageCursor, encodeSessionPageCursor } from '../session-page-cursor.ts'
import {
  clone,
  key,
  normalizeListLimit,
  nowIso,
  sliceEventsAfter,
  stableJson,
} from './store-helpers.ts'
import type {
  AppendEventInput,
  AppendProjectedSessionEventInput,
  AppendProjectedSessionEventResult,
  AppendWorkspaceEventInput,
  CheckpointAndAckSessionCommandResult,
  CloudArtifactIndexRecord,
  CloudLaunchpadSessionSummaryRecord,
  CommandQueueQuota,
  ConsumeUsageQuotaInput,
  ControlPlaneSessionStatus,
  CompleteWorkflowRunInput,
  CreateSessionInput,
  EnqueueCommandInput,
  FailWorkflowRunInput,
  ListCloudArtifactIndexInput,
  ListCloudArtifactIndexResult,
  ListCloudLaunchpadSessionSummariesInput,
  ListCloudLaunchpadSessionSummariesResult,
  ListRunnableSessionsInput,
  ListSessionsPageInput,
  ListSessionsPageRecord,
  QuotaConsumptionRecord,
  ReapedSessionLeaseRecord,
  ReapExpiredSessionLeasesInput,
  RecoverSessionLeaseInput,
  RecordAuditEventInput,
  RunnableSessionListRecord,
  SessionCommandRecord,
  SessionEventRecord,
  SessionProjectionRecord,
  SessionRecord,
  UpsertCloudArtifactIndexInput,
  UpsertCloudLaunchpadSessionSummaryInput,
  WorkerLeaseRecord,
  WorkReaperAction,
  WorkspaceEventRecord,
  WriteProjectionInput,
} from '../control-plane-store.ts'

export type SessionState = {
  record: SessionRecord
  nextEventSequence: number
  nextCommandSequence: number
  nextLeaseAttempt: number
  lease: WorkerLeaseRecord | null
  events: SessionEventRecord[]
  projection: SessionProjectionRecord | null
  commands: SessionCommandRecord[]
}

type InMemorySessionsState = {
  sessions: Map<string, SessionState>
  artifactIndex: Map<string, CloudArtifactIndexRecord>
  launchpadSessionSummaries: Map<string, CloudLaunchpadSessionSummaryRecord>
}

type InMemorySessionsHost = {
  requireTenant(tenantId: string): void
  requireTenantUser(tenantId: string, userId: string): void
  resolveOrgId(tenantId: string): string
  resolveOrgIdOrNull(tenantId: string): string | null
  appendWorkspaceEvent(input: AppendWorkspaceEventInput): WorkspaceEventRecord
  findWorkspaceEvent(tenantId: string, userId: string, eventId: string): WorkspaceEventRecord | null
  snapshotWorkspaceEvents(): unknown
  restoreWorkspaceEvents(snapshot: unknown): void
  snapshotWorkflows(): unknown
  restoreWorkflows(snapshot: unknown): void
  completeWorkflowRun(input: CompleteWorkflowRunInput): unknown
  failWorkflowRun(input: FailWorkflowRunInput): unknown
  assertCommandQueueQuota(input: { tenantId: string, quota?: CommandQueueQuota | null, now?: Date }): void
  consumeUsageQuota(input: ConsumeUsageQuotaInput): QuotaConsumptionRecord
  snapshotUsageQuotaCounters(): unknown
  restoreUsageQuotaCounters(snapshot: unknown): void
  recordAuditEvent(input: RecordAuditEventInput): void
}

// Session lifecycle, event/projection state, worker leases, command queues, and
// derived launchpad/artifact indexes for the in-memory control-plane store.
// The state maps are still owned by the top-level store so quota/workflow/thread
// domains can keep their existing narrow read hooks while this bulky lifecycle
// logic no longer lives in the facade.
export class InMemorySessionsDomain {
  private readonly sessions: Map<string, SessionState>
  private readonly artifactIndex: Map<string, CloudArtifactIndexRecord>
  private readonly launchpadSessionSummaries: Map<string, CloudLaunchpadSessionSummaryRecord>
  private readonly host: InMemorySessionsHost

  constructor(state: InMemorySessionsState, host: InMemorySessionsHost) {
    this.sessions = state.sessions
    this.artifactIndex = state.artifactIndex
    this.launchpadSessionSummaries = state.launchpadSessionSummaries
    this.host = host
  }

  createSession(input: CreateSessionInput): SessionRecord {
    this.host.requireTenantUser(input.tenantId, input.userId)
    const sessionKey = key(input.tenantId, input.sessionId)
    const existing = this.sessions.get(sessionKey)
    if (existing) return clone(existing.record)
    const maxConcurrentSessions = input.quota?.maxConcurrentSessionsPerOrg
    if (maxConcurrentSessions && maxConcurrentSessions > 0) {
      const orgId = input.quota?.orgId || this.host.resolveOrgId(input.tenantId)
      const activeSessions = Array.from(this.sessions.values())
        .filter((session) => this.host.resolveOrgId(session.record.tenantId) === orgId && session.record.status !== 'closed')
        .length
      if (activeSessions >= maxConcurrentSessions) {
        quotaExceeded({
          message: 'Concurrent cloud session quota exceeded.',
          policyCode: input.quota?.policyCode || 'quota.concurrent_sessions_exceeded',
          retryAfterMs: 60_000,
          limit: maxConcurrentSessions,
          used: activeSessions,
          resetAt: new Date(Date.now() + 60_000).toISOString(),
        })
      }
    }
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
    this.host.requireTenantUser(tenantId, userId)
    const record = this.sessions.get(key(tenantId, sessionId))?.record || null
    if (!record || record.userId !== userId) return null
    return clone(record)
  }

  getOwnedSessionIds(tenantId: string, userId: string, sessionIds: string[]): Set<string> {
    this.host.requireTenantUser(tenantId, userId)
    const owned = new Set<string>()
    for (const sessionId of sessionIds) {
      const record = this.sessions.get(key(tenantId, sessionId))?.record
      if (record && record.userId === userId) owned.add(sessionId)
    }
    return owned
  }

  getSessionForTenant(tenantId: string, sessionId: string): SessionRecord | null {
    this.host.requireTenant(tenantId)
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
    this.host.requireTenantUser(tenantId, userId)
    return Array.from(this.sessions.values())
      .filter((session) => session.record.tenantId === tenantId && session.record.userId === userId)
      .sort((left, right) => (
        right.record.updatedAt.localeCompare(left.record.updatedAt)
        || left.record.sessionId.localeCompare(right.record.sessionId)
      ))
      .slice(0, 1000)
      .map((session) => this.sessionRecordWithProjectSource(session.record))
  }

  listSessionsPage(input: ListSessionsPageInput): ListSessionsPageRecord {
    this.host.requireTenantUser(input.tenantId, input.userId)
    const limit = normalizeListLimit(input.limit)
    const cursor = decodeSessionPageCursor(input.cursor, input)
    const query = input.query?.trim().toLowerCase() || null
    const filtered = Array.from(this.sessions.values())
      .map((session) => session.record)
      .filter((session) => session.tenantId === input.tenantId && session.userId === input.userId)
      .filter((session) => !input.status || session.status === input.status)
      .filter((session) => !input.profileName || session.profileName === input.profileName)
      .filter((session) => !query || [
        session.title || '',
        session.sessionId,
        session.opencodeSessionId,
        session.profileName,
      ].some((field) => field.toLowerCase().includes(query)))
      .sort((left, right) => (
        right.updatedAt.localeCompare(left.updatedAt)
        || left.sessionId.localeCompare(right.sessionId)
      ))
      .filter((session) => !cursor
        || session.updatedAt < cursor.updatedAt
        || (session.updatedAt === cursor.updatedAt && session.sessionId > cursor.sessionId))
    const page = filtered.slice(0, limit)
    const hasMore = filtered.length > limit
    return {
      items: page.map((session) => this.sessionRecordWithProjectSource(session)),
      nextCursor: hasMore && page.length > 0 ? encodeSessionPageCursor(page[page.length - 1]!, input) : null,
      totalEstimate: hasMore ? limit + 1 : filtered.length,
    }
  }

  listRunnableSessions(input: ListRunnableSessionsInput = {}): RunnableSessionListRecord {
    const nowMs = (input.now || new Date()).getTime()
    const limit = Math.max(1, Math.min(1_000, Math.floor(input.limit ?? 100)))
    const candidates = this.runnableSessionCandidates(nowMs)
    return {
      sessions: candidates.slice(0, limit).map((candidate) => ({
        tenantId: candidate.session.record.tenantId,
        sessionId: candidate.session.record.sessionId,
      })),
      pendingSessionCountEstimate: candidates.length > limit ? limit + 1 : candidates.length,
    }
  }

  bindSessionRuntime(input: {
    tenantId: string
    sessionId: string
    opencodeSessionId: string
    title?: string | null
    leaseToken?: string | null
    updatedAt?: Date
  }): SessionRecord {
    const session = this.requireSession(input.tenantId, input.sessionId)
    this.assertLeaseTokenIfPresent(session, input.leaseToken)
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
    leaseToken?: string | null
    updatedAt?: Date
  }): SessionRecord {
    const session = this.requireSession(input.tenantId, input.sessionId)
    this.assertLeaseTokenIfPresent(session, input.leaseToken)
    session.record.status = input.status
    if (input.title !== undefined) session.record.title = input.title
    session.record.updatedAt = nowIso(input.updatedAt)
    return clone(session.record)
  }

  appendSessionEvent(input: AppendEventInput): SessionEventRecord {
    const session = this.requireSession(input.tenantId, input.sessionId)
    this.assertLeaseTokenIfPresent(session, input.leaseToken)
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

  appendProjectedSessionEvent(input: AppendProjectedSessionEventInput): AppendProjectedSessionEventResult {
    const sessionKey = key(input.tenantId, input.sessionId)
    const session = this.requireSession(input.tenantId, input.sessionId)
    const sessionBefore = clone(session)
    const workspaceBefore = this.host.snapshotWorkspaceEvents()
    const workflowsBefore = this.host.snapshotWorkflows()
    try {
      const eventExisted = Boolean(input.eventId && session.events.some((event) => event.eventId === input.eventId))
      const event = this.appendSessionEvent(input)
      const workspace = input.workspace({ session: clone(session.record), event })
      const workspaceExisted = Boolean(this.host.findWorkspaceEvent(
        input.tenantId,
        session.record.userId,
        workspace.eventId,
      ))
      const workspaceEvent = this.host.appendWorkspaceEvent({
        tenantId: input.tenantId,
        userId: session.record.userId,
        sessionId: input.sessionId,
        eventId: workspace.eventId,
        entityType: workspace.entityType,
        entityId: workspace.entityId,
        operation: workspace.operation,
        projectionVersion: workspace.projectionVersion,
        type: input.type,
        payload: input.payload || {},
        createdAt: new Date(event.createdAt),
      })
      const currentProjection = session.projection ? clone(session.projection) : null
      if ((currentProjection?.sequence || 0) >= event.sequence) {
        this.applyProjectedEventEffects(session, input, event.createdAt)
        return {
          event,
          workspaceEvent,
          projection: currentProjection!,
          session: clone(session.record),
          sessionEventCreated: !eventExisted,
          workspaceEventCreated: !workspaceExisted,
          projectionAdvanced: false,
        }
      }
      const projected = input.project({
        session: clone(session.record),
        event,
        currentProjection,
      })
      const projection = this.writeSessionProjection({
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        sequence: event.sequence,
        view: projected.view,
        leaseToken: input.leaseToken,
        updatedAt: projected.updatedAt ?? new Date(event.createdAt),
      })
      this.applyProjectedEventEffects(session, input, projection.updatedAt)
      return {
        event,
        workspaceEvent,
        projection,
        session: clone(session.record),
        sessionEventCreated: !eventExisted,
        workspaceEventCreated: !workspaceExisted,
        projectionAdvanced: true,
      }
    } catch (error) {
      this.sessions.set(sessionKey, sessionBefore)
      this.host.restoreWorkspaceEvents(workspaceBefore)
      this.host.restoreWorkflows(workflowsBefore)
      throw error
    }
  }

  private applyProjectedEventEffects(
    session: SessionState,
    input: AppendProjectedSessionEventInput,
    updatedAt: string,
  ) {
    if (input.sessionStatus) {
      session.record.status = input.sessionStatus
      session.record.updatedAt = updatedAt
    }
    if (input.workflowTerminal?.kind === 'completed') {
      this.host.completeWorkflowRun(input.workflowTerminal.input)
    } else if (input.workflowTerminal?.kind === 'failed') {
      this.host.failWorkflowRun(input.workflowTerminal.input)
    }
  }

  listSessionEvents(tenantId: string, sessionId: string, afterSequence = 0, limit?: number): SessionEventRecord[] {
    return sliceEventsAfter(this.requireSession(tenantId, sessionId).events, afterSequence, limit)
  }

  listSessionEventsForStream(tenantId: string, sessionId: string, afterSequence = 0, limit?: number): SessionEventRecord[] {
    const session = this.sessions.get(key(tenantId, sessionId))
    if (!session) return []
    return sliceEventsAfter(session.events, afterSequence, limit)
  }

  getSessionEventStats(tenantId: string, sessionId: string): { count: number; latestSequence: number } {
    const session = this.requireSession(tenantId, sessionId)
    let latestSequence = 0
    for (const event of session.events) {
      if (event.sequence > latestSequence) latestSequence = event.sequence
    }
    return { count: session.events.length, latestSequence }
  }

  upsertCloudArtifactIndex(input: UpsertCloudArtifactIndexInput): CloudArtifactIndexRecord {
    this.host.requireTenantUser(input.tenantId, input.userId)
    this.assertSessionBelongsToUser(input.tenantId, input.sessionId, input.userId)
    const session = this.requireSession(input.tenantId, input.sessionId)
    const record: CloudArtifactIndexRecord = {
      ...clone(input),
      sessionTitle: session.record.title || null,
    }
    this.artifactIndex.set(artifactIndexKey(input.tenantId, input.sessionId, input.artifactId), record)
    return clone(record)
  }

  getCloudArtifactIndexRecord(input: {
    tenantId: string
    userId: string
    sessionId: string
    artifactId: string
  }): CloudArtifactIndexRecord | null {
    this.host.requireTenantUser(input.tenantId, input.userId)
    const record = this.artifactIndex.get(artifactIndexKey(input.tenantId, input.sessionId, input.artifactId))
    if (!record || record.userId !== input.userId) return null
    const session = this.sessions.get(key(record.tenantId, record.sessionId))?.record
    return clone({
      ...record,
      sessionTitle: session?.title || null,
    })
  }

  listCloudArtifactIndex(input: ListCloudArtifactIndexInput): ListCloudArtifactIndexResult {
    this.host.requireTenantUser(input.tenantId, input.userId)
    if (input.sessionId) this.assertSessionBelongsToUser(input.tenantId, input.sessionId, input.userId)
    const limit = Math.max(1, Math.min(500, Math.floor(Number(input.limit) || 100)))
    const rows = Array.from(this.artifactIndex.values())
      .filter((record) => cloudArtifactMatchesIndexInput(record, input))
      .map((record) => {
        const session = this.sessions.get(key(record.tenantId, record.sessionId))?.record
        return {
          ...record,
          sessionTitle: session?.title || null,
        }
      })
      .sort(compareCloudArtifacts)
    const items = rows.slice(0, limit)
    return {
      items: clone(items),
      totalEstimate: rows.length > limit ? limit + 1 : rows.length,
      truncated: rows.length > limit,
    }
  }

  upsertCloudLaunchpadSessionSummary(input: UpsertCloudLaunchpadSessionSummaryInput): CloudLaunchpadSessionSummaryRecord {
    this.host.requireTenantUser(input.tenantId, input.userId)
    this.assertSessionBelongsToUser(input.tenantId, input.sessionId, input.userId)
    const session = this.requireSession(input.tenantId, input.sessionId)
    const record: CloudLaunchpadSessionSummaryRecord = {
      ...clone(input),
      sessionTitle: session.record.title || null,
      createdAt: session.record.createdAt,
    }
    const summaryKey = launchpadSummaryKey(input.tenantId, input.sessionId)
    if (hasPendingLaunchpadWork(record)) {
      this.launchpadSessionSummaries.set(summaryKey, record)
    } else {
      this.launchpadSessionSummaries.delete(summaryKey)
    }
    return clone(record)
  }

  listCloudLaunchpadSessionSummaries(input: ListCloudLaunchpadSessionSummariesInput): ListCloudLaunchpadSessionSummariesResult {
    this.host.requireTenantUser(input.tenantId, input.userId)
    const limit = Math.max(1, Math.min(500, Math.floor(Number(input.limit) || 100)))
    const rows = Array.from(this.launchpadSessionSummaries.values())
      .filter((record) => record.tenantId === input.tenantId && record.userId === input.userId)
      .map((record) => {
        const session = this.sessions.get(key(record.tenantId, record.sessionId))?.record
        return {
          ...record,
          sessionTitle: session?.title || null,
          createdAt: session?.createdAt || record.createdAt,
        }
      })
      .sort(compareLaunchpadSummaries)
    const items = rows.slice(0, limit)
    return {
      items: clone(items),
      totalEstimate: rows.length > limit ? limit + 1 : rows.length,
      truncated: rows.length > limit,
    }
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

  getMaxProjectionLag(): number {
    const windowStartMs = Date.now() - 60 * 60 * 1000
    let maxLag = 0
    for (const session of this.sessions.values()) {
      if (session.nextEventSequence <= 0) continue
      if (new Date(session.record.updatedAt).getTime() <= windowStartMs) continue
      const latest = session.nextEventSequence - 1
      const projected = session.projection?.sequence ?? 0
      maxLag = Math.max(maxLag, latest - projected)
    }
    return maxLag
  }

  claimSessionLease(
    tenantId: string,
    sessionId: string,
    workerId: string,
    now = new Date(),
    ttlMs = 30_000,
    quota: {
      orgId?: string | null
      maxActiveWorkersPerOrg?: number | null
      policyCode?: QuotaPolicyCode | string
    } | null = null,
  ): WorkerLeaseRecord | null {
    const session = this.requireSession(tenantId, sessionId)
    const nowMs = now.getTime()
    if (session.lease && session.lease.leaseExpiresAt > nowMs) return null
    const maxActiveWorkers = quota?.maxActiveWorkersPerOrg
    if (maxActiveWorkers && maxActiveWorkers > 0) {
      const orgId = quota?.orgId || this.host.resolveOrgId(tenantId)
      const activeLeases = Array.from(this.sessions.values())
        .filter((state) => this.host.resolveOrgId(state.record.tenantId) === orgId)
        .filter((state) => state.lease && state.lease.leaseExpiresAt > nowMs)
        .length
      if (activeLeases >= maxActiveWorkers) {
        return null
      }
    }
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

  releaseSessionLease(lease: WorkerLeaseRecord, now = new Date()): boolean {
    const session = this.requireSession(lease.tenantId, lease.sessionId)
    if (!session.lease || session.lease.leaseToken !== lease.leaseToken) return false
    session.lease = null
    session.record.status = 'idle'
    session.record.updatedAt = now.toISOString()
    return true
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

  reapExpiredSessionLeases(input: ReapExpiredSessionLeasesInput = {}): ReapedSessionLeaseRecord[] {
    const now = input.now || new Date()
    const nowMs = now.getTime()
    const maxAttempts = Math.max(1, Math.floor(input.maxCommandAttempts ?? 3))
    const limit = Math.max(1, Math.min(1_000, Math.floor(input.limit ?? 100)))
    const reaped: ReapedSessionLeaseRecord[] = []
    const candidates = Array.from(this.sessions.values())
      .filter((session) => Boolean(session.lease) && session.lease!.leaseExpiresAt <= nowMs)
      .sort((left, right) => left.lease!.leaseExpiresAt - right.lease!.leaseExpiresAt || left.record.tenantId.localeCompare(right.record.tenantId) || left.record.sessionId.localeCompare(right.record.sessionId))
      .slice(0, limit)
    for (const session of candidates) {
      const lease = session.lease!
      reaped.push(this.recoverSessionLeaseRecord(session, lease, now, maxAttempts))
    }
    return reaped
  }

  recoverSessionLease(lease: WorkerLeaseRecord, input: RecoverSessionLeaseInput = {}): ReapedSessionLeaseRecord | null {
    const session = this.requireSession(lease.tenantId, lease.sessionId)
    if (!session.lease || session.lease.leaseToken !== lease.leaseToken) return null
    const now = input.now || new Date()
    const maxAttempts = Math.max(1, Math.floor(input.maxCommandAttempts ?? 3))
    return this.recoverSessionLeaseRecord(session, session.lease, now, maxAttempts)
  }

  assertSessionCommandQueueQuota(input: { tenantId: string, quota?: CommandQueueQuota | null, now?: Date }): void {
    this.host.assertCommandQueueQuota(input)
  }

  enqueueSessionCommand(input: EnqueueCommandInput): SessionCommandRecord {
    this.host.requireTenantUser(input.tenantId, input.userId)
    const session = this.requireSession(input.tenantId, input.sessionId)
    const payload = input.payload || {}
    const existing = this.findSessionCommandById(input.commandId)
    if (existing) {
      if (
        existing.tenantId !== input.tenantId
        || existing.userId !== input.userId
        || existing.sessionId !== input.sessionId
        || existing.kind !== input.kind
        || existing.targetLeaseToken !== (input.targetLeaseToken ?? null)
        || stableJson(existing.payload) !== stableJson(payload)
      ) {
        throw new Error(`Command id ${input.commandId} was reused with different content.`)
      }
      return clone(existing)
    }
    this.assertSessionCommandQueueQuota({ tenantId: input.tenantId, quota: input.quota, now: input.createdAt })
    if (input.usageQuotas?.length) {
      const countersSnapshot = this.host.snapshotUsageQuotaCounters()
      try {
        for (const quota of input.usageQuotas) {
          const result = this.host.consumeUsageQuota(quota)
          if (!result.allowed) {
            quotaExceeded({
              message: publicQuotaMessage(result.policyCode),
              policyCode: result.policyCode || 'quota.prompts_per_hour_exceeded',
              retryAfterMs: result.retryAfterMs,
              limit: result.limit,
              used: result.used,
              resetAt: result.resetAt,
            })
          }
        }
      } catch (error) {
        this.host.restoreUsageQuotaCounters(countersSnapshot)
        throw error
      }
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
      attemptCount: 0,
      availableAt: null,
      lastErrorCode: null,
      lastErrorSummary: null,
      ackedAt: null,
      error: null,
    }
    session.commands.push(command)
    return clone(command)
  }

  claimNextSessionCommand(lease: WorkerLeaseRecord, now = new Date()): SessionCommandRecord | null {
    const session = this.requireSession(lease.tenantId, lease.sessionId)
    const nowMs = now.getTime()
    this.assertCurrentLease(session, lease, nowMs)
    const command = session.commands.find((entry) => (
      (entry.status === 'pending'
        && (!entry.availableAt || Date.parse(entry.availableAt) <= nowMs)
        && (entry.targetLeaseToken === null || entry.targetLeaseToken === lease.leaseToken))
      || (entry.status === 'running'
        && entry.claimedLeaseToken !== lease.leaseToken
        && entry.targetLeaseToken === null)
    ))
    if (!command) return null
    command.status = 'running'
    command.claimedBy = lease.leasedBy
    command.claimedLeaseToken = lease.leaseToken
    command.attemptCount += 1
    command.availableAt = null
    command.lastErrorCode = null
    command.lastErrorSummary = null
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

  checkpointAndAckSessionCommand(
    lease: WorkerLeaseRecord,
    commandId: string,
    now = new Date(),
  ): CheckpointAndAckSessionCommandResult {
    const session = this.requireSession(lease.tenantId, lease.sessionId)
    this.assertCurrentLease(session, lease)
    const command = this.requireCommand(session, commandId)
    if (command.status === 'acked') {
      return {
        lease: clone(session.lease!),
        command: clone(command),
        checkpointAdvanced: false,
        commandAcked: false,
      }
    }
    if (command.status !== 'running' || command.claimedLeaseToken !== lease.leaseToken) {
      throw new Error(`Command ${commandId} is not owned by this worker.`)
    }
    if (lease.checkpointVersion !== session.lease?.checkpointVersion) {
      throw new Error('Checkpoint version is stale.')
    }
    session.lease = {
      ...session.lease!,
      checkpointVersion: session.lease!.checkpointVersion + 1,
    }
    command.status = 'acked'
    command.ackedAt = now.toISOString()
    command.error = null
    command.lastErrorCode = null
    command.lastErrorSummary = null
    return {
      lease: clone(session.lease),
      command: clone(command),
      checkpointAdvanced: true,
      commandAcked: true,
    }
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
    command.lastErrorCode = 'execution_failed'
    command.lastErrorSummary = redactOperationalText(error, 512, 'Command error')
    return clone(command)
  }

  requireSession(tenantId: string, sessionId: string): SessionState {
    this.host.requireTenant(tenantId)
    const session = this.sessions.get(key(tenantId, sessionId))
    if (!session) throw new Error(`Unknown session ${sessionId}.`)
    return session
  }

  assertSessionLease(tenantId: string, sessionId: string, leaseToken: string | null | undefined): void {
    const session = this.requireSession(tenantId, sessionId)
    this.assertLeaseTokenIfPresent(session, leaseToken)
  }

  assertSessionBelongsToUser(tenantId: string, sessionId: string, userId: string): void {
    const session = this.requireSession(tenantId, sessionId)
    if (session.record.userId !== userId) {
      throw new Error(`Session ${sessionId} does not belong to user ${userId}.`)
    }
  }

  sessionHasCommands(tenantId: string, sessionId: string): boolean {
    const session = this.sessions.get(key(tenantId, sessionId))
    return Boolean(session?.commands.length)
  }

  private sessionRecordWithProjectSource(record: SessionRecord): SessionRecord {
    const stored = this.sessions.get(key(record.tenantId, record.sessionId))
    const source = normalizeCloudProjectSource(stored?.projection?.view?.projectSource)
    return {
      ...clone(record),
      projectSource: summarizeCloudProjectSource(source),
    }
  }

  private runnableSessionCandidates(nowMs: number) {
    return Array.from(this.sessions.values())
      .map((session) => {
        if (session.lease && session.lease.leaseExpiresAt > nowMs) return null
        const runnable = session.commands
          .filter((command) => command.targetLeaseToken === null)
          .filter((command) => command.status === 'pending' || command.status === 'running')
          .filter((command) => command.status !== 'pending' || !command.availableAt || Date.parse(command.availableAt) <= nowMs)
          .sort((a, b) => a.createdSequence - b.createdSequence)[0]
        return runnable ? { session, firstSequence: runnable.createdSequence } : null
      })
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
      .sort((a, b) => (
        a.firstSequence - b.firstSequence
        || a.session.record.tenantId.localeCompare(b.session.record.tenantId)
        || a.session.record.sessionId.localeCompare(b.session.record.sessionId)
      ))
  }

  private requireCommand(session: SessionState, commandId: string) {
    const command = session.commands.find((entry) => entry.commandId === commandId)
    if (!command) throw new Error(`Unknown command ${commandId}.`)
    return command
  }

  private findSessionCommandById(commandId: string): SessionCommandRecord | undefined {
    for (const session of this.sessions.values()) {
      const command = session.commands.find((entry) => entry.commandId === commandId)
      if (command) return command
    }
    return undefined
  }

  private recoverSessionLeaseRecord(
    session: SessionState,
    lease: WorkerLeaseRecord,
    now: Date,
    maxAttempts: number,
  ): ReapedSessionLeaseRecord {
    const nowIsoValue = now.toISOString()
    const runningCommands = session.commands.filter((command) => (
      command.status === 'running'
      && command.claimedLeaseToken === lease.leaseToken
    ))
    const retriedCommandIds: string[] = []
    const failedCommandIds: string[] = []
    for (const command of runningCommands) {
      if (command.attemptCount >= maxAttempts) {
        command.status = 'failed'
        command.error = 'Worker lease expired after the maximum retry attempts.'
        command.lastErrorCode = 'lease_expired_max_attempts'
        command.lastErrorSummary = command.error
        failedCommandIds.push(command.commandId)
      } else {
        command.status = 'pending'
        command.claimedBy = null
        command.claimedLeaseToken = null
        command.availableAt = nowIsoValue
        command.error = null
        command.lastErrorCode = 'lease_expired'
        command.lastErrorSummary = 'Worker lease expired before command completion.'
        retriedCommandIds.push(command.commandId)
      }
    }
    session.lease = null
    session.record.status = failedCommandIds.length > 0 && retriedCommandIds.length === 0 ? 'errored' : 'idle'
    session.record.updatedAt = nowIsoValue
    const action: WorkReaperAction = failedCommandIds.length > 0 && retriedCommandIds.length === 0
      ? 'failed'
      : retriedCommandIds.length > 0
        ? 'retried'
        : 'released'
    const record: ReapedSessionLeaseRecord = {
      tenantId: lease.tenantId,
      sessionId: lease.sessionId,
      leaseToken: lease.leaseToken,
      leasedBy: lease.leasedBy,
      action,
      retriedCommandIds,
      failedCommandIds,
      reapedAt: nowIsoValue,
    }
    const orgId = this.host.resolveOrgIdOrNull(lease.tenantId)
    if (orgId) {
      this.host.recordAuditEvent({
        orgId,
        actorType: 'system',
        actorId: 'managed-work-reaper',
        eventType: 'managed_work.session_lease_reaped',
        targetType: 'session',
        targetId: lease.sessionId,
        metadata: {
          action,
          leasedBy: lease.leasedBy,
          retriedCommandIds,
          failedCommandIds,
        },
        createdAt: now,
      })
    }
    return record
  }

  private assertCurrentLease(session: SessionState, lease: WorkerLeaseRecord, nowMs = Date.now()): void {
    if (!session.lease || session.lease.leaseToken !== lease.leaseToken || session.lease.leaseExpiresAt <= nowMs) {
      throw new Error('Worker lease is stale.')
    }
  }

  private assertLeaseTokenIfPresent(session: SessionState, leaseToken: string | null | undefined): void {
    if (leaseToken === undefined) return
    if (!session.lease) throw new Error('Worker lease is stale (missing).')
    if (session.lease.leaseToken !== leaseToken) throw new Error('Worker lease is stale (token mismatch).')
    if (session.lease.leaseExpiresAt <= Date.now()) throw new Error('Worker lease is stale (expired).')
  }
}

function artifactIndexKey(tenantId: string, sessionId: string, artifactId: string) {
  return key(tenantId, sessionId, artifactId)
}

function cloudArtifactMatchesIndexInput(record: CloudArtifactIndexRecord, input: ListCloudArtifactIndexInput) {
  if (record.tenantId !== input.tenantId || record.userId !== input.userId) return false
  if (input.sessionId && record.sessionId !== input.sessionId) return false
  const taskIds = new Set((input.taskIds || []).filter(Boolean))
  if (input.projectId && record.projectId !== input.projectId && (!record.taskId || !taskIds.has(record.taskId))) return false
  if (input.taskId && record.taskId !== input.taskId) return false
  if (!input.projectId && taskIds.size > 0 && (!record.taskId || !taskIds.has(record.taskId))) return false
  if (input.status && record.status !== input.status) return false
  if (input.kind && record.kind !== input.kind) return false
  return true
}

function compareCloudArtifacts(left: CloudArtifactIndexRecord, right: CloudArtifactIndexRecord) {
  return (
    right.updatedAt.localeCompare(left.updatedAt)
    || left.sessionId.localeCompare(right.sessionId)
    || left.artifactId.localeCompare(right.artifactId)
  )
}

function launchpadSummaryKey(tenantId: string, sessionId: string) {
  return key(tenantId, sessionId)
}

function hasPendingLaunchpadWork(record: CloudLaunchpadSessionSummaryRecord) {
  return record.pendingApprovals.length > 0 || record.pendingQuestions.length > 0
}

function compareLaunchpadSummaries(left: CloudLaunchpadSessionSummaryRecord, right: CloudLaunchpadSessionSummaryRecord) {
  return (
    right.updatedAt.localeCompare(left.updatedAt)
    || left.sessionId.localeCompare(right.sessionId)
  )
}
