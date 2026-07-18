import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { OpenWikiRuntimeBusyError, assertOpenWikiId, isoNow } from "@openwiki/core";
import { clearRepositoryProcessReadCache, readConfig } from "@openwiki/repo";
import { PostgresWriteLeaseBusyError, withPostgresWriteLease, type PostgresWriteLeaseDiagnostic } from "@openwiki/postgres-runtime";
import { incrementWriteCoordinationMetric } from "./write-coordination-metrics.ts";

const WRITE_COORDINATOR_LOCK_NAME = "git-writes";
const DEFAULT_WRITE_LEASE_MS = 30000;
const DEFAULT_WRITE_HEARTBEAT_MS = 5000;

export type WriteCoordinatorBackend = "local" | "postgres";

export interface WriteLockDiagnostic {
  backend: WriteCoordinatorBackend;
  workspace_id?: string;
  lock_name: string;
  actor_id: string;
  operation: string;
  started_at: string;
  heartbeat_at: string;
  expires_at: string;
  metadata: Record<string, unknown>;
}

export interface WriteCoordinationInput {
  root: string;
  actorId?: string;
  operation: string;
  metadata?: Record<string, unknown>;
  backend?: WriteCoordinatorBackend;
  waitMs?: number;
  leaseMs?: number;
  heartbeatMs?: number;
}

export interface WriteCoordinationContext {
  signal: AbortSignal;
}

/** Raised when another local or Postgres writer currently owns the workspace lease. */
export class OpenWikiWriteInProgressError extends OpenWikiRuntimeBusyError {
  readonly active: WriteLockDiagnostic;

  constructor(active: WriteLockDiagnostic) {
    super(`OpenWiki write in progress: ${active.operation} by ${active.actor_id} since ${active.started_at}; lease expires at ${active.expires_at}`);
    this.name = "OpenWikiWriteInProgressError";
    this.active = active;
  }
}

const activeWriteCoordination = new AsyncLocalStorage<{ root: string; backend: WriteCoordinatorBackend; signal: AbortSignal }>();

/** Run a mutating workflow while holding the configured local or Postgres write lease. */
export async function withWriteCoordination<T>(input: WriteCoordinationInput, callback: (context: WriteCoordinationContext) => Promise<T>): Promise<T> {
  const root = path.resolve(input.root);
  const active = activeWriteCoordination.getStore();
  if (active?.root === root) {
    return callback({ signal: active.signal });
  }

  const actorId = input.actorId ?? "actor:user:local";
  assertOpenWikiId(actorId, "actor");
  const backend = await resolveWriteCoordinatorBackend(root, input.backend);
  const leaseMs = boundedWriteLeaseMs(input.leaseMs ?? numberFromEnv("OPENWIKI_WRITE_LEASE_MS") ?? DEFAULT_WRITE_LEASE_MS);
  const heartbeatMs = boundedWriteHeartbeatMs(input.heartbeatMs ?? numberFromEnv("OPENWIKI_WRITE_HEARTBEAT_MS") ?? DEFAULT_WRITE_HEARTBEAT_MS, leaseMs);
  const metadata = input.metadata ?? {};
  const requestedAt = Date.now();
  let acquiredAt: number | undefined;
  const coordinatedCallback = async (context: WriteCoordinationContext) => {
    acquiredAt = Date.now();
    return callback(context);
  };

  try {
    if (backend === "postgres") {
      try {
        return await withPostgresWriteLease(
          {
            root,
            lockName: WRITE_COORDINATOR_LOCK_NAME,
            actorId,
            operation: input.operation,
            metadata,
            leaseMs,
            heartbeatMs,
          },
          (signal) => activeWriteCoordination.run({ root, backend, signal }, () => coordinatedCallback({ signal })),
        );
      } catch (error) {
        if (error instanceof PostgresWriteLeaseBusyError) {
          throw new OpenWikiWriteInProgressError(postgresLeaseDiagnostic(error.active));
        }
        throw error;
      }
    }

    return await withLocalWriteLease(
      {
        root,
        actorId,
        operation: input.operation,
        metadata,
        waitMs: boundedWriteWaitMs(input.waitMs ?? numberFromEnv("OPENWIKI_WRITE_WAIT_MS") ?? 0),
        leaseMs,
        heartbeatMs,
      },
      (signal) => activeWriteCoordination.run({ root, backend, signal }, () => coordinatedCallback({ signal })),
    );
  } catch (error) {
    recordWriteCoordinationMetric(backend, input.operation, error instanceof OpenWikiWriteInProgressError ? "busy" : "error", requestedAt, acquiredAt);
    throw error;
  } finally {
    if (acquiredAt !== undefined) {
      clearRepositoryProcessReadCache(root);
      recordWriteCoordinationMetric(backend, input.operation, "acquired", requestedAt, acquiredAt);
    }
  }
}

interface LocalWriteLeaseInput {
  root: string;
  actorId: string;
  operation: string;
  metadata: Record<string, unknown>;
  waitMs: number;
  leaseMs: number;
  heartbeatMs: number;
}

async function withLocalWriteLease<T>(input: LocalWriteLeaseInput, callback: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const lockDir = path.join(input.root, ".openwiki", "locks");
  const lockPath = path.join(lockDir, "write-coordinator.lock");
  const token = randomUUID();
  const deadline = Date.now() + input.waitMs;
  await fs.mkdir(lockDir, { recursive: true });

  while (true) {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(lockPath, "wx");
      let diagnostic = localWriteDiagnostic(input, token);
      await handle.writeFile(`${JSON.stringify(diagnostic, null, 2)}\n`);
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let heartbeatError: Error | undefined;
      let heartbeatStopped = false;
      const leaseAbort = new AbortController();
      try {
        heartbeat = setInterval(() => {
          diagnostic = localWriteDiagnostic(input, token, diagnostic.started_at);
          void heartbeatLocalWriteLease(lockPath, token, diagnostic, () => heartbeatStopped).catch((error) => {
            heartbeatError = error instanceof Error ? error : new Error(String(error));
            leaseAbort.abort(heartbeatError);
          });
        }, input.heartbeatMs);
        heartbeat.unref();
        const result = await callback(leaseAbort.signal);
        if (heartbeatError !== undefined) {
          throw heartbeatError;
        }
        return result;
      } finally {
        heartbeatStopped = true;
        if (heartbeat !== undefined) {
          clearInterval(heartbeat);
        }
        await handle.close();
        await releaseLocalWriteLease(lockPath, token);
      }
    } catch (error) {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      if (!isFileExistsError(error)) {
        throw error;
      }
      const active = await readLocalWriteLease(lockPath);
      if (active !== undefined && localLeaseExpired(active)) {
        await fs.rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new OpenWikiWriteInProgressError(
          active ?? {
            backend: "local",
            lock_name: WRITE_COORDINATOR_LOCK_NAME,
            actor_id: "actor:user:unknown",
            operation: "unknown",
            started_at: "",
            heartbeat_at: "",
            expires_at: "",
            metadata: {},
          },
        );
      }
      await sleep(25);
    }
  }
}

function localWriteDiagnostic(
  input: LocalWriteLeaseInput,
  token: string,
  startedAt = isoNow(),
): WriteLockDiagnostic & { token: string; pid: number; hostname: string } {
  const heartbeatAt = isoNow();
  return {
    backend: "local",
    lock_name: WRITE_COORDINATOR_LOCK_NAME,
    actor_id: input.actorId,
    operation: input.operation,
    started_at: startedAt,
    heartbeat_at: heartbeatAt,
    expires_at: new Date(Date.now() + input.leaseMs).toISOString(),
    metadata: input.metadata,
    token,
    pid: process.pid,
    hostname: os.hostname(),
  };
}

async function heartbeatLocalWriteLease(
  lockPath: string,
  token: string,
  diagnostic: WriteLockDiagnostic & { token: string; pid: number; hostname: string },
  stopped: () => boolean,
): Promise<void> {
  if (stopped()) {
    return;
  }
  const handle = await fs.open(lockPath, "r+").catch((error: unknown) => {
    if (stopped() || isEnoentError(error)) {
      return undefined;
    }
    throw error;
  });
  if (handle === undefined) {
    return;
  }
  try {
    const raw = await handle.readFile("utf8");
    if (stopped()) {
      return;
    }
    const active = parseJsonObject(raw);
    if (active.token !== token) {
      throw new Error("OpenWiki local write lease heartbeat lost ownership");
    }
    if (stopped()) {
      return;
    }
    await handle.truncate(0);
    await handle.write(`${JSON.stringify(diagnostic, null, 2)}\n`, 0, "utf8");
  } finally {
    await handle.close();
  }
}

async function releaseLocalWriteLease(lockPath: string, token: string): Promise<void> {
  const raw = await fs.readFile(lockPath, "utf8").catch(() => undefined);
  if (raw === undefined) {
    return;
  }
  const parsed = parseJsonObject(raw);
  if (parsed.token === token) {
    await fs.rm(lockPath, { force: true });
  }
}

async function readLocalWriteLease(lockPath: string): Promise<WriteLockDiagnostic | undefined> {
  const raw = await fs.readFile(lockPath, "utf8").catch(() => undefined);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = parseJsonObject(raw);
  const result: WriteLockDiagnostic = {
    backend: parsed.backend === "postgres" ? "postgres" : "local",
    lock_name: typeof parsed.lock_name === "string" ? parsed.lock_name : WRITE_COORDINATOR_LOCK_NAME,
    actor_id: typeof parsed.actor_id === "string" ? parsed.actor_id : "actor:user:unknown",
    operation: typeof parsed.operation === "string" ? parsed.operation : "unknown",
    started_at: typeof parsed.started_at === "string" ? parsed.started_at : "",
    heartbeat_at: typeof parsed.heartbeat_at === "string" ? parsed.heartbeat_at : "",
    expires_at: typeof parsed.expires_at === "string" ? parsed.expires_at : "",
    metadata: parsed.metadata && typeof parsed.metadata === "object" && !Array.isArray(parsed.metadata) ? parsed.metadata as Record<string, unknown> : {},
  };
  if (typeof parsed.workspace_id === "string") {
    result.workspace_id = parsed.workspace_id;
  }
  return result;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function localLeaseExpired(diagnostic: WriteLockDiagnostic): boolean {
  const expiresAt = Date.parse(diagnostic.expires_at);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function postgresLeaseDiagnostic(active: PostgresWriteLeaseDiagnostic): WriteLockDiagnostic {
  return {
    backend: "postgres",
    workspace_id: active.workspace_id,
    lock_name: active.lock_name,
    actor_id: active.actor_id,
    operation: active.operation,
    started_at: active.started_at,
    heartbeat_at: active.heartbeat_at,
    expires_at: active.expires_at,
    metadata: active.metadata,
  };
}

export async function resolveWriteCoordinatorBackend(root: string, backend?: WriteCoordinatorBackend): Promise<WriteCoordinatorBackend> {
  const config = backend === undefined ? await readConfig(root).catch(() => undefined) : undefined;
  return resolveWriteCoordinatorBackendFromEnvOrConfig(config?.runtime?.queue?.backend, backend);
}

export function resolveWriteCoordinatorBackendFromEnvOrConfig(
  configuredQueueBackend: string | undefined,
  backend?: WriteCoordinatorBackend,
): WriteCoordinatorBackend {
  const value = backend ?? process.env.OPENWIKI_WRITE_COORDINATOR_BACKEND?.trim();
  if (value === "local" || value === "postgres") {
    return value;
  }
  if (value) {
    throw new Error(`Invalid OPENWIKI_WRITE_COORDINATOR_BACKEND '${value}'`);
  }
  if (
    process.env.OPENWIKI_QUEUE_BACKEND?.trim() === "postgres" ||
    process.env.OPENWIKI_RUNTIME_BACKEND?.trim() === "postgres" ||
    configuredQueueBackend === "postgres"
  ) {
    return "postgres";
  }
  return "local";
}

function boundedWriteWaitMs(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 15 * 60 * 1000) {
    throw new Error("OpenWiki write wait must be between 0 and 900000 milliseconds");
  }
  return Math.trunc(value);
}

function boundedWriteLeaseMs(value: number): number {
  if (!Number.isFinite(value) || value < 1000 || value > 15 * 60 * 1000) {
    throw new Error("OpenWiki write lease must be between 1000 and 900000 milliseconds");
  }
  return Math.trunc(value);
}

function boundedWriteHeartbeatMs(value: number, leaseMs: number): number {
  if (!Number.isFinite(value) || value < 100 || value >= leaseMs) {
    throw new Error("OpenWiki write heartbeat must be at least 100 ms and less than the write lease");
  }
  return Math.trunc(value);
}

function numberFromEnv(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  return Number(value);
}

function recordWriteCoordinationMetric(
  backend: WriteCoordinatorBackend,
  operation: string,
  status: "acquired" | "busy" | "error",
  requestedAt: number,
  acquiredAt: number | undefined,
): void {
  incrementWriteCoordinationMetric(["acquire", backend, operation, status].join("|"), 1);
  const waitSeconds = ((acquiredAt ?? Date.now()) - requestedAt) / 1000;
  incrementWriteCoordinationMetric(["wait_seconds", backend, operation].join("|"), waitSeconds);
  if (acquiredAt !== undefined) {
    incrementWriteCoordinationMetric(["hold_seconds", backend, operation].join("|"), (Date.now() - acquiredAt) / 1000);
  }
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EEXIST";
}

function isEnoentError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
