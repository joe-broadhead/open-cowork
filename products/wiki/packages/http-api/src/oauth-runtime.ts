import {
  openWikiRuntimeModeFromEnvOrProfile,
  openWikiRuntimeModeRequiresHostedStores,
  type OpenWikiAuthOAuthConfig,
  type OpenWikiRuntimeMode,
} from "@openwiki/core";
import { migratePostgresRuntime, postgresRuntimeConfigured, readPostgresOAuthState, updatePostgresOAuthState } from "@openwiki/postgres-runtime";
import { readConfig } from "@openwiki/repo";
import type { OAuthStateBackend } from "./oauth-consent.ts";
import { readOAuthState, updateOAuthState, type OAuthState } from "./oauth-state.ts";
import type { HttpRouteResult } from "./types.ts";

export interface OAuthRuntime {
  enabled: boolean;
  issuer?: string;
  config?: OpenWikiAuthOAuthConfig;
  runtimeMode?: OpenWikiRuntimeMode;
  stateBackend?: OAuthStateBackend;
}

export async function oauthReady(
  root: string,
): Promise<{ issuer: string; config: OpenWikiAuthOAuthConfig; stateBackend: OAuthStateBackend; failure?: never } | { failure: HttpRouteResult }> {
  const runtime = await oauthRuntime(root);
  if (!runtime.enabled || runtime.config === undefined) {
    return { failure: oauthError(404, "not_found", "OAuth is not enabled for this OpenWiki workspace") };
  }
  if (runtime.issuer === undefined) {
    return { failure: oauthError(503, "server_error", "OAuth requires auth.oauth.issuer or OPENWIKI_PUBLIC_ORIGIN") };
  }
  const backendFailure = oauthStateBackendFailure(runtime);
  if (backendFailure !== undefined) {
    return { failure: backendFailure };
  }
  await ensureOAuthPostgresState(runtime);
  return { issuer: runtime.issuer, config: runtime.config, stateBackend: runtime.stateBackend ?? "file" };
}

export async function oauthRuntime(root: string): Promise<OAuthRuntime> {
  const config = await readConfig(root);
  const oauth = config.auth?.oauth;
  const enabled = oauth?.enabled === true || envBooleanEnabled(process.env.OPENWIKI_OAUTH_ENABLED);
  if (!enabled) {
    return { enabled: false };
  }
  const issuerInput = oauth?.issuer ?? process.env.OPENWIKI_OAUTH_ISSUER ?? process.env.OPENWIKI_PUBLIC_ORIGIN;
  const issuer = normalizeIssuer(issuerInput);
  const runtimeMode = openWikiRuntimeModeFromEnvOrProfile(process.env, config.runtime?.profile);
  const stateBackend = oauthStateBackend(config.runtime?.controls?.operational_state?.backend);
  return {
    enabled: true,
    ...(issuer === undefined ? {} : { issuer }),
    config: oauth ?? { enabled: true },
    runtimeMode,
    stateBackend,
  };
}

export async function readOAuthStateForRuntime(root: string, runtime?: OAuthRuntime): Promise<OAuthState> {
  const resolved = runtime ?? await oauthRuntime(root);
  if (resolved.stateBackend === "postgres") {
    await ensureOAuthPostgresState(resolved);
    return readPostgresOAuthState({ root, pooled: true });
  }
  return readOAuthState(root);
}

export async function updateOAuthStateForRuntime<T>(
  root: string,
  ready: { stateBackend: OAuthStateBackend } | undefined,
  update: (state: OAuthState) => T | Promise<T>,
): Promise<T> {
  const stateBackend = ready?.stateBackend ?? (await oauthRuntime(root)).stateBackend ?? "file";
  if (stateBackend === "postgres") {
    await ensureOAuthPostgresState({ enabled: true, stateBackend: "postgres" });
    return updatePostgresOAuthState({ root, pooled: true }, update);
  }
  return updateOAuthState(root, update);
}

export function oauthStateBackendFailure(runtime: OAuthRuntime): HttpRouteResult | undefined {
  const stateBackend = runtime.stateBackend ?? "file";
  if (stateBackend === "postgres" && !postgresRuntimeConfigured()) {
    return oauthError(503, "server_error", "OAuth Postgres state requires OPENWIKI_DATABASE_URL or DATABASE_URL");
  }
  if (
    stateBackend === "file" &&
    runtime.runtimeMode !== undefined &&
    openWikiRuntimeModeRequiresHostedStores(runtime.runtimeMode) &&
    !issuerIsLoopback(runtime.issuer)
  ) {
    return oauthError(503, "server_error", "Hosted OAuth requires OPENWIKI_OAUTH_STATE_BACKEND=postgres or OPENWIKI_OPERATIONAL_STATE_BACKEND=postgres");
  }
  return undefined;
}

async function ensureOAuthPostgresState(runtime: OAuthRuntime): Promise<void> {
  if (runtime.stateBackend !== "postgres" || process.env.OPENWIKI_POSTGRES_MIGRATE === "0") {
    return;
  }
  await migratePostgresRuntime();
}

function oauthStateBackend(configuredOperationalBackend: string | undefined): OAuthStateBackend {
  const explicit = process.env.OPENWIKI_OAUTH_STATE_BACKEND?.trim().toLowerCase();
  if (explicit === "postgres") {
    return "postgres";
  }
  if (explicit === "file" || explicit === "local") {
    return "file";
  }
  const operational = process.env.OPENWIKI_OPERATIONAL_STATE_BACKEND?.trim().toLowerCase() || configuredOperationalBackend;
  return operational === "postgres" ? "postgres" : "file";
}

function issuerIsLoopback(issuer: string | undefined): boolean {
  if (issuer === undefined) {
    return false;
  }
  try {
    const url = new URL(issuer);
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1");
  } catch {
    return false;
  }
}

function envBooleanEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function normalizeIssuer(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && !(url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1"))) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function oauthError(status: number, code: string, message: string): HttpRouteResult {
  return { status, body: { error: code, error_description: message } };
}
