import type { OpenWikiAuthServiceAccount, OpenWikiAuthServiceAccountToken, OpenWikiConfig } from "@openwiki/core";
import { loadRepository } from "@openwiki/repo";
import type { DiagnosticCheck } from "./commands/doctor.ts";
import { requirementFrom, requirementStatus } from "./commands/doctor.ts";
import type { DeploymentProfileDefinition, DeploymentProfileRequirement } from "./deployment-profiles.ts";

export async function hostedHumanAgentDiagnostics(root: string, profile: DeploymentProfileDefinition): Promise<DiagnosticCheck[]> {
  if (profile.operationalState === "skip" && profile.mcpTokens === "skip") {
    return [];
  }
  try {
    const repo = await loadRepository(root);
    return [
      operationalStateDiagnostic(repo.config, profile.operationalState),
      hostedMcpTokenDiagnostic(repo.config, profile.mcpTokens),
    ];
  } catch (error: unknown) {
    return [
      {
        name: "hosted-human-agent-auth",
        status: "fail",
        message: "Hosted human and agent readiness could not inspect openwiki.json.",
        details: { error: error instanceof Error ? error.message : String(error) },
      },
    ];
  }
}

function operationalStateDiagnostic(
  config: OpenWikiConfig | undefined,
  required: DeploymentProfileRequirement | boolean,
  env: NodeJS.ProcessEnv = process.env,
): DiagnosticCheck {
  const requirement = requirementFrom(required);
  const envBackend = env.OPENWIKI_OPERATIONAL_STATE_BACKEND?.trim().toLowerCase();
  const configBackend = config?.runtime?.controls?.operational_state?.backend;
  const backend = envBackend ?? configBackend;
  const source = envBackend === undefined ? "openwiki.json" : "environment";

  if (backend !== undefined && backend !== "memory" && backend !== "postgres") {
    return {
      name: "operational-state",
      status: "fail",
      message: "OPENWIKI_OPERATIONAL_STATE_BACKEND must be memory or postgres.",
      details: { backend, source },
    };
  }
  if (backend === "postgres") {
    return {
      name: "operational-state",
      status: "pass",
      message: "Postgres operational state is configured for shared MCP sessions and rate-limit windows.",
      details: { backend, source },
    };
  }
  if (backend === "memory") {
    return {
      name: "operational-state",
      status: requirementStatus(requirement),
      message:
        requirement === "required"
          ? "This hosted profile requires OPENWIKI_OPERATIONAL_STATE_BACKEND=postgres for multi-replica HTTP MCP sessions and rate limits."
          : requirement === "warn"
            ? "Use OPENWIKI_OPERATIONAL_STATE_BACKEND=postgres before running multiple hosted HTTP replicas."
            : "Memory operational state is acceptable for local single-process profiles.",
      details: { backend, source },
    };
  }
  return {
    name: "operational-state",
    status: requirementStatus(requirement),
    message:
      requirement === "required"
        ? "This hosted profile requires OPENWIKI_OPERATIONAL_STATE_BACKEND=postgres for shared Streamable HTTP MCP sessions and rate limits."
        : requirement === "warn"
          ? "Configure OPENWIKI_OPERATIONAL_STATE_BACKEND=postgres before scaling hosted HTTP MCP beyond one replica."
          : "Operational state backend is optional for this profile.",
  };
}

function hostedMcpTokenDiagnostic(
  config: OpenWikiConfig | undefined,
  required: DeploymentProfileRequirement | boolean,
  now: Date = new Date(),
): DiagnosticCheck {
  const requirement = requirementFrom(required);
  const accounts = config?.auth?.service_accounts ?? [];
  const activeAccounts = accounts
    .map((account) => ({ account, activeTokenCount: activeServiceAccountTokenCount(account, now) }))
    .filter((entry) => entry.activeTokenCount > 0);
  const activeTokenCount = activeAccounts.reduce((sum, entry) => sum + entry.activeTokenCount, 0);
  if (activeTokenCount > 0) {
    return {
      name: "hosted-mcp-tokens",
      status: "pass",
      message: `Hosted HTTP MCP has ${activeTokenCount} active service-account bearer token${activeTokenCount === 1 ? "" : "s"}.`,
      details: {
        service_account_count: activeAccounts.length,
        token_count: activeTokenCount,
        service_account_ids: activeAccounts.map((entry) => entry.account.id),
      },
    };
  }
  return {
    name: "hosted-mcp-tokens",
    status: requirementStatus(requirement),
    message:
      requirement === "required"
        ? "This hosted profile requires at least one scoped service-account bearer token for HTTP MCP agents."
        : requirement === "warn"
          ? "Create scoped service-account bearer tokens before enabling hosted HTTP MCP agents."
          : "Hosted HTTP MCP service-account tokens are optional for this profile.",
    details: {
      service_account_count: accounts.length,
      next_step: "openwiki --root <wiki> auth token create --profile proposal-agent --id service:proposal-agent --expires-in-days 30; use --profile inbox-submitter or inbox-curator for hosted inbox agents",
    },
  };
}

function activeServiceAccountTokenCount(account: OpenWikiAuthServiceAccount, now: Date): number {
  if (!timestampIsCurrent(account.expires_at, now)) {
    return 0;
  }
  const activeStructuredTokens = (account.tokens ?? []).filter((token) => activeStructuredToken(token, now)).length;
  const legacyTokens = account.token_hashes?.length ?? 0;
  return activeStructuredTokens + legacyTokens;
}

function activeStructuredToken(token: OpenWikiAuthServiceAccountToken, now: Date): boolean {
  return token.revoked_at === undefined && timestampIsCurrent(token.expires_at, now);
}

function timestampIsCurrent(value: string | undefined, now: Date): boolean {
  if (value === undefined) {
    return true;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > now.getTime();
}
