import type { OpenWikiAuthServiceAccount, OpenWikiAuthServiceAccountToken, OpenWikiConfig } from "@openwiki/core";
import { openWikiRuntimeModeFromEnvOrProfile } from "@openwiki/core";
import {
  issuerIsLoopback,
  oauthFileStateUnsafeReason,
  resolveOAuthStateBackend,
} from "@openwiki/http-api";
import { postgresRuntimeConfigured } from "@openwiki/postgres-runtime";
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

/**
 * Doctor / deploy-preflight check for file-backed OAuth under multi-replica or
 * hosted profiles (wiki audit P2-5 / JOE-979).
 */
export function oauthStateDiagnostic(
  config: OpenWikiConfig | undefined | Partial<OpenWikiConfig>,
  env: NodeJS.ProcessEnv = process.env,
): DiagnosticCheck {
  const oauthEnabled =
    config?.auth?.oauth?.enabled === true || envBooleanEnabled(env.OPENWIKI_OAUTH_ENABLED);
  if (!oauthEnabled) {
    return {
      name: "oauth-state",
      status: "skip",
      message: "OAuth is not enabled; file vs Postgres OAuth state does not apply.",
    };
  }

  const stateBackend = resolveOAuthStateBackend(env, config?.runtime?.controls?.operational_state?.backend);
  const runtimeMode = openWikiRuntimeModeFromEnvOrProfile(env, config?.runtime?.profile);
  const issuerInput = config?.auth?.oauth?.issuer ?? env.OPENWIKI_OAUTH_ISSUER ?? env.OPENWIKI_PUBLIC_ORIGIN;
  const issuer = typeof issuerInput === "string" ? issuerInput.trim() : undefined;
  const explicitOauthBackend = env.OPENWIKI_OAUTH_STATE_BACKEND?.trim().toLowerCase();

  if (stateBackend === "postgres") {
    if (!postgresRuntimeConfigured(env)) {
      return {
        name: "oauth-state",
        status: "fail",
        message: "OAuth Postgres state requires OPENWIKI_DATABASE_URL or DATABASE_URL.",
        details: { state_backend: stateBackend, source: explicitOauthBackend ? "OPENWIKI_OAUTH_STATE_BACKEND" : "operational_state" },
      };
    }
    return {
      name: "oauth-state",
      status: "pass",
      message: "OAuth uses shared Postgres state suitable for multi-replica hosted clients.",
      details: { state_backend: stateBackend, runtime_mode: runtimeMode },
    };
  }

  const unsafe = oauthFileStateUnsafeReason({
    stateBackend: "file",
    runtimeMode,
    ...(issuer === undefined ? {} : { issuer }),
    env,
  });
  if (unsafe !== undefined) {
    return {
      name: "oauth-state",
      status: "fail",
      message: unsafe,
      details: {
        state_backend: "file",
        runtime_mode: runtimeMode,
        issuer,
        next_step:
          "Set OPENWIKI_OAUTH_STATE_BACKEND=postgres (or OPENWIKI_OPERATIONAL_STATE_BACKEND=postgres) with DATABASE_URL before multi-replica or hosted HTTPS OAuth.",
      },
    };
  }

  // Match runtime: loopback issuers may use file state even under hosted mode.
  if (issuerIsLoopback(issuer)) {
    return {
      name: "oauth-state",
      status: "pass",
      message: "File-backed OAuth state is acceptable for single-process loopback clients.",
      details: { state_backend: "file", runtime_mode: runtimeMode, issuer },
    };
  }

  // Multi-replica without a resolvable loopback issuer: fail even if runtime mode is team.
  if (multiReplicaSignal(env)) {
    return {
      name: "oauth-state",
      status: "fail",
      message:
        "File-backed OAuth state is single-node only. Configure Postgres OAuth/operational state before multi-replica OAuth.",
      details: { state_backend: "file", runtime_mode: runtimeMode, issuer },
    };
  }

  // Non-loopback issuer with file state on a single-node profile: warn before scaling.
  if (issuer !== undefined && issuer.length > 0) {
    try {
      const url = new URL(issuer);
      const loopbackHost =
        url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
      if (!loopbackHost) {
        return {
          name: "oauth-state",
          status: "warn",
          message:
            "OAuth uses file-backed state. This is only safe on a single process; set Postgres OAuth state before adding web replicas.",
          details: { state_backend: "file", issuer },
        };
      }
    } catch {
      // fall through
    }
  }

  return {
    name: "oauth-state",
    status: "pass",
    message: "File-backed OAuth state is acceptable for single-process loopback/local clients.",
    details: { state_backend: "file", runtime_mode: runtimeMode },
  };
}

function multiReplicaSignal(env: NodeJS.ProcessEnv): boolean {
  const raw = env.OPENWIKI_WEB_REPLICAS?.trim() || env.WEB_REPLICAS?.trim();
  if (raw === undefined || raw.length === 0) {
    return false;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 1;
}

function envBooleanEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
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
