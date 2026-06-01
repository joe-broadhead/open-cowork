import { hostname } from "node:os";

import { loadStandaloneGatewayConfig } from "./config.js";
import { runStandaloneGatewayDoctor } from "./doctor.js";
import { createSdkOpenCodeAdapter } from "./opencode.js";
import { createStandaloneGatewayPostgresRepository } from "./postgres-repository.js";
import { createStandaloneProviderRegistry } from "./provider-registry.js";
import { createStandaloneGatewayRuntime } from "./runtime.js";
import { createStandaloneGatewayServer } from "./server.js";
import { runStandaloneGatewaySmoke } from "./smoke.js";

const command = process.argv[2] || "serve";

if (command === "smoke") {
  const result = await runStandaloneGatewaySmoke();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  const config = loadStandaloneGatewayConfig();
  const repository = await createStandaloneGatewayPostgresRepository(config.database.url);
  await repository.migrate();
  const opencode = createSdkOpenCodeAdapter({ baseUrl: config.opencode.baseUrl });

  if (command === "doctor") {
    const result = await runStandaloneGatewayDoctor({ config, repository, opencode });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    await repository.close?.();
    process.exitCode = result.ok ? 0 : 1;
  } else if (command === "serve") {
    const ownerId = `${hostname()}:${process.pid}`;
    const lease = await repository.acquireDaemonLease({
      leaseId: "standalone-gateway:daemon",
      ownerId,
      ttlMs: 30_000,
    });
    if (!lease) {
      throw new Error("Another Standalone Gateway daemon owns the active provider/runtime lease.");
    }
    let leaseToken = lease.leaseToken;
    const leaseRenewal = setInterval(() => {
      void repository.renewDaemonLease({
        leaseId: "standalone-gateway:daemon",
        ownerId,
        leaseToken,
        ttlMs: 30_000,
      }).then((renewed) => {
        if (!renewed) throw new Error("Lost Standalone Gateway daemon lease.");
        leaseToken = renewed.leaseToken;
      }).catch((error: unknown) => {
        process.stderr.write(`Standalone Gateway lease renewal failed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      });
    }, 10_000);

    const runtime = createStandaloneGatewayRuntime({ repository, opencode });
    const providers = createStandaloneProviderRegistry(config);
    await providers.start((providerConfig, message) =>
      runtime.handleMessage(providers.get(providerConfig.id)!.provider, providerConfig, message)
    );
    const jobRunner = setInterval(() => {
      void runtime.runDueJobs(ownerId).catch((error: unknown) => {
        process.stderr.write(`Standalone Gateway job runner failed: ${error instanceof Error ? error.message : String(error)}\n`);
      });
    }, 5_000);
    const server = createStandaloneGatewayServer({ config, repository, opencode, providers });
    await server.listen();
    process.stdout.write(`Open Cowork Standalone Gateway listening on ${server.url() || `${config.server.host}:${config.server.port}`}\n`);
    const shutdown = async () => {
      clearInterval(leaseRenewal);
      clearInterval(jobRunner);
      await server.close().catch(() => undefined);
      await providers.stop().catch(() => undefined);
      await repository.releaseDaemonLease({
        leaseId: "standalone-gateway:daemon",
        ownerId,
        leaseToken,
      }).catch(() => undefined);
      await repository.close?.().catch(() => undefined);
    };
    process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
    process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
  } else {
    process.stderr.write(`Unknown standalone gateway command ${command}. Use serve, doctor, or smoke.\n`);
    await repository.close?.();
    process.exitCode = 1;
  }
}
