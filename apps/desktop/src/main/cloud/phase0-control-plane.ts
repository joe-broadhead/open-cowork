export type Phase0Lease = {
  sessionId: string
  leasedBy: string
  leaseToken: string
  leaseExpiresAt: number
  checkpointVersion: number
}

export type Phase0CommandKind =
  | 'prompt'
  | 'abort'
  | 'permission.respond'
  | 'question.reply'

export type Phase0CommandStatus = 'pending' | 'running' | 'acked' | 'failed'

export type Phase0SessionCommand = {
  commandId: string
  tenantId: string
  userId: string
  sessionId: string
  kind: Phase0CommandKind
  payload: Record<string, unknown>
  targetLeaseToken: string | null
  createdSeq: number
  createdAt: string
  status: Phase0CommandStatus
  ackedBy: string | null
  ackedAt: string | null
  error: string | null
}

type SessionState = {
  sessionId: string
  lease: Phase0Lease | null
  nextLeaseAttempt: number
  nextCommandSeq: number
  checkpointVersion: number
  projectionSeq: number
  commands: Phase0SessionCommand[]
}

type EnqueueCommandInput = {
  commandId: string
  tenantId: string
  userId: string
  sessionId: string
  kind: Phase0CommandKind
  payload?: Record<string, unknown>
  targetLeaseToken?: string | null
  createdAt?: Date
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function cloneCommand(command: Phase0SessionCommand): Phase0SessionCommand {
  return {
    ...command,
    payload: { ...command.payload },
  }
}

function cloneLease(lease: Phase0Lease): Phase0Lease {
  return { ...lease }
}

export class Phase0ControlPlaneProofStore {
  private readonly sessions = new Map<string, SessionState>()

  ensureSession(sessionId: string) {
    let session = this.sessions.get(sessionId)
    if (session) return session
    session = {
      sessionId,
      lease: null,
      nextLeaseAttempt: 0,
      nextCommandSeq: 0,
      checkpointVersion: 0,
      projectionSeq: 0,
      commands: [],
    }
    this.sessions.set(sessionId, session)
    return session
  }

  claimSession(sessionId: string, workerId: string, now = new Date(), ttlMs = 30_000): Phase0Lease | null {
    const session = this.ensureSession(sessionId)
    const nowMs = now.getTime()
    if (session.lease && session.lease.leaseExpiresAt > nowMs) return null
    const attempt = session.nextLeaseAttempt += 1
    const lease: Phase0Lease = {
      sessionId,
      leasedBy: workerId,
      leaseToken: `${sessionId}:${attempt}:${workerId}`,
      leaseExpiresAt: nowMs + ttlMs,
      checkpointVersion: session.checkpointVersion,
    }
    session.lease = lease
    return cloneLease(lease)
  }

  renewLease(lease: Phase0Lease, now = new Date(), ttlMs = 30_000): Phase0Lease {
    const session = this.requireSession(lease.sessionId)
    this.assertCurrentLease(session, lease)
    session.lease = {
      ...session.lease!,
      leaseExpiresAt: now.getTime() + ttlMs,
    }
    return cloneLease(session.lease)
  }

  checkpoint(lease: Phase0Lease): Phase0Lease {
    const session = this.requireSession(lease.sessionId)
    this.assertCurrentLease(session, lease)
    if (lease.checkpointVersion !== session.checkpointVersion) {
      throw new Error('Checkpoint version is stale.')
    }
    session.checkpointVersion += 1
    session.lease = {
      ...session.lease!,
      checkpointVersion: session.checkpointVersion,
    }
    return cloneLease(session.lease)
  }

  writeProjection(lease: Phase0Lease, sequence: number) {
    const session = this.requireSession(lease.sessionId)
    this.assertCurrentLease(session, lease)
    if (lease.checkpointVersion !== session.checkpointVersion) {
      throw new Error('Projection write used a stale checkpoint version.')
    }
    if (sequence <= session.projectionSeq) {
      throw new Error('Projection sequence must be monotonic.')
    }
    session.projectionSeq = sequence
    return { sessionId: session.sessionId, projectionSeq: session.projectionSeq }
  }

  enqueueCommand(input: EnqueueCommandInput): Phase0SessionCommand {
    const session = this.ensureSession(input.sessionId)
    const payload = input.payload || {}
    const existing = session.commands.find((command) => command.commandId === input.commandId)
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
      return cloneCommand(existing)
    }
    const command: Phase0SessionCommand = {
      commandId: input.commandId,
      tenantId: input.tenantId,
      userId: input.userId,
      sessionId: input.sessionId,
      kind: input.kind,
      payload,
      targetLeaseToken: input.targetLeaseToken ?? null,
      createdSeq: session.nextCommandSeq += 1,
      createdAt: (input.createdAt || new Date()).toISOString(),
      status: 'pending',
      ackedBy: null,
      ackedAt: null,
      error: null,
    }
    session.commands.push(command)
    return cloneCommand(command)
  }

  claimNextCommand(lease: Phase0Lease): Phase0SessionCommand | null {
    const session = this.requireSession(lease.sessionId)
    this.assertCurrentLease(session, lease)
    const command = session.commands.find((entry) => (
      entry.status === 'pending'
      && (entry.targetLeaseToken === null || entry.targetLeaseToken === lease.leaseToken)
    ))
    if (!command) return null
    command.status = 'running'
    command.ackedBy = lease.leasedBy
    return cloneCommand(command)
  }

  ackCommand(lease: Phase0Lease, commandId: string, now = new Date()): Phase0SessionCommand {
    const session = this.requireSession(lease.sessionId)
    this.assertCurrentLease(session, lease)
    const command = this.requireCommand(session, commandId)
    if (command.status === 'acked') return cloneCommand(command)
    if (command.status !== 'running' || command.ackedBy !== lease.leasedBy) {
      throw new Error(`Command ${commandId} is not owned by this worker.`)
    }
    command.status = 'acked'
    command.ackedAt = now.toISOString()
    command.error = null
    return cloneCommand(command)
  }

  failCommand(lease: Phase0Lease, commandId: string, error: string): Phase0SessionCommand {
    const session = this.requireSession(lease.sessionId)
    this.assertCurrentLease(session, lease)
    const command = this.requireCommand(session, commandId)
    if (command.status !== 'running' || command.ackedBy !== lease.leasedBy) {
      throw new Error(`Command ${commandId} is not owned by this worker.`)
    }
    command.status = 'failed'
    command.error = error
    return cloneCommand(command)
  }

  getCommand(sessionId: string, commandId: string) {
    const session = this.requireSession(sessionId)
    return cloneCommand(this.requireCommand(session, commandId))
  }

  private requireSession(sessionId: string) {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Unknown session ${sessionId}.`)
    return session
  }

  private requireCommand(session: SessionState, commandId: string) {
    const command = session.commands.find((entry) => entry.commandId === commandId)
    if (!command) throw new Error(`Unknown command ${commandId}.`)
    return command
  }

  private assertCurrentLease(session: SessionState, lease: Phase0Lease) {
    if (!session.lease || session.lease.leaseToken !== lease.leaseToken) {
      throw new Error('Worker lease is stale.')
    }
  }
}
