import type {
  RuntimeDoctorCheck,
  RuntimeReadinessTimelineEntry,
} from "@open-cowork/shared";
import { standaloneGatewaySchemaContainsProductionTables } from "./schema.js";
import type { StandaloneOpenCodeAdapter } from "./opencode.js";
import { redactSecretText } from "./redaction.js";
import type { StandaloneGatewayRepository } from "./repository.js";
import type { StandaloneGatewayConfig } from "./types.js";

export interface StandaloneDoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface StandaloneGatewayDoctorReport {
  ok: boolean;
  productMode: "standalone";
  generatedAt: string;
  checks: StandaloneDoctorCheck[];
  doctorChecks: RuntimeDoctorCheck[];
  readinessTimeline: RuntimeReadinessTimelineEntry[];
  runtimeStatus: {
    authority: "standalone-gateway";
    opencode: "private";
    providersConfigured: number;
    repository: "postgres";
    workflowService: "not-applicable";
  };
  workspaceAuthority: {
    sessions: "standalone_gateway_repository";
    approvals: "gateway_control_plane";
    questions: "gateway_control_plane";
    audit: "standalone_gateway_repository";
  };
  redacted: true;
}

function nowIso() {
  return new Date().toISOString();
}

function redact(value: string) {
  return redactSecretText(value);
}

function timeline(
  phase: RuntimeReadinessTimelineEntry["phase"],
  status: RuntimeReadinessTimelineEntry["status"],
  code: string,
  message: string,
): RuntimeReadinessTimelineEntry {
  return {
    phase,
    status,
    code,
    message: redact(message),
    timestamp: nowIso(),
  };
}

function doctorCheck(input: {
  code: string;
  status: RuntimeDoctorCheck["status"];
  message: string;
  remediation?: string;
  severity?: RuntimeDoctorCheck["severity"];
  evidence?: RuntimeDoctorCheck["evidence"];
}): RuntimeDoctorCheck {
  return {
    code: input.code,
    status: input.status,
    severity: input.severity || (input.status === "fail" ? "error" : "info"),
    message: redact(input.message),
    remediation: input.remediation ? redact(input.remediation) : undefined,
    evidence: input.evidence,
    updatedAt: nowIso(),
  };
}

function legacyCheck(name: string, ok: boolean, detail: string): StandaloneDoctorCheck {
  return { name, ok, detail: redact(detail) };
}

export async function runStandaloneGatewayDoctor(input: {
  config: StandaloneGatewayConfig;
  repository: StandaloneGatewayRepository | Pick<StandaloneGatewayRepository, "readiness">;
  opencode: StandaloneOpenCodeAdapter;
}): Promise<StandaloneGatewayDoctorReport> {
  const repository = await input.repository.readiness();
  const opencode = await input.opencode.health();
  const configuredProviderIds = input.config.providers.filter((provider) => provider.enabled).map((provider) => provider.id);
  const identityAuthorization = await identityAuthorizationSummary(input.repository, repository.ok, configuredProviderIds);
  const databaseTls = databaseTlsSummary(input.config);
  const retention = retentionSummary(input.config);
  const schemaOk = standaloneGatewaySchemaContainsProductionTables();
  const productModeOk = input.config.productMode === "standalone";
  const providersOk = input.config.providers.length > 0;
  const identitiesOk = identityAuthorization.summary.promptCapable > 0;
  const checks: StandaloneDoctorCheck[] = [
    legacyCheck("product-mode", productModeOk, `mode=${input.config.productMode}`),
    legacyCheck("postgres", repository.ok, repository.detail),
    legacyCheck("postgres-tls", databaseTls.ok, databaseTls.detail),
    legacyCheck("opencode-private", opencode.ok, opencode.detail),
    legacyCheck("schema", schemaOk, "standalone gateway schema covers sessions/events/jobs/leases/channel/artifact/team/audit tables"),
    legacyCheck("providers", providersOk, `${input.config.providers.length} provider(s) configured`),
    legacyCheck("identity-authorization", identitiesOk, identityAuthorization.detail),
    legacyCheck("retention", retention.ok, retention.detail),
  ];
  const doctorChecks = [
    doctorCheck({
      code: "standalone_gateway.product_mode",
      status: productModeOk ? "pass" : "fail",
      message: `Standalone Gateway product mode is ${input.config.productMode}.`,
      remediation: "Set gateway.productMode to standalone for the Standalone Gateway appliance.",
      evidence: { expected: "standalone", actual: input.config.productMode },
    }),
    doctorCheck({
      code: "standalone_gateway.repository.readiness",
      status: repository.ok ? "pass" : "fail",
      message: repository.detail,
      remediation: "Verify Postgres connectivity, migrations, and Standalone Gateway database credentials.",
      evidence: { repository: "postgres" },
    }),
    doctorCheck({
      code: "standalone_gateway.repository.tls",
      status: databaseTls.ok ? "pass" : "fail",
      message: databaseTls.detail,
      remediation: "Enable OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_SSL=true and keep certificate verification enabled for team or enterprise deployments.",
      evidence: databaseTls.evidence,
    }),
    doctorCheck({
      code: "standalone_gateway.opencode.health",
      status: opencode.ok ? "pass" : "fail",
      message: opencode.detail,
      remediation: "Verify the private OpenCode endpoint is reachable from the Gateway host and remains loopback/private.",
      evidence: { runtimeAuthority: "private-opencode" },
    }),
    doctorCheck({
      code: "standalone_gateway.schema.production_tables",
      status: schemaOk ? "pass" : "fail",
      message: "Standalone Gateway schema includes production session, event, job, lease, channel, artifact, team, and audit tables.",
      remediation: "Run the Standalone Gateway migration before serving traffic.",
    }),
    doctorCheck({
      code: "standalone_gateway.providers.configured",
      status: providersOk ? "pass" : "fail",
      message: `${input.config.providers.length} provider(s) configured.`,
      remediation: "Configure at least one channel provider for Standalone Gateway traffic.",
      evidence: { providerCount: input.config.providers.length },
    }),
    doctorCheck({
      code: "standalone_gateway.identity_authorization",
      status: identitiesOk ? "pass" : "fail",
      message: identityAuthorization.detail,
      remediation: "Bootstrap at least one owner, admin, or member identity before accepting Standalone Gateway channel traffic.",
      evidence: {
        total: identityAuthorization.summary.total,
        active: identityAuthorization.summary.active,
        promptCapable: identityAuthorization.summary.promptCapable,
      },
    }),
    doctorCheck({
      code: "standalone_gateway.retention.policy",
      status: retention.ok ? "pass" : "fail",
      message: retention.detail,
      remediation: "Set positive retention windows for sessions, artifacts, audit rows, and completed jobs.",
      evidence: retention.evidence,
    }),
  ];
  const ok = doctorChecks.every((check) => check.status === "pass" || check.status === "skipped");
  return {
    ok,
    productMode: "standalone",
    generatedAt: nowIso(),
    checks,
    doctorChecks,
    readinessTimeline: [
      timeline("environment", "passed", "standalone_gateway.environment", "Standalone Gateway environment loaded."),
      timeline("storage-migration", repository.ok ? "passed" : "failed", "standalone_gateway.repository.readiness", repository.detail),
      timeline("health-auth", opencode.ok ? "passed" : "failed", "standalone_gateway.opencode.health", opencode.detail),
      timeline("cloud-gateway-connector", providersOk ? "passed" : "failed", "standalone_gateway.providers.configured", `${input.config.providers.length} provider(s) configured.`),
      timeline("config-build", identitiesOk ? "passed" : "failed", "standalone_gateway.identity_authorization", identityAuthorization.detail),
      timeline(ok ? "ready" : "error", ok ? "passed" : "failed", ok ? "standalone_gateway.ready" : "standalone_gateway.not_ready", ok ? "Standalone Gateway doctor passed." : "Standalone Gateway doctor failed."),
    ],
    runtimeStatus: {
      authority: "standalone-gateway",
      opencode: "private",
      providersConfigured: input.config.providers.length,
      repository: "postgres",
      workflowService: "not-applicable",
    },
    workspaceAuthority: {
      sessions: "standalone_gateway_repository",
      approvals: "gateway_control_plane",
      questions: "gateway_control_plane",
      audit: "standalone_gateway_repository",
    },
    redacted: true,
  };
}

function databaseTlsSummary(config: StandaloneGatewayConfig): {
  ok: boolean;
  detail: string;
  evidence: RuntimeDoctorCheck["evidence"];
} {
  const productionMode = config.deploymentMode === "team" || config.deploymentMode === "enterprise";
  const evidence = {
    deploymentMode: config.deploymentMode,
    enabled: config.database.ssl,
    rejectUnauthorized: config.database.ssl ? config.database.sslRejectUnauthorized : null,
    caConfigured: Boolean(config.database.sslCaPath),
    certConfigured: Boolean(config.database.sslCertPath),
    keyConfigured: Boolean(config.database.sslKeyPath),
  };
  if (!config.database.ssl) {
    return {
      ok: !productionMode,
      detail: productionMode
        ? `Postgres TLS is disabled for ${config.deploymentMode} deployment mode.`
        : "Postgres TLS is disabled for solo/local deployment mode.",
      evidence,
    };
  }
  if (productionMode && !config.database.sslRejectUnauthorized) {
    return {
      ok: false,
      detail: `Postgres TLS certificate verification is disabled for ${config.deploymentMode} deployment mode.`,
      evidence,
    };
  }
  return {
    ok: true,
    detail: config.database.sslRejectUnauthorized
      ? "Postgres TLS is enabled with certificate verification."
      : "Postgres TLS is enabled without certificate verification for solo/local deployment mode.",
    evidence,
  };
}

function retentionSummary(config: StandaloneGatewayConfig): {
  ok: boolean;
  detail: string;
  evidence: RuntimeDoctorCheck["evidence"];
} {
  const windows = config.retention;
  const ok = windows.sessionDays > 0 && windows.artifactDays > 0 && windows.auditDays > 0 && windows.jobDays > 0;
  return {
    ok,
    detail: `Retention is lease-gated with sessions=${windows.sessionDays}d artifacts=${windows.artifactDays}d audit=${windows.auditDays}d jobs=${windows.jobDays}d.`,
    evidence: {
      leaseGated: true,
      sessionDays: windows.sessionDays,
      artifactDays: windows.artifactDays,
      auditDays: windows.auditDays,
      jobDays: windows.jobDays,
    },
  };
}

async function identityAuthorizationSummary(
  repository: StandaloneGatewayRepository | Pick<StandaloneGatewayRepository, "readiness">,
  repositoryOk: boolean,
  providers: readonly string[],
): Promise<{
  summary: { total: number; active: number; promptCapable: number };
  detail: string;
}> {
  const empty = { total: 0, active: 0, promptCapable: 0 };
  if (!repositoryOk) {
    return {
      summary: empty,
      detail: "Identity authorization could not be checked because the repository is not ready.",
    };
  }
  if (!("identityAuthorizationSummary" in repository)) {
    return {
      summary: empty,
      detail: "Identity authorization summary is unavailable for this repository.",
    };
  }
  try {
    const summary = await repository.identityAuthorizationSummary({ providers });
    return {
      summary,
      detail: `${summary.promptCapable} prompt-capable active identity/identities configured`,
    };
  } catch (error) {
    return {
      summary: empty,
      detail: `Identity authorization check failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
