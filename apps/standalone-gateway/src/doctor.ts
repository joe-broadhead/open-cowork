import type {
  RuntimeDoctorCheck,
  RuntimeReadinessTimelineEntry,
} from "@open-cowork/shared";
import { standaloneGatewaySchemaContainsProductionTables } from "./schema.js";
import type { StandaloneOpenCodeAdapter } from "./opencode.js";
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

const SECRET_TEXT_PATTERNS = [
  /\bAuthorization:\s*(?:Bearer|Basic)\s+\S+/gi,
  /\b(?:token|secret|password|api[_-]?key)\s*[:=]\s*['"]?[A-Za-z0-9+/=_-]{8,}['"]?/gi,
  /:\/\/([^:\s/@]+):([^@\s/]+)@/g,
  /\b(?:sk|ghp|xoxb|occ|ocgw)-[A-Za-z0-9_-]{8,}\b/g,
];

function nowIso() {
  return new Date().toISOString();
}

function redact(value: string) {
  return SECRET_TEXT_PATTERNS.reduce((text, pattern) => text.replace(pattern, (match, user) => {
    if (typeof user === "string" && match.includes("://")) return `://${user}:[redacted]@`;
    return "[redacted]";
  }), value).slice(0, 2000);
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
  const schemaOk = standaloneGatewaySchemaContainsProductionTables();
  const productModeOk = input.config.productMode === "standalone";
  const providersOk = input.config.providers.length > 0;
  const checks: StandaloneDoctorCheck[] = [
    legacyCheck("product-mode", productModeOk, `mode=${input.config.productMode}`),
    legacyCheck("postgres", repository.ok, repository.detail),
    legacyCheck("opencode-private", opencode.ok, opencode.detail),
    legacyCheck("schema", schemaOk, "standalone gateway schema covers sessions/events/jobs/leases/channel/artifact/team/audit tables"),
    legacyCheck("providers", providersOk, `${input.config.providers.length} provider(s) configured`),
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
