import { randomUUID } from "node:crypto";

import type {
  StandaloneGatewayAuditRecord,
  StandaloneGatewayDaemonLease,
  StandaloneGatewayDashboardSnapshot,
  StandaloneGatewayEventRecord,
  StandaloneGatewayEventType,
  StandaloneGatewayJobKind,
  StandaloneGatewayJobRecord,
  StandaloneGatewaySessionRecord,
  StandalonePromptInput,
} from "./types.js";

export interface StandaloneGatewayRepository {
  migrate(): Promise<void>;
  readiness(): Promise<{ ok: boolean; detail: string }>;
  acquireDaemonLease(input: { leaseId: string; ownerId: string; ttlMs: number; now?: Date }): Promise<StandaloneGatewayDaemonLease | null>;
  renewDaemonLease(input: { leaseId: string; ownerId: string; leaseToken: string; ttlMs: number; now?: Date }): Promise<StandaloneGatewayDaemonLease | null>;
  releaseDaemonLease(input: { leaseId: string; ownerId: string; leaseToken: string }): Promise<boolean>;
  findOrCreateSession(input: StandalonePromptInput & { title?: string; now?: Date }): Promise<StandaloneGatewaySessionRecord>;
  updateSessionRuntime(input: { sessionId: string; opencodeSessionId: string | null; status?: StandaloneGatewaySessionRecord["status"]; now?: Date }): Promise<StandaloneGatewaySessionRecord>;
  appendEvent(input: { sessionId: string; type: StandaloneGatewayEventType; payload?: Record<string, unknown>; now?: Date }): Promise<StandaloneGatewayEventRecord>;
  enqueueJob(input: { kind: StandaloneGatewayJobKind; sessionId?: string | null; payload?: Record<string, unknown>; availableAt?: Date; now?: Date }): Promise<StandaloneGatewayJobRecord>;
  claimNextJob(input: { claimedBy: string; ttlMs: number; now?: Date }): Promise<StandaloneGatewayJobRecord | null>;
  finishJob(input: { jobId: string; claimToken: string; status: "completed" | "failed" | "dead"; lastError?: string | null; now?: Date }): Promise<StandaloneGatewayJobRecord>;
  listSessions(limit?: number): Promise<StandaloneGatewaySessionRecord[]>;
  dashboardSnapshot(limit?: number): Promise<StandaloneGatewayDashboardSnapshot>;
  recordAudit(action: string, actor: string, metadata?: Record<string, unknown>, now?: Date): Promise<StandaloneGatewayAuditRecord>;
  close?(): Promise<void>;
}

export class InMemoryStandaloneGatewayRepository implements StandaloneGatewayRepository {
  private readonly sessions = new Map<string, StandaloneGatewaySessionRecord>();
  private readonly events = new Map<string, StandaloneGatewayEventRecord[]>();
  private readonly jobs = new Map<string, StandaloneGatewayJobRecord>();
  private readonly leases = new Map<string, StandaloneGatewayDaemonLease>();
  private readonly audits: StandaloneGatewayAuditRecord[] = [];

  async migrate(): Promise<void> {}

  async readiness(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: "in-memory standalone gateway repository ready" };
  }

  async acquireDaemonLease(input: { leaseId: string; ownerId: string; ttlMs: number; now?: Date }): Promise<StandaloneGatewayDaemonLease | null> {
    const now = input.now || new Date();
    const existing = this.leases.get(input.leaseId);
    if (existing && new Date(existing.expiresAt).getTime() > now.getTime() && existing.ownerId !== input.ownerId) return null;
    const lease = {
      leaseId: input.leaseId,
      ownerId: input.ownerId,
      leaseToken: randomUUID(),
      expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
      updatedAt: now.toISOString(),
    };
    this.leases.set(input.leaseId, lease);
    return { ...lease };
  }

  async renewDaemonLease(input: { leaseId: string; ownerId: string; leaseToken: string; ttlMs: number; now?: Date }): Promise<StandaloneGatewayDaemonLease | null> {
    const existing = this.leases.get(input.leaseId);
    if (!existing || existing.ownerId !== input.ownerId || existing.leaseToken !== input.leaseToken) return null;
    const now = input.now || new Date();
    const lease = {
      ...existing,
      expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
      updatedAt: now.toISOString(),
    };
    this.leases.set(input.leaseId, lease);
    return { ...lease };
  }

  async releaseDaemonLease(input: { leaseId: string; ownerId: string; leaseToken: string }): Promise<boolean> {
    const existing = this.leases.get(input.leaseId);
    if (!existing || existing.ownerId !== input.ownerId || existing.leaseToken !== input.leaseToken) return false;
    this.leases.delete(input.leaseId);
    return true;
  }

  async findOrCreateSession(input: StandalonePromptInput & { title?: string; now?: Date }): Promise<StandaloneGatewaySessionRecord> {
    const externalThreadId = input.target.threadId || input.target.chatId;
    const existing = [...this.sessions.values()].find((session) =>
      session.provider === input.provider &&
      session.externalChatId === input.target.chatId &&
      session.externalThreadId === externalThreadId
    );
    if (existing) return { ...existing };
    const now = (input.now || new Date()).toISOString();
    const session: StandaloneGatewaySessionRecord = {
      sessionId: randomUUID(),
      opencodeSessionId: null,
      title: input.title || input.text.slice(0, 80) || "Standalone Gateway session",
      status: "idle",
      provider: input.provider,
      providerKind: input.providerKind,
      channelBindingId: input.channelBindingId,
      externalUserId: input.externalUserId,
      externalChatId: input.target.chatId,
      externalThreadId,
      lastEventSequence: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(session.sessionId, session);
    await this.appendEvent({ sessionId: session.sessionId, type: "session.created", payload: { title: session.title }, now: input.now });
    return { ...this.requireSession(session.sessionId) };
  }

  async updateSessionRuntime(input: { sessionId: string; opencodeSessionId: string | null; status?: StandaloneGatewaySessionRecord["status"]; now?: Date }): Promise<StandaloneGatewaySessionRecord> {
    const current = this.requireSession(input.sessionId);
    const updated = {
      ...current,
      opencodeSessionId: current.opencodeSessionId || input.opencodeSessionId,
      status: input.status || current.status,
      updatedAt: (input.now || new Date()).toISOString(),
    };
    this.sessions.set(updated.sessionId, updated);
    return { ...updated };
  }

  async appendEvent(input: { sessionId: string; type: StandaloneGatewayEventType; payload?: Record<string, unknown>; now?: Date }): Promise<StandaloneGatewayEventRecord> {
    const current = this.requireSession(input.sessionId);
    const sequence = current.lastEventSequence + 1;
    const now = (input.now || new Date()).toISOString();
    const event: StandaloneGatewayEventRecord = {
      eventId: randomUUID(),
      sessionId: input.sessionId,
      sequence,
      type: input.type,
      payload: redactRecord(input.payload || {}),
      createdAt: now,
    };
    this.events.set(input.sessionId, [...(this.events.get(input.sessionId) || []), event]);
    this.sessions.set(input.sessionId, { ...current, lastEventSequence: sequence, updatedAt: now });
    return { ...event, payload: { ...event.payload } };
  }

  async enqueueJob(input: { kind: StandaloneGatewayJobKind; sessionId?: string | null; payload?: Record<string, unknown>; availableAt?: Date; now?: Date }): Promise<StandaloneGatewayJobRecord> {
    const now = input.now || new Date();
    const job: StandaloneGatewayJobRecord = {
      jobId: randomUUID(),
      kind: input.kind,
      status: "pending",
      sessionId: input.sessionId || null,
      payload: redactRecord(input.payload || {}),
      claimedBy: null,
      claimToken: null,
      claimExpiresAt: null,
      attemptCount: 0,
      availableAt: (input.availableAt || now).toISOString(),
      lastError: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    this.jobs.set(job.jobId, job);
    return cloneJob(job);
  }

  async claimNextJob(input: { claimedBy: string; ttlMs: number; now?: Date }): Promise<StandaloneGatewayJobRecord | null> {
    const now = input.now || new Date();
    const candidate = [...this.jobs.values()]
      .filter((job) => job.status === "pending" || (job.status === "claimed" && job.claimExpiresAt && new Date(job.claimExpiresAt).getTime() <= now.getTime()))
      .filter((job) => new Date(job.availableAt).getTime() <= now.getTime())
      .sort((left, right) => left.availableAt.localeCompare(right.availableAt))[0];
    if (!candidate) return null;
    const claimed: StandaloneGatewayJobRecord = {
      ...candidate,
      status: "claimed",
      claimedBy: input.claimedBy,
      claimToken: randomUUID(),
      claimExpiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
      attemptCount: candidate.attemptCount + 1,
      updatedAt: now.toISOString(),
    };
    this.jobs.set(claimed.jobId, claimed);
    return cloneJob(claimed);
  }

  async finishJob(input: { jobId: string; claimToken: string; status: "completed" | "failed" | "dead"; lastError?: string | null; now?: Date }): Promise<StandaloneGatewayJobRecord> {
    const current = this.jobs.get(input.jobId);
    if (!current) throw new Error(`Unknown standalone gateway job ${input.jobId}.`);
    if (current.claimToken !== input.claimToken) throw new Error("Cannot finish standalone gateway job with a stale claim token.");
    const updated: StandaloneGatewayJobRecord = {
      ...current,
      status: input.status,
      claimExpiresAt: null,
      lastError: input.lastError ? redactText(input.lastError) : null,
      updatedAt: (input.now || new Date()).toISOString(),
    };
    this.jobs.set(updated.jobId, updated);
    return cloneJob(updated);
  }

  async listSessions(limit = 50): Promise<StandaloneGatewaySessionRecord[]> {
    return [...this.sessions.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, Math.max(1, Math.min(200, limit)))
      .map((session) => ({ ...session }));
  }

  async dashboardSnapshot(limit = 50): Promise<StandaloneGatewayDashboardSnapshot> {
    return {
      generatedAt: new Date().toISOString(),
      sessions: await this.listSessions(limit),
      jobs: [...this.jobs.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, limit).map(cloneJob),
      audits: this.audits.slice(-limit).reverse().map((audit) => ({ ...audit, metadata: { ...audit.metadata } })),
    };
  }

  async recordAudit(action: string, actor: string, metadata: Record<string, unknown> = {}, now = new Date()): Promise<StandaloneGatewayAuditRecord> {
    const audit: StandaloneGatewayAuditRecord = {
      auditId: randomUUID(),
      action,
      actor,
      metadata: redactRecord(metadata),
      createdAt: now.toISOString(),
    };
    this.audits.push(audit);
    return { ...audit, metadata: { ...audit.metadata } };
  }

  private requireSession(sessionId: string): StandaloneGatewaySessionRecord {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown standalone gateway session ${sessionId}.`);
    return session;
  }
}

export function redactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [
    key,
    redactValue(key, value),
  ]));
}

function redactValue(key: string, value: unknown): unknown {
  if (/token|secret|password|credential|authorization|api[_-]?key/i.test(key)) return "[redacted]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((entry) => redactValue(key, entry));
  if (value && typeof value === "object") return redactRecord(value as Record<string, unknown>);
  return value;
}

function redactText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]")
    .replace(/(token|secret|password|api[_-]?key)=([^&\s]+)/gi, "$1=[redacted]");
}

function cloneJob(job: StandaloneGatewayJobRecord): StandaloneGatewayJobRecord {
  return { ...job, payload: { ...job.payload } };
}
