import { randomUUID } from "node:crypto";

import { standaloneRetentionCutoffs } from "./retention.js";
import { redactSecretRecord, redactSecretText } from "./redaction.js";
import type {
  StandaloneGatewayAuditRecord,
  StandaloneGatewayChannelIdentityRecord,
  StandaloneGatewayDaemonLease,
  StandaloneGatewayDashboardSnapshot,
  StandaloneGatewayEventRecord,
  StandaloneGatewayEventType,
  StandaloneGatewayJobKind,
  StandaloneGatewayJobRecord,
  StandaloneGatewayIdentityAuthorizationSummary,
  StandaloneGatewayIdentityRole,
  StandaloneGatewayIdentityStatus,
  StandaloneGatewayRetentionResult,
  StandaloneGatewaySessionRecord,
  StandalonePromptInput,
} from "./types.js";

// Identifies a held daemon lease so an operation can verify ownership atomically with its own work
// (audit P1-G4) — the claim/prune only proceeds if this exact lease is still active.
export type StandaloneGatewayLeaseRef = { leaseId: string; ownerId: string; leaseToken: string };

export interface StandaloneGatewayRepository {
  migrate(): Promise<void>;
  readiness(): Promise<{ ok: boolean; detail: string }>;
  acquireDaemonLease(input: { leaseId: string; ownerId: string; ttlMs: number; now?: Date }): Promise<StandaloneGatewayDaemonLease | null>;
  renewDaemonLease(input: { leaseId: string; ownerId: string; leaseToken: string; ttlMs: number; now?: Date }): Promise<StandaloneGatewayDaemonLease | null>;
  releaseDaemonLease(input: { leaseId: string; ownerId: string; leaseToken: string }): Promise<boolean>;
  findOrCreateSession(input: StandalonePromptInput & { title?: string; now?: Date }): Promise<StandaloneGatewaySessionRecord>;
  getSession(sessionId: string): Promise<StandaloneGatewaySessionRecord | null>;
  updateSessionRuntime(input: { sessionId: string; opencodeSessionId: string | null; status?: StandaloneGatewaySessionRecord["status"]; now?: Date }): Promise<StandaloneGatewaySessionRecord>;
  appendEvent(input: { sessionId: string; type: StandaloneGatewayEventType; payload?: Record<string, unknown>; now?: Date }): Promise<StandaloneGatewayEventRecord>;
  enqueueJob(input: { kind: StandaloneGatewayJobKind; sessionId?: string | null; payload?: Record<string, unknown>; availableAt?: Date; now?: Date }): Promise<StandaloneGatewayJobRecord>;
  claimNextJob(input: { claimedBy: string; ttlMs: number; lease?: StandaloneGatewayLeaseRef | null; now?: Date }): Promise<StandaloneGatewayJobRecord | null>;
  finishJob(input: { jobId: string; claimToken: string; status: "completed" | "failed" | "dead"; lastError?: string | null; now?: Date }): Promise<StandaloneGatewayJobRecord>;
  findChannelIdentity(input: { provider: string; externalUserId: string; providerWorkspaceId?: string | null }): Promise<StandaloneGatewayChannelIdentityRecord | null>;
  upsertChannelIdentity(input: {
    identityId?: string;
    provider: string;
    externalUserId: string;
    providerWorkspaceId?: string | null;
    role: StandaloneGatewayIdentityRole;
    status?: StandaloneGatewayIdentityStatus;
    now?: Date;
  }): Promise<StandaloneGatewayChannelIdentityRecord>;
  identityAuthorizationSummary(input?: { providers?: readonly string[] }): Promise<StandaloneGatewayIdentityAuthorizationSummary>;
  listSessions(limit?: number): Promise<StandaloneGatewaySessionRecord[]>;
  dashboardSnapshot(limit?: number): Promise<StandaloneGatewayDashboardSnapshot>;
  recordAudit(action: string, actor: string, metadata?: Record<string, unknown>, now?: Date): Promise<StandaloneGatewayAuditRecord>;
  pruneRetention(input: {
    retention: { sessionDays: number; artifactDays: number; auditDays: number; jobDays: number };
    leaseId: string;
    ownerId: string;
    leaseToken: string;
    now?: Date;
  }): Promise<StandaloneGatewayRetentionResult | null>;
  close?(): Promise<void>;
}

export class InMemoryStandaloneGatewayRepository implements StandaloneGatewayRepository {
  private readonly sessions = new Map<string, StandaloneGatewaySessionRecord>();
  private readonly events = new Map<string, StandaloneGatewayEventRecord[]>();
  private readonly jobs = new Map<string, StandaloneGatewayJobRecord>();
  private readonly leases = new Map<string, StandaloneGatewayDaemonLease>();
  private readonly identities = new Map<string, StandaloneGatewayChannelIdentityRecord>();
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
    const providerWorkspaceId = normalizeWorkspaceId(input.providerWorkspaceId);
    const existing = [...this.sessions.values()].find((session) =>
      session.provider === input.provider &&
      session.providerWorkspaceId === providerWorkspaceId &&
      session.externalChatId === input.target.chatId &&
      session.externalThreadId === externalThreadId
    );
    const now = (input.now || new Date()).toISOString();
    if (existing) {
      const touched = { ...existing, updatedAt: now };
      this.sessions.set(touched.sessionId, touched);
      return { ...touched };
    }
    const session: StandaloneGatewaySessionRecord = {
      sessionId: randomUUID(),
      opencodeSessionId: null,
      title: input.title || input.text.slice(0, 80) || "Standalone Gateway session",
      status: "idle",
      provider: input.provider,
      providerKind: input.providerKind,
      providerWorkspaceId,
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

  async getSession(sessionId: string): Promise<StandaloneGatewaySessionRecord | null> {
    const session = this.sessions.get(sessionId);
    return session ? { ...session } : null;
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

  async claimNextJob(input: { claimedBy: string; ttlMs: number; lease?: StandaloneGatewayLeaseRef | null; now?: Date }): Promise<StandaloneGatewayJobRecord | null> {
    const now = input.now || new Date();
    // Lease-aware claim (audit P1-G4): a daemon whose lease is no longer active cannot claim a job,
    // mirroring the postgres EXISTS guard so the split-brain window closes in both stores.
    if (input.lease) {
      const lease = this.leases.get(input.lease.leaseId);
      const active = lease
        && lease.ownerId === input.lease.ownerId
        && lease.leaseToken === input.lease.leaseToken
        && new Date(lease.expiresAt).getTime() > now.getTime();
      if (!active) return null;
    }
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

  async findChannelIdentity(input: { provider: string; externalUserId: string; providerWorkspaceId?: string | null }): Promise<StandaloneGatewayChannelIdentityRecord | null> {
    const workspaceId = normalizeWorkspaceId(input.providerWorkspaceId);
    const exact = this.identities.get(identityKey(input.provider, workspaceId, input.externalUserId));
    if (exact) return cloneIdentity(exact);
    return null;
  }

  async upsertChannelIdentity(input: {
    identityId?: string;
    provider: string;
    externalUserId: string;
    providerWorkspaceId?: string | null;
    role: StandaloneGatewayIdentityRole;
    status?: StandaloneGatewayIdentityStatus;
    now?: Date;
  }): Promise<StandaloneGatewayChannelIdentityRecord> {
    const role = normalizeIdentityRole(input.role);
    const status = normalizeIdentityStatus(input.status || "active");
    const providerWorkspaceId = normalizeWorkspaceId(input.providerWorkspaceId);
    const key = identityKey(input.provider, providerWorkspaceId, input.externalUserId);
    const existing = this.identities.get(key);
    const now = (input.now || new Date()).toISOString();
    const identity: StandaloneGatewayChannelIdentityRecord = {
      identityId: existing?.identityId || input.identityId || randomUUID(),
      provider: input.provider as StandaloneGatewayChannelIdentityRecord["provider"],
      externalUserId: input.externalUserId,
      providerWorkspaceId,
      role,
      status,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    this.identities.set(key, identity);
    return cloneIdentity(identity);
  }

  async identityAuthorizationSummary(input: { providers?: readonly string[] } = {}): Promise<StandaloneGatewayIdentityAuthorizationSummary> {
    const providers = input.providers?.length ? new Set(input.providers) : null;
    const identities = [...this.identities.values()].filter((identity) => !providers || providers.has(identity.provider));
    return {
      total: identities.length,
      active: identities.filter((identity) => identity.status === "active").length,
      promptCapable: identities.filter((identity) => canIdentityPrompt(identity)).length,
    };
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
      identities: [...this.identities.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, limit).map(cloneIdentity),
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

  async pruneRetention(input: {
    retention: { sessionDays: number; artifactDays: number; auditDays: number; jobDays: number };
    leaseId: string;
    ownerId: string;
    leaseToken: string;
    now?: Date;
  }): Promise<StandaloneGatewayRetentionResult | null> {
    const now = input.now || new Date();
    const lease = this.leases.get(input.leaseId);
    if (
      !lease ||
      lease.ownerId !== input.ownerId ||
      lease.leaseToken !== input.leaseToken ||
      new Date(lease.expiresAt).getTime() <= now.getTime()
    ) {
      return null;
    }
    const cutoffs = standaloneRetentionCutoffs(input.retention, now);
    let sessionsDeleted = 0;
    for (const session of [...this.sessions.values()]) {
      if (
        new Date(session.updatedAt).getTime() < cutoffs.sessionCutoff.getTime() &&
        isRetainableSessionStatus(session.status) &&
        !this.hasActiveJobForSession(session.sessionId)
      ) {
        this.sessions.delete(session.sessionId);
        this.events.delete(session.sessionId);
        sessionsDeleted += 1;
      }
    }
    let jobsDeleted = 0;
    for (const job of [...this.jobs.values()]) {
      if (
        new Date(job.updatedAt).getTime() < cutoffs.jobCutoff.getTime() &&
        isTerminalJobStatus(job.status)
      ) {
        this.jobs.delete(job.jobId);
        jobsDeleted += 1;
      }
    }
    let auditEventsDeleted = 0;
    for (let index = this.audits.length - 1; index >= 0; index -= 1) {
      if (new Date(this.audits[index]!.createdAt).getTime() < cutoffs.auditCutoff.getTime()) {
        this.audits.splice(index, 1);
        auditEventsDeleted += 1;
      }
    }
    const result = retentionResult(now, cutoffs, {
      sessionsDeleted,
      artifactsDeleted: 0,
      auditEventsDeleted,
      jobsDeleted,
    });
    await this.recordAudit("standalone.retention.pruned", input.ownerId, retentionAuditMetadata(result), now);
    return result;
  }

  private requireSession(sessionId: string): StandaloneGatewaySessionRecord {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown standalone gateway session ${sessionId}.`);
    return session;
  }

  private hasActiveJobForSession(sessionId: string): boolean {
    return [...this.jobs.values()].some((job) => job.sessionId === sessionId && !isTerminalJobStatus(job.status));
  }
}

export function redactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return redactSecretRecord(input);
}

function redactText(value: string): string {
  return redactSecretText(value);
}

function cloneJob(job: StandaloneGatewayJobRecord): StandaloneGatewayJobRecord {
  return { ...job, payload: { ...job.payload } };
}

export function canIdentityPrompt(identity: Pick<StandaloneGatewayChannelIdentityRecord, "role" | "status">): boolean {
  return identity.status === "active" && (identity.role === "owner" || identity.role === "admin" || identity.role === "member");
}

export function normalizeIdentityRole(value: string): StandaloneGatewayIdentityRole {
  if (value === "owner" || value === "admin" || value === "member" || value === "approver" || value === "viewer") return value;
  throw new Error(`Unsupported standalone gateway identity role ${value}.`);
}

export function normalizeIdentityStatus(value: string): StandaloneGatewayIdentityStatus {
  if (value === "active" || value === "disabled") return value;
  throw new Error(`Unsupported standalone gateway identity status ${value}.`);
}

export function normalizeWorkspaceId(value: string | null | undefined): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function identityKey(provider: string, providerWorkspaceId: string | null, externalUserId: string): string {
  return `${provider}\0${providerWorkspaceId || ""}\0${externalUserId}`;
}

function cloneIdentity(identity: StandaloneGatewayChannelIdentityRecord): StandaloneGatewayChannelIdentityRecord {
  return { ...identity };
}

export function retentionResult(
  now: Date,
  cutoffs: {
    sessionCutoff: Date;
    artifactCutoff: Date;
    auditCutoff: Date;
    jobCutoff: Date;
  },
  counts: {
    sessionsDeleted: number;
    artifactsDeleted: number;
    auditEventsDeleted: number;
    jobsDeleted: number;
  },
): StandaloneGatewayRetentionResult {
  return {
    ranAt: now.toISOString(),
    sessionCutoff: cutoffs.sessionCutoff.toISOString(),
    artifactCutoff: cutoffs.artifactCutoff.toISOString(),
    auditCutoff: cutoffs.auditCutoff.toISOString(),
    jobCutoff: cutoffs.jobCutoff.toISOString(),
    ...counts,
  };
}

export function retentionAuditMetadata(result: StandaloneGatewayRetentionResult): Record<string, unknown> {
  return {
    sessionCutoff: result.sessionCutoff,
    artifactCutoff: result.artifactCutoff,
    auditCutoff: result.auditCutoff,
    jobCutoff: result.jobCutoff,
    sessionsDeleted: result.sessionsDeleted,
    artifactsDeleted: result.artifactsDeleted,
    auditEventsDeleted: result.auditEventsDeleted,
    jobsDeleted: result.jobsDeleted,
  };
}

function isRetainableSessionStatus(status: StandaloneGatewaySessionRecord["status"]): boolean {
  return status === "idle" || status === "failed" || status === "completed";
}

function isTerminalJobStatus(status: StandaloneGatewayJobRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "dead";
}
