import { randomBytes, randomUUID } from 'node:crypto'
import type {
  DesktopPairingAuditAction,
  DesktopPairingAuditEvent,
  DesktopPairingCommand,
  DesktopPairingCommandKind,
  DesktopPairingCommandResult,
  DesktopPairingCreateInput,
  DesktopPairingCreated,
  DesktopPairingPublicRecord,
  DesktopPairingRecord,
  DesktopPairingRemoteEvent,
  DesktopPairingStatusSnapshot,
  DesktopPairingUpdateInput,
  SessionInfo,
} from '@open-cowork/shared'
import {
  DESKTOP_PAIRING_COMMAND_KINDS,
  DESKTOP_PAIRING_PROJECTION_FENCE_UNSUPPORTED,
} from '@open-cowork/shared'
import type { RuntimeSessionEvent } from '../session-event-dispatcher.ts'
import {
  redactDesktopPairingSessionInfo,
  runtimeEventToDesktopPairingRemoteEvent,
} from './redaction.ts'
import {
  buildDesktopPairingRecord,
  createFileDesktopPairingStore,
  updateDesktopPairingRecord,
  type DesktopPairingStore,
} from './store.ts'
import {
  createFileDesktopPairingCredentialStore,
  type DesktopPairingCredentialRecord,
  type DesktopPairingCredentialStore,
} from './credentials.ts'
import {
  createHttpDesktopPairingTransport,
  type DesktopPairingTransport,
  type DesktopPairingTransportContext,
} from './transport.ts'

const LOCAL_WORKSPACE_ID = 'local'
const DEFAULT_COMMAND_LIMIT = 10
const DEFAULT_LEASE_SECONDS = 45
const DEFAULT_POLL_INTERVAL_MS = 2_500

export type DesktopPairingCommandExecutor = {
  createSession(): Promise<SessionInfo>
  prompt(input: {
    sessionId: string
    text: string
    agent?: string | null
    variant?: string | null
    attachments?: Array<{ mime: string; url: string; filename?: string }>
  }): Promise<SessionInfo | null>
  abort(sessionId: string): Promise<void>
  respondPermission(input: { sessionId: string; permissionId: string; allowed: boolean }): Promise<void>
  replyQuestion(input: { sessionId: string; requestId: string; answers: string[][] }): Promise<void>
  rejectQuestion(input: { sessionId: string; requestId: string }): Promise<void>
  listSessions(): Promise<SessionInfo[]>
}

export type DesktopPairingServiceOptions = {
  store?: DesktopPairingStore
  credentialStore?: DesktopPairingCredentialStore
  transportFactory?: (record: DesktopPairingRecord) => DesktopPairingTransport
  executor: DesktopPairingCommandExecutor
  now?: () => Date
  pollIntervalMs?: number
  idFactory?: () => string
  tokenFactory?: () => string
}

type RunningPairing = {
  timer: ReturnType<typeof setTimeout> | null
  polling: boolean
}

function defaultId(prefix: string) {
  return `${prefix}_${randomUUID()}`
}

function defaultToken() {
  return `ocp_${randomBytes(32).toString('base64url')}`
}

function commandPayload(command: DesktopPairingCommand) {
  return command.payload && typeof command.payload === 'object' && !Array.isArray(command.payload)
    ? command.payload
    : {}
}

function requireString(payload: Record<string, unknown>, key: string) {
  const value = payload[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required.`)
  return value.trim()
}

function optionalString(payload: Record<string, unknown>, key: string) {
  const value = payload[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizeQuestionAnswers(value: unknown) {
  if (!Array.isArray(value)) throw new Error('Question answers must be an array.')
  return value.map((answer) => {
    if (!Array.isArray(answer)) throw new Error('Question answers must be arrays of strings.')
    return answer.map((entry) => {
      if (typeof entry !== 'string') throw new Error('Question answers must be arrays of strings.')
      return entry
    })
  })
}

function normalizeAttachments(value: unknown) {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error('Remote prompt attachments must be an array.')
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Remote prompt attachment must be an object.')
    }
    const record = entry as { mime?: unknown; url?: unknown; filename?: unknown }
    if (typeof record.mime !== 'string' || typeof record.url !== 'string') {
      throw new Error('Remote prompt attachment requires mime and url.')
    }
    return {
      mime: record.mime,
      url: record.url,
      ...(typeof record.filename === 'string' ? { filename: record.filename } : {}),
    }
  })
}

function withDesktopPairingProjectionFenceStatus(result: DesktopPairingCommandResult): DesktopPairingCommandResult {
  return {
    ...result,
    projectionFence: null,
    projectionFenceStatus: DESKTOP_PAIRING_PROJECTION_FENCE_UNSUPPORTED,
  }
}

function publicRecord(
  record: DesktopPairingRecord,
  credential: DesktopPairingCredentialRecord | null,
): DesktopPairingPublicRecord {
  return {
    ...record,
    credential: {
      hasToken: Boolean(credential?.token),
      deviceId: credential?.deviceId || null,
      updatedAt: credential?.updatedAt || null,
    },
  }
}

export class DesktopPairingService {
  private readonly store: DesktopPairingStore
  private readonly credentialStore: DesktopPairingCredentialStore
  private readonly transportFactory: (record: DesktopPairingRecord) => DesktopPairingTransport
  private readonly executor: DesktopPairingCommandExecutor
  private readonly now: () => Date
  private readonly idFactory: () => string
  private readonly tokenFactory: () => string
  private readonly pollIntervalMs: number
  private readonly running = new Map<string, RunningPairing>()
  private readonly pollFlights = new Map<string, Promise<DesktopPairingStatusSnapshot>>()

  constructor(options: DesktopPairingServiceOptions) {
    this.store = options.store || createFileDesktopPairingStore()
    this.credentialStore = options.credentialStore || createFileDesktopPairingCredentialStore()
    this.transportFactory = options.transportFactory || (() => createHttpDesktopPairingTransport())
    this.executor = options.executor
    this.now = options.now || (() => new Date())
    this.idFactory = options.idFactory || (() => defaultId('desktop_pairing'))
    this.tokenFactory = options.tokenFactory || defaultToken
    this.pollIntervalMs = Math.max(500, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
  }

  list(): DesktopPairingPublicRecord[] {
    return this.store.list().map((record) => publicRecord(record, this.credentialStore.get(record.id)))
  }

  get(pairingId: string): DesktopPairingPublicRecord | null {
    const record = this.store.get(pairingId)
    return record ? publicRecord(record, this.credentialStore.get(record.id)) : null
  }

  create(input: DesktopPairingCreateInput): DesktopPairingCreated {
    const id = this.idFactory()
    const record = buildDesktopPairingRecord({ id, now: this.now(), create: input })
    const pairingToken = this.tokenFactory()
    const credential = this.credentialStore.save({
      pairingId: record.id,
      deviceId: defaultId('desktop_device'),
      token: pairingToken,
    }, this.now())
    this.store.save(record)
    this.audit(record.id, 'pairing.created', {
      workspaceId: LOCAL_WORKSPACE_ID,
      reason: record.enabled ? 'Pairing created and enabled.' : 'Pairing created.',
    })
    if (record.enabled) void this.connect(record.id)
    return {
      record: publicRecord(record, credential),
      pairingToken,
    }
  }

  update(pairingId: string, input: DesktopPairingUpdateInput): DesktopPairingPublicRecord {
    const existing = this.requireRecord(pairingId)
    const next = updateDesktopPairingRecord(existing, input, this.now())
    this.store.save(next)
    this.audit(next.id, input.enabled === false ? 'pairing.disabled' : input.enabled === true ? 'pairing.enabled' : 'pairing.updated')
    if (input.enabled === false) this.disconnect(next.id)
    if (input.enabled === true) void this.connect(next.id)
    return publicRecord(next, this.credentialStore.get(next.id))
  }

  async connect(pairingId: string): Promise<DesktopPairingStatusSnapshot> {
    const record = this.requireRecord(pairingId)
    if (record.status === 'revoked') return this.snapshot(record)
    const enabled = this.store.save({
      ...record,
      enabled: true,
      status: 'paired_offline',
      error: null,
      updatedAt: this.now().toISOString(),
    })
    this.ensureLoop(enabled.id)
    await this.pollOnce(enabled.id)
    return this.snapshot(this.requireRecord(enabled.id))
  }

  disconnect(pairingId: string): DesktopPairingStatusSnapshot {
    const record = this.requireRecord(pairingId)
    const running = this.running.get(record.id)
    if (running?.timer) clearTimeout(running.timer)
    this.running.delete(record.id)
    if (record.status === 'revoked') return this.snapshot(record)
    const next = this.store.save({
      ...record,
      enabled: false,
      status: 'disabled',
      updatedAt: this.now().toISOString(),
    })
    this.audit(next.id, 'pairing.disabled')
    return this.snapshot(next)
  }

  async revoke(pairingId: string): Promise<DesktopPairingStatusSnapshot> {
    const record = this.requireRecord(pairingId)
    const credential = this.credentialStore.get(record.id)
    if (credential && record.brokerUrl && record.status !== 'revoked') {
      try {
        await this.transportFactory(record).revoke?.({ record, credential })
      } catch {
        // Revocation must always remove local authority even when the remote
        // broker is down. Remote-side cleanup is retried by the user if needed.
      }
    }
    const now = this.now().toISOString()
    const revoked = this.store.save({
      ...record,
      enabled: false,
      status: 'revoked',
      revokedAt: now,
      updatedAt: now,
      error: null,
    })
    this.credentialStore.remove(record.id)
    const running = this.running.get(record.id)
    if (running?.timer) clearTimeout(running.timer)
    this.running.delete(record.id)
    this.audit(record.id, 'pairing.revoked')
    return this.snapshot(revoked)
  }

  auditLog(pairingId?: string | null, limit?: number): DesktopPairingAuditEvent[] {
    return this.store.listAudit(pairingId, limit)
  }

  async pollOnce(pairingId: string): Promise<DesktopPairingStatusSnapshot> {
    const existing = this.pollFlights.get(pairingId)
    if (existing) return existing
    const flight = this.pollOnceExclusive(pairingId)
      .finally(() => {
        if (this.pollFlights.get(pairingId) === flight) this.pollFlights.delete(pairingId)
      })
    this.pollFlights.set(pairingId, flight)
    return flight
  }

  private async pollOnceExclusive(pairingId: string): Promise<DesktopPairingStatusSnapshot> {
    const record = this.requireRecord(pairingId)
    if (record.status === 'revoked' || !record.enabled) return this.snapshot(record)
    const credential = this.credentialStore.get(record.id)
    if (!credential) {
      return this.markOffline(record, 'Desktop pairing token is missing.')
    }
    const transport = this.transportFactory(record)
    const context = { record, credential }
    try {
      await transport.heartbeat(context)
      const claim = await transport.claimCommands(context, {
        pairingId: record.id,
        deviceId: credential.deviceId,
        afterSequence: record.lastCommandSequence,
        limit: DEFAULT_COMMAND_LIMIT,
        leaseSeconds: DEFAULT_LEASE_SECONDS,
        capabilities: {
          commands: [...DESKTOP_PAIRING_COMMAND_KINDS],
          workspaces: record.allowedWorkspaceIds,
          policy: record.policy,
        },
      })
      let latest = this.markOnline(record)
      if (!latest.enabled || latest.status === 'revoked') return this.snapshot(latest)
      for (const command of claim.commands) {
        latest = await this.executeClaimedCommand(latest, credential, transport, command)
        if (!latest.enabled || latest.status === 'paired_offline' || latest.status === 'revoked') break
      }
      return this.snapshot(latest)
    } catch (error) {
      return this.markOffline(record, error instanceof Error ? error.message : String(error))
    }
  }

  observeRuntimeEvent(event: RuntimeSessionEvent) {
    const pairings = this.store.list().filter((record) => (
      record.enabled
      && record.status === 'paired_online'
      && record.allowedWorkspaceIds.includes(LOCAL_WORKSPACE_ID)
    ))
    for (const record of pairings) {
      if (!event.sessionId) continue
      if (record.allowedSessionIds && !record.allowedSessionIds.includes(event.sessionId)) continue
      const credential = this.credentialStore.get(record.id)
      if (!credential) continue
      const remoteEvent = runtimeEventToDesktopPairingRemoteEvent({
        pairingId: record.id,
        eventId: this.idFactory(),
        event,
        policy: record.policy,
        occurredAt: this.now().toISOString(),
      })
      if (!remoteEvent) continue
      void this.publishEvents({ record, credential }, [remoteEvent]).catch(() => undefined)
    }
  }

  private ensureLoop(pairingId: string) {
    const existing = this.running.get(pairingId)
    if (existing) return
    const state: RunningPairing = { timer: null, polling: false }
    const tick = async () => {
      if (state.polling) return
      state.polling = true
      try {
        await this.pollOnce(pairingId)
      } finally {
        state.polling = false
      }
      const latest = this.store.get(pairingId)
      if (!latest || !latest.enabled || latest.status === 'revoked') {
        this.running.delete(pairingId)
        return
      }
      state.timer = setTimeout(tick, this.pollIntervalMs)
      state.timer.unref?.()
    }
    this.running.set(pairingId, state)
    state.timer = setTimeout(tick, this.pollIntervalMs)
    state.timer.unref?.()
  }

  private async executeClaimedCommand(
    record: DesktopPairingRecord,
    credential: DesktopPairingCredentialRecord,
    transport: DesktopPairingTransport,
    command: DesktopPairingCommand,
  ): Promise<DesktopPairingRecord> {
    const context = { record, credential }
    this.audit(record.id, 'command.accepted', this.auditFields(command))
    await this.publishEventsBestEffort(context, [{
      id: this.idFactory(),
      pairingId: record.id,
      type: 'command.accepted',
      workspaceId: command.workspaceId,
      sessionId: command.sessionId || null,
      commandId: command.id,
      sequence: command.sequence,
      occurredAt: this.now().toISOString(),
      payload: { kind: command.kind },
    }])
    const leaseToken = command.lease?.leaseToken || null
    let result: DesktopPairingCommandResult
    try {
      result = await this.executeCommand(record, command)
    } catch (error) {
      result = {
        ok: false,
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      }
    }

    const resultDelivery = await this.deliverCommandResult(context, transport, command, result, leaseToken)
    if (result.ok) {
      this.audit(record.id, 'command.completed', this.auditFields(command))
    } else {
      this.audit(record.id, result.status === 'blocked_by_policy' ? 'command.blocked' : 'command.failed', {
        ...this.auditFields(command),
        reason: result.message,
      })
    }

    const latest = this.saveCommandSequence(record, command.sequence)
    if (resultDelivery.ok || latest.status === 'revoked') return latest
    return this.markOfflineRecord(latest, resultDelivery.error)
  }

  private async executeCommand(
    record: DesktopPairingRecord,
    command: DesktopPairingCommand,
  ): Promise<DesktopPairingCommandResult> {
    const workspaceVerdict = this.assertCommandWorkspaceAllowed(record, command)
    if (workspaceVerdict) return workspaceVerdict
    if (record.allowedSessionIds && command.sessionId && !record.allowedSessionIds.includes(command.sessionId)) {
      return {
        ok: false,
        status: 'blocked_by_policy',
        message: 'This pairing is not allowed to access the requested session.',
      }
    }
    const payload = commandPayload(command)
    switch (command.kind) {
      case 'create_session': {
        if (record.allowedSessionIds) {
          return {
            ok: false,
            status: 'blocked_by_policy',
            message: 'This pairing is limited to existing allowlisted sessions.',
          }
        }
        const session = redactDesktopPairingSessionInfo(await this.executor.createSession(), record.policy)
        return { ok: true, status: 'completed', session }
      }
      case 'prompt': {
        if (!record.policy.allowRemotePrompts) {
          return { ok: false, status: 'blocked_by_policy', message: 'Remote prompts are disabled for this pairing.' }
        }
        if (!command.sessionId) throw new Error('Remote prompt command requires a session id.')
        const attachments = normalizeAttachments(payload.attachments)
        if (attachments?.length && !record.policy.allowRemoteAttachments) {
          return { ok: false, status: 'blocked_by_policy', message: 'Remote prompt attachments are disabled for this pairing.' }
        }
        const session = await this.executor.prompt({
          sessionId: command.sessionId,
          text: requireString(payload, 'text'),
          agent: optionalString(payload, 'agent'),
          variant: optionalString(payload, 'variant'),
          attachments,
        })
        return {
          ok: true,
          status: 'completed',
          session: session ? redactDesktopPairingSessionInfo(session, record.policy) : null,
        }
      }
      case 'abort': {
        if (!record.policy.allowRemoteAbort) {
          return { ok: false, status: 'blocked_by_policy', message: 'Remote abort is disabled for this pairing.' }
        }
        if (!command.sessionId) throw new Error('Remote abort command requires a session id.')
        await this.executor.abort(command.sessionId)
        return { ok: true, status: 'completed' }
      }
      case 'permission.respond': {
        const policyResult = this.decisionPolicyResult(record.policy.remoteApprovals, 'Remote approvals')
        if (policyResult) return policyResult
        if (!command.sessionId) throw new Error('Remote permission response requires a session id.')
        await this.executor.respondPermission({
          sessionId: command.sessionId,
          permissionId: requireString(payload, 'permissionId'),
          allowed: payload.allowed === true,
        })
        return { ok: true, status: 'completed' }
      }
      case 'question.reply': {
        const policyResult = this.decisionPolicyResult(record.policy.remoteQuestions, 'Remote question replies')
        if (policyResult) return policyResult
        if (!command.sessionId) throw new Error('Remote question reply requires a session id.')
        await this.executor.replyQuestion({
          sessionId: command.sessionId,
          requestId: requireString(payload, 'requestId'),
          answers: normalizeQuestionAnswers(payload.answers),
        })
        return { ok: true, status: 'completed' }
      }
      case 'question.reject': {
        const policyResult = this.decisionPolicyResult(record.policy.remoteQuestions, 'Remote question rejection')
        if (policyResult) return policyResult
        if (!command.sessionId) throw new Error('Remote question rejection requires a session id.')
        await this.executor.rejectQuestion({
          sessionId: command.sessionId,
          requestId: requireString(payload, 'requestId'),
        })
        return { ok: true, status: 'completed' }
      }
      case 'status': {
        const sessions = (await this.executor.listSessions())
          .filter((session) => !record.allowedSessionIds || record.allowedSessionIds.includes(session.id))
          .map((session) => redactDesktopPairingSessionInfo(session, record.policy))
        return {
          ok: true,
          status: 'completed',
          sessions,
          data: { pairing: this.snapshot(record) as unknown as Record<string, unknown> },
        }
      }
      case 'revoke_pairing': {
        await this.revoke(record.id)
        return { ok: true, status: 'completed', message: 'Pairing revoked.' }
      }
      default:
        return this.unhandledCommand(command.kind)
    }
  }

  private unhandledCommand(kind: never): DesktopPairingCommandResult {
    return {
      ok: false,
      status: 'failed',
      message: `Unsupported desktop pairing command: ${kind as DesktopPairingCommandKind}`,
    }
  }

  private decisionPolicyResult(policy: DesktopPairingRecord['policy']['remoteApprovals'], label: string): DesktopPairingCommandResult | null {
    if (policy === 'remote_allowed') return null
    if (policy === 'local_confirmation') {
      return { ok: false, status: 'requires_local_confirmation', message: `${label} require local desktop confirmation.` }
    }
    return { ok: false, status: 'blocked_by_policy', message: `${label} are disabled for this pairing.` }
  }

  private assertCommandWorkspaceAllowed(record: DesktopPairingRecord, command: DesktopPairingCommand): DesktopPairingCommandResult | null {
    if (command.workspaceId !== LOCAL_WORKSPACE_ID) {
      return {
        ok: false,
        status: 'blocked_by_policy',
        message: 'Desktop pairing only accepts Local workspace commands.',
      }
    }
    if (!record.allowedWorkspaceIds.includes(LOCAL_WORKSPACE_ID)) {
      return {
        ok: false,
        status: 'blocked_by_policy',
        message: 'The Local workspace is not allowed for this pairing.',
      }
    }
    return null
  }

  private markOnline(record: DesktopPairingRecord) {
    const timestamp = this.now().toISOString()
    const latest = this.store.get(record.id) || record
    if (!latest.enabled || latest.status === 'revoked') return latest
    const next = this.store.save({
      ...latest,
      status: 'paired_online',
      enabled: true,
      lastConnectedAt: latest.lastConnectedAt || timestamp,
      lastHeartbeatAt: timestamp,
      error: null,
      updatedAt: timestamp,
    })
    if (latest.status !== 'paired_online') this.audit(next.id, 'pairing.connected')
    return next
  }

  private saveCommandSequence(record: DesktopPairingRecord, sequence: number) {
    const latest = this.store.get(record.id) || record
    return this.store.save({
      ...latest,
      lastCommandSequence: Math.max(latest.lastCommandSequence, sequence),
      updatedAt: this.now().toISOString(),
    })
  }

  private markOffline(record: DesktopPairingRecord, error: string): DesktopPairingStatusSnapshot {
    return this.snapshot(this.markOfflineRecord(record, error))
  }

  private markOfflineRecord(record: DesktopPairingRecord, error: string): DesktopPairingRecord {
    const latest = this.store.get(record.id) || record
    if (!latest.enabled || latest.status === 'revoked') return latest
    const next = this.store.save({
      ...latest,
      status: 'paired_offline',
      error,
      updatedAt: this.now().toISOString(),
    })
    if (latest.status !== 'paired_offline' || latest.error !== error) {
      this.audit(next.id, 'pairing.offline', { reason: error })
    }
    return next
  }

  private async publishEvents(context: DesktopPairingTransportContext, events: DesktopPairingRemoteEvent[]) {
    await this.transportFactory(context.record).publishEvents(context, events)
    for (const event of events) {
      this.audit(context.record.id, 'remote.event.published', {
        workspaceId: event.workspaceId || null,
        sessionId: event.sessionId || null,
        commandId: event.commandId || null,
        reason: event.type,
      })
    }
  }

  private async publishEventsBestEffort(context: DesktopPairingTransportContext, events: DesktopPairingRemoteEvent[]) {
    try {
      await this.publishEvents(context, events)
    } catch {
      // Command execution/result delivery is authoritative. A transient
      // command.accepted event failure must not re-run or block the command.
    }
  }

  private async deliverCommandResult(
    context: DesktopPairingTransportContext,
    transport: DesktopPairingTransport,
    command: DesktopPairingCommand,
    result: DesktopPairingCommandResult,
    leaseToken?: string | null,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const deliveredResult = withDesktopPairingProjectionFenceStatus(result)
    try {
      if (result.ok) {
        await transport.ackCommand(context, command.id, deliveredResult, leaseToken)
      } else {
        await transport.failCommand(context, command.id, deliveredResult, leaseToken)
      }
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        error: `Desktop pairing result delivery failed: ${message}`,
      }
    }
  }

  private requireRecord(pairingId: string) {
    const record = this.store.get(pairingId)
    if (!record) throw new Error(`Unknown desktop pairing: ${pairingId}`)
    return record
  }

  private snapshot(record: DesktopPairingRecord): DesktopPairingStatusSnapshot {
    return {
      pairingId: record.id,
      status: record.status,
      enabled: record.enabled,
      lastConnectedAt: record.lastConnectedAt,
      lastHeartbeatAt: record.lastHeartbeatAt,
      lastCommandSequence: record.lastCommandSequence,
      error: record.error,
    }
  }

  private auditFields(command: DesktopPairingCommand) {
    return {
      actorId: command.actorId || null,
      actorLabel: command.actorLabel || null,
      workspaceId: command.workspaceId,
      sessionId: command.sessionId || null,
      commandId: command.id,
      reason: command.kind,
    }
  }

  private audit(
    pairingId: string,
    action: DesktopPairingAuditAction,
    input: Partial<DesktopPairingAuditEvent> = {},
  ) {
    return this.store.appendAudit({
      id: this.idFactory(),
      pairingId,
      action,
      actorId: input.actorId ?? null,
      actorLabel: input.actorLabel ?? null,
      workspaceId: input.workspaceId ?? null,
      sessionId: input.sessionId ?? null,
      commandId: input.commandId ?? null,
      reason: input.reason ?? null,
      metadata: input.metadata,
      createdAt: this.now().toISOString(),
    })
  }
}

export function createDesktopPairingService(options: DesktopPairingServiceOptions) {
  return new DesktopPairingService(options)
}
