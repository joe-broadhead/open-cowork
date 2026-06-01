import { standaloneGatewaySchemaContainsProductionTables } from "./schema.js";
import type { StandaloneOpenCodeAdapter } from "./opencode.js";
import type { StandaloneGatewayRepository } from "./repository.js";
import type { StandaloneGatewayConfig } from "./types.js";

export interface StandaloneDoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export async function runStandaloneGatewayDoctor(input: {
  config: StandaloneGatewayConfig;
  repository: StandaloneGatewayRepository | Pick<StandaloneGatewayRepository, "readiness">;
  opencode: StandaloneOpenCodeAdapter;
}): Promise<{ ok: boolean; checks: StandaloneDoctorCheck[] }> {
  const repository = await input.repository.readiness();
  const opencode = await input.opencode.health();
  const checks: StandaloneDoctorCheck[] = [{
    name: "product-mode",
    ok: input.config.productMode === "standalone",
    detail: `mode=${input.config.productMode}`,
  }, {
    name: "postgres",
    ok: repository.ok,
    detail: repository.detail,
  }, {
    name: "opencode-private",
    ok: opencode.ok,
    detail: opencode.detail,
  }, {
    name: "schema",
    ok: standaloneGatewaySchemaContainsProductionTables(),
    detail: "standalone gateway schema covers sessions/events/jobs/leases/channel/artifact/team/audit tables",
  }, {
    name: "providers",
    ok: input.config.providers.length > 0,
    detail: `${input.config.providers.length} provider(s) configured`,
  }];
  return { ok: checks.every((check) => check.ok), checks };
}
