import { hostname } from "node:os";

import {
  assertStandaloneGatewayProductionDatabaseSecurity,
  loadStandaloneGatewayConfig,
  standaloneGatewayProductionDatabaseSecurityIssue,
} from "./config.js";
import { runStandaloneGatewayDoctor } from "./doctor.js";
import { createSdkOpenCodeAdapter } from "./opencode.js";
import { createStandaloneGatewayPostgresRepository } from "./postgres-repository.js";
import { createStandaloneProviderRegistry } from "./provider-registry.js";
import { runStandaloneGatewayRetention } from "./retention.js";
import { InMemoryStandaloneGatewayRepository, normalizeIdentityRole, normalizeIdentityStatus } from "./repository.js";
import { createStandaloneGatewayRuntime } from "./runtime.js";
import { createStandaloneGatewayServer } from "./server.js";
import { runStandaloneGatewaySmoke } from "./smoke.js";
import type { StandaloneGatewayRepository } from "./repository.js";
import type { StandaloneGatewayConfig } from "./types.js";

const command = process.argv[2] || "serve";
const daemonLeaseId = "standalone-gateway:daemon";
const daemonLeaseTtlMs = 30_000;
const daemonLeaseRenewalMs = 10_000;
const maintenanceIntervalMs = 5_000;
const retentionIntervalMs = 60 * 60 * 1000;

if (command === "smoke") {
  const result = await runStandaloneGatewaySmoke();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  const config = loadStandaloneGatewayConfig();
  const opencode = createSdkOpenCodeAdapter({ baseUrl: config.opencode.baseUrl });

  if (command === "doctor") {
    const databaseSecurityIssue = standaloneGatewayProductionDatabaseSecurityIssue(config);
    const repository = databaseSecurityIssue
      ? skippedDoctorRepository(databaseSecurityIssue)
      : await createMigratedRepository(config);
    const result = await runStandaloneGatewayDoctor({ config, repository, opencode });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    await repository.close?.();
    process.exitCode = result.ok ? 0 : 1;
  } else if (command === "identity") {
    assertStandaloneGatewayProductionDatabaseSecurity(config);
    const repository = await createStandaloneGatewayRepository(config);
    await repository.migrate();
    const action = process.argv[3] || "";
    if (action !== "upsert") {
      throw new Error("Unknown standalone gateway identity command. Use: identity upsert --provider <id> --external-user-id <id> --role <owner|admin|member|approver|viewer> [--status <active|disabled>] [--provider-workspace-id <id>].");
    }
    const args = parseArgs(process.argv.slice(4));
    const provider = requiredArg(args, "provider");
    if (!config.providers.some((configuredProvider) => configuredProvider.enabled && configuredProvider.id === provider)) {
      throw new Error(`Standalone Gateway provider ${provider} is not configured or enabled.`);
    }
    const identity = await repository.upsertChannelIdentity({
      provider,
      externalUserId: requiredArg(args, "external-user-id"),
      providerWorkspaceId: args["provider-workspace-id"] || null,
      role: normalizeIdentityRole(requiredArg(args, "role")),
      status: normalizeIdentityStatus(args.status || "active"),
    });
    process.stdout.write(`${JSON.stringify({ ok: true, identity }, null, 2)}\n`);
    await repository.close?.();
  } else if (command === "serve") {
    assertStandaloneGatewayProductionDatabaseSecurity(config);
    const repository = await createStandaloneGatewayRepository(config);
    await repository.migrate();
    const ownerId = `${hostname()}:${process.pid}`;
    const lease = await repository.acquireDaemonLease({
      leaseId: daemonLeaseId,
      ownerId,
      ttlMs: daemonLeaseTtlMs,
    });
    if (!lease) {
      throw new Error("Another Standalone Gateway daemon owns the active provider/runtime lease.");
    }
    let leaseToken = lease.leaseToken;
    // Single source of truth for "this daemon still owns the lease". Flipped to false synchronously
    // the moment a renewal fails (audit P1-G4) so the maintenance loop, the job claimer and the
    // provider message handler all stop BEFORE process.exit completes — closing the window where a
    // lease-losing daemon kept claiming/prompting while a successor acquired the lease.
    let leaseActive = true;
    const leaseRenewal = setInterval(() => {
      void repository.renewDaemonLease({
        leaseId: daemonLeaseId,
        ownerId,
        leaseToken,
        ttlMs: daemonLeaseTtlMs,
      }).then((renewed) => {
        if (!renewed) throw new Error("Lost Standalone Gateway daemon lease.");
        leaseToken = renewed.leaseToken;
      }).catch((error: unknown) => {
        leaseActive = false;
        process.stderr.write(`Standalone Gateway lease renewal failed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      });
    }, daemonLeaseRenewalMs);

    const runtime = createStandaloneGatewayRuntime({ repository, opencode });
    const leaseRef = { leaseId: daemonLeaseId, ownerId, get leaseToken() { return leaseToken; } };
    const providers = createStandaloneProviderRegistry(config);
    await providers.start((providerConfig, message) => {
      // Don't prompt OpenCode once the lease is lost — a successor daemon owns the workspace.
      if (!leaseActive) return Promise.resolve();
      return runtime.handleMessage(providers.get(providerConfig.id)!.provider, providerConfig, message);
    });
    let maintenanceRunning = false;
    let nextRetentionAt = 0;
    const maintenanceRunner = setInterval(() => {
      if (maintenanceRunning || !leaseActive) return;
      maintenanceRunning = true;
      void (async () => {
        await runtime.runDueJobs(ownerId, { lease: leaseRef, isActive: () => leaseActive });
        const now = Date.now();
        if (now < nextRetentionAt) return;
        const result = await runStandaloneGatewayRetention({
          repository,
          config,
          lease: { leaseId: daemonLeaseId, ownerId, leaseToken },
        });
        if (!result) {
          throw new Error("Standalone Gateway retention skipped because the daemon lease is not active.");
        }
        nextRetentionAt = Date.now() + retentionIntervalMs;
      })().catch((error: unknown) => {
        process.stderr.write(`Standalone Gateway maintenance runner failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }).finally(() => {
        maintenanceRunning = false;
      });
    }, maintenanceIntervalMs);
    const server = createStandaloneGatewayServer({ config, repository, opencode, providers });
    await server.listen();
    process.stdout.write(`Open Cowork Standalone Gateway listening on ${server.url() || `${config.server.host}:${config.server.port}`}\n`);
    const shutdown = async () => {
      clearInterval(leaseRenewal);
      clearInterval(maintenanceRunner);
      await server.close().catch(() => undefined);
      await providers.stop().catch(() => undefined);
      await repository.releaseDaemonLease({
        leaseId: daemonLeaseId,
        ownerId,
        leaseToken,
      }).catch(() => undefined);
      await repository.close?.().catch(() => undefined);
    };
    process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
    process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
  } else {
    process.stderr.write(`Unknown standalone gateway command ${command}. Use serve, doctor, or smoke.\n`);
    process.exitCode = 1;
  }
}

// Single store-construction choke point: "memory" uses the in-process repository (dev/embedded),
// "postgres" (default) uses the durable Postgres adapter. The rest of the daemon depends only on
// the StandaloneGatewayRepository interface, so nothing else changes.
async function createStandaloneGatewayRepository(config: StandaloneGatewayConfig): Promise<StandaloneGatewayRepository> {
  if (config.store === "memory") return new InMemoryStandaloneGatewayRepository();
  return createStandaloneGatewayPostgresRepository(config.database);
}

async function createMigratedRepository(config: StandaloneGatewayConfig): Promise<StandaloneGatewayRepository> {
  const repository = await createStandaloneGatewayRepository(config);
  await repository.migrate();
  return repository;
}

function skippedDoctorRepository(
  reason: string,
): Pick<StandaloneGatewayRepository, "readiness"> & { close?: StandaloneGatewayRepository["close"] } {
  return {
    readiness: async () => ({
      ok: false,
      detail: `Postgres readiness skipped because ${reason}`,
    }),
    close: undefined,
  };
}

function parseArgs(argv: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith("--")) throw new Error(`Unexpected argument ${key || ""}.`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}.`);
    parsed[key.slice(2)] = value;
    index += 1;
  }
  return parsed;
}

function requiredArg(args: Record<string, string>, key: string): string {
  const value = args[key]?.trim();
  if (!value) throw new Error(`Missing required --${key}.`);
  return value;
}
