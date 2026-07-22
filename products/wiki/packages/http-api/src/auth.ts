import { firstHeader } from "./http-headers.ts";
import type { HttpPolicyOptions, HttpRouteResult } from "./types.ts";
import { OpenWikiPolicyDeniedError, openWikiRuntimeModeFromEnvOrProfile, openWikiRuntimeModeRequiresHostedStores, type ProposalRecord } from "@openwiki/core";
import { assertAuthorized, assertPathAuthorized, assertReviewAuthorized, type OpenWikiOperation, type OpenWikiRole, type OpenWikiScope, type PolicyContext, operationNames, parseRole, parseScopes, resolveServiceAccountToken, scopesForRole } from "@openwiki/policy";
import { postgresRuntimeHealthEnabled, postgresRuntimeReadEnabled, postgresRuntimeSearchEnabled, type PostgresRuntimeRecordEntry } from "@openwiki/postgres-runtime";
import { loadRepository, readConfig } from "@openwiki/repo";
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { resolveOAuthBearerToken } from "./oauth.ts";

export function httpCanSeeUnfilteredIndex(policy: HttpPolicyOptions): boolean {
  const context = httpPolicyContext(policy);
  return context.bounds === undefined && (context.scopes.includes("wiki:admin") || context.role === "admin");
}

export function httpCanReadPostgresRecordEntry(policy: HttpPolicyOptions, entry: Pick<PostgresRuntimeRecordEntry<unknown>, "sensitivity">): boolean {
  const context = httpPolicyContext(policy);
  if (httpCanSeeUnfilteredIndex(policy)) {
    return true;
  }
  if (context.bounds !== undefined) {
    return false;
  }
  return (context.scopes.includes("wiki:read") || context.scopes.includes("wiki:admin")) && entry.sensitivity === "public";
}

export async function authorizeHttpPath(
  root: string,
  operation: OpenWikiOperation,
  policy: HttpPolicyOptions,
  repoPath: string,
): Promise<HttpRouteResult | undefined> {
  const repo = await loadRepository(root);
  try {
    assertPathAuthorized(operation, httpPolicyContext(policy), repo.policy, repoPath);
    return undefined;
  } catch (error) {
    if (error instanceof Error) {
      return forbidden(error.message);
    }
    throw error;
  }
}

export async function authorizeHttpReview(
  root: string,
  policy: HttpPolicyOptions,
  proposal: ProposalRecord,
): Promise<HttpRouteResult | undefined> {
  const repo = await loadRepository(root);
  try {
    assertReviewAuthorized(httpPolicyContext(policy), repo.policy, proposal);
    return undefined;
  } catch (error) {
    if (error instanceof Error) {
      return forbidden(error.message);
    }
    throw error;
  }
}

export function forbidden(message: string): HttpRouteResult {
  return {
    status: 403,
    body: {
      error: {
        code: "forbidden",
        message,
      },
    },
  };
}

export function badRequest(message: string): HttpRouteResult {
  return {
    status: 400,
    body: {
      error: {
        code: "bad_request",
        message,
      },
    },
  };
}

export function unauthorized(message: string): HttpRouteResult {
  return {
    status: 401,
    headers: { "www-authenticate": "Bearer" },
    body: {
      error: {
        code: "unauthorized",
        message,
      },
    },
  };
}

export function policyDeniedHttpResult(error: unknown): HttpRouteResult {
  if (error instanceof OpenWikiPolicyDeniedError) {
    return {
      status: error.status,
      body: { error: { code: "forbidden", message: error.message } },
    };
  }
  throw error;
}

export function httpRouteErrorMessage(result: HttpRouteResult): string {
  const body = result.body;
  if (typeof body !== "object" || body === null || !("error" in body)) {
    return "OpenWiki policy denied the requested operation";
  }
  const error = body.error;
  if (typeof error !== "object" || error === null || !("message" in error)) {
    return "OpenWiki policy denied the requested operation";
  }
  const message = error.message;
  return typeof message === "string" && message.length > 0 ? message : "OpenWiki policy denied the requested operation";
}

export function httpPolicyContext(policy: HttpPolicyOptions): PolicyContext {
  const scopes = policy.scopes ?? (policy.role === undefined ? scopesForRole("viewer") : scopesForRole(policy.role));
  return {
    scopes,
    ...(policy.actorId === undefined ? {} : { actorId: policy.actorId }),
    ...(policy.role === undefined ? {} : { role: policy.role }),
    ...(policy.principals === undefined ? {} : { principals: policy.principals }),
    ...(policy.bounds === undefined ? {} : { bounds: policy.bounds }),
  };
}

export function permissionPreviewContextFromUrl(url: URL): { actorId?: string; scopes: OpenWikiScope[]; role?: OpenWikiRole; principals?: string[] } {
  const role = parseRole(url.searchParams.get("role") ?? undefined);
  const scopes = permissionPreviewScopesFromUrl(url, role);
  const principals = permissionPreviewPrincipalsFromUrl(url);
  return {
    scopes,
    ...(optionalQueryString(url, "actor_id", "actor") === undefined ? {} : { actorId: optionalQueryString(url, "actor_id", "actor")! }),
    ...(role === undefined ? {} : { role }),
    ...(principals.length === 0 ? {} : { principals }),
  };
}

function permissionPreviewScopesFromUrl(url: URL, role: OpenWikiRole | undefined): OpenWikiScope[] {
  const values = [
    ...url.searchParams.getAll("scope"),
    ...url.searchParams.getAll("scopes"),
  ].flatMap((value) => value.split(/[,\s]+/));
  const scopes = parseScopes(values.join(","));
  return scopes.length === 0 ? scopesForRole(role ?? "viewer") : scopes;
}

function permissionPreviewPrincipalsFromUrl(url: URL): string[] {
  const principals = [
    ...url.searchParams.getAll("principal"),
    ...url.searchParams.getAll("principals").flatMap((value) => value.split(/[,\s]+/)),
    ...url.searchParams.getAll("group").map((group) => (group.startsWith("group:") ? group : `group:${group}`)),
    ...url.searchParams.getAll("groups").flatMap((value) =>
      value.split(/[,\s]+/).map((group) => (group.startsWith("group:") ? group : `group:${group}`)),
    ),
  ];
  return uniqueQueryValues(principals);
}

export function permissionPreviewPathsFromUrl(url: URL): string[] {
  return uniqueQueryValues([
    ...url.searchParams.getAll("path"),
    ...url.searchParams.getAll("target_path"),
    ...url.searchParams.getAll("target-path"),
  ]);
}

export function permissionPreviewRecordsFromUrl(url: URL): string[] {
  return uniqueQueryValues([
    ...url.searchParams.getAll("record"),
    ...url.searchParams.getAll("record_id"),
    ...url.searchParams.getAll("target"),
    ...url.searchParams.getAll("target_id"),
  ]);
}

export function permissionPreviewOperationsFromUrl(url: URL): OpenWikiOperation[] {
  const names = uniqueQueryValues([
    ...url.searchParams.getAll("operation"),
    ...url.searchParams.getAll("operations").flatMap((value) => value.split(/[,\s]+/)),
  ]);
  if (names.length === 0) {
    return operationNames();
  }
  const allowed = new Set(operationNames());
  return names.map((name) => {
    if (!allowed.has(name as OpenWikiOperation)) {
      throw new Error(`Invalid OpenWiki operation '${name}'`);
    }
    return name as OpenWikiOperation;
  });
}

export function optionalQueryString(url: URL, primary: string, fallback: string): string | undefined {
  const value = url.searchParams.get(primary) ?? url.searchParams.get(fallback);
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function uniqueQueryValues(values: string[]): string[] {
  return values.map((value) => value.trim()).filter((value, index, array) => value.length > 0 && array.indexOf(value) === index);
}

export function authorizeHttp(operation: OpenWikiOperation, policy: HttpPolicyOptions): HttpRouteResult | undefined {
  try {
    assertAuthorized(operation, httpPolicyContext(policy));
    return undefined;
  } catch (error) {
    if (error instanceof Error && error.name === "AuthorizationError") {
      return forbidden(error.message);
    }
    throw error;
  }
}

export async function requireAuthenticatedHttpPolicy(root: string, policy: HttpPolicyOptions): Promise<HttpRouteResult | undefined> {
  if (!await httpRequiresAuthentication(root)) {
    return undefined;
  }
  if (httpPolicyHasAuthenticatedPrincipal(policy)) {
    return undefined;
  }
  return unauthorized("OpenWiki hosted HTTP access requires a service-account token or trusted identity headers");
}

export async function httpRequiresAuthentication(root: string): Promise<boolean> {
  const explicit = booleanFromEnv(process.env.OPENWIKI_REQUIRE_AUTH ?? process.env.OPENWIKI_AUTH_REQUIRED);
  if (explicit !== undefined) {
    return explicit;
  }
  if (process.env.OPENWIKI_PUBLIC_ORIGIN?.trim()) {
    return true;
  }
  if (
    postgresRuntimeHealthEnabled() ||
    postgresRuntimeReadEnabled() ||
    postgresRuntimeSearchEnabled() ||
    process.env.OPENWIKI_QUEUE_BACKEND === "postgres" ||
    process.env.OPENWIKI_OPERATIONAL_STATE_BACKEND === "postgres" ||
    process.env.OPENWIKI_WRITE_COORDINATOR_BACKEND === "postgres"
  ) {
    return true;
  }
  const config = await readConfig(root).catch(() => undefined);
  const mode = openWikiRuntimeModeFromEnvOrProfile(process.env, config?.runtime?.profile);
  return openWikiRuntimeModeRequiresHostedStores(mode);
}

function httpPolicyHasAuthenticatedPrincipal(policy: HttpPolicyOptions): boolean {
  return Boolean(
    policy.actorId !== undefined ||
      (policy.principals !== undefined && policy.principals.length > 0),
  );
}

function booleanFromEnv(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === "") {
    return undefined;
  }
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  throw new Error("OPENWIKI_REQUIRE_AUTH must be true or false");
}

export type ResolveHttpPolicyOptions = {
  /**
   * When true, allow raw bearer scope lists (`wiki:read,wiki:write`) as an auth method.
   * When false, refuse that path (service-account/OAuth still work).
   * When omitted, defaults from remote address + OPENWIKI_ALLOW_SCOPE_TOKEN (JOE-972).
   */
  allowScopeToken?: boolean | undefined;
  /** Client remote address used to decide loopback-only scope-token default. */
  remoteAddress?: string | undefined;
};

/**
 * Scope-tokens are a local/dev convenience: a Bearer value that is only a
 * comma/space-separated scope list elevates scopes without a principal.
 * They must not be accepted from non-loopback clients unless explicitly enabled
 * via OPENWIKI_ALLOW_SCOPE_TOKEN=1 (JOE-972 / wiki audit P2-2).
 */
export function scopeTokenAuthAllowed(options: {
  allowScopeToken?: boolean | undefined;
  remoteAddress?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
} = {}): boolean {
  if (options.allowScopeToken === true) {
    return true;
  }
  if (options.allowScopeToken === false) {
    return false;
  }
  const env = options.env ?? process.env;
  const explicit = optionalBooleanEnv(env.OPENWIKI_ALLOW_SCOPE_TOKEN);
  if (explicit === true) {
    return true;
  }
  if (explicit === false) {
    return false;
  }
  // In-process callers (no socket) keep historical local behavior.
  if (options.remoteAddress === undefined || options.remoteAddress === "") {
    return true;
  }
  return isLoopbackRemoteAddress(options.remoteAddress);
}

export function isLoopbackRemoteAddress(address: string | undefined): boolean {
  if (!address) {
    return false;
  }
  const normalized = address.trim().toLowerCase().replace(/^::ffff:/, "");
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized === "localhost"
  );
}

function optionalBooleanEnv(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === "") {
    return undefined;
  }
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  throw new Error("OPENWIKI_ALLOW_SCOPE_TOKEN must be true or false");
}

export async function resolveHttpPolicy(
  root: string,
  policy: HttpPolicyOptions,
  options: ResolveHttpPolicyOptions = {},
): Promise<HttpPolicyOptions> {
  if (policy.scopes !== undefined || policy.role !== undefined || policy.token === undefined) {
    return policy;
  }
  const tokenScopes = parseScopes(policy.token);
  if (tokenScopes.length > 0) {
    if (!scopeTokenAuthAllowed(options)) {
      // Do not elevate scopes from a raw scope list off-loopback. SA/OAuth paths
      // below still apply if the token is a registered secret (scope parse is
      // usually empty for those). Pure scope-list tokens remain unresolved.
      return policy;
    }
    return { ...policy, scopes: tokenScopes, authMethod: "scope-token" };
  }
  const config = await readConfig(root);
  const serviceAccount = resolveServiceAccountToken(config, policy.token);
  if (serviceAccount) {
    return {
      ...policy,
      scopes: serviceAccount.scopes,
      actorId: serviceAccount.actorId,
      ...optionalPrincipals([...((serviceAccount.principals) ?? []), ...((policy.principals) ?? [])]),
      ...(serviceAccount.role === undefined ? {} : { role: serviceAccount.role }),
      ...(serviceAccount.bounds === undefined ? {} : { bounds: serviceAccount.bounds }),
      authMethod: "service-account",
      serviceAccountId: serviceAccount.serviceAccountId,
    };
  }
  const oauth = await resolveOAuthBearerToken(root, policy.token);
  if (oauth === undefined) {
    return policy;
  }
  return {
    ...policy,
    scopes: oauth.scopes,
    actorId: oauth.actorId,
    ...optionalPrincipals([...((oauth.principals) ?? []), ...((policy.principals) ?? [])]),
    ...(oauth.role === undefined ? {} : { role: oauth.role }),
    ...(oauth.bounds === undefined ? {} : { bounds: oauth.bounds }),
    authMethod: "oauth",
    oauthClientId: oauth.clientId,
    oauthTokenId: oauth.tokenId,
  };
}

export async function policyOptionsFromRequest(root: string, request: IncomingMessage, trustHeaders: boolean): Promise<HttpPolicyOptions> {
  const authorization = firstHeader(request.headers.authorization);
  const bearerToken = authorization?.replace(/^Bearer\s+/i, "");
  const principals = trustHeaders
    ? parsePrincipals(firstHeader(request.headers["x-openwiki-principals"]), firstHeader(request.headers["x-openwiki-groups"]))
    : [];
  if (bearerToken && parseScopes(bearerToken).length === 0) {
    const config = await readConfig(root);
    const serviceAccount = resolveServiceAccountToken(config, bearerToken);
    if (serviceAccount) {
      return {
        scopes: serviceAccount.scopes,
        actorId: serviceAccount.actorId,
        ...(serviceAccount.role === undefined ? {} : { role: serviceAccount.role }),
        ...(serviceAccount.bounds === undefined ? {} : { bounds: serviceAccount.bounds }),
        token: bearerToken,
        ...optionalPrincipals([...((serviceAccount.principals) ?? []), ...principals]),
        authMethod: "service-account",
        serviceAccountId: serviceAccount.serviceAccountId,
      };
    }
    const oauth = await resolveOAuthBearerToken(root, bearerToken);
    if (oauth) {
      return {
        scopes: oauth.scopes,
        actorId: oauth.actorId,
        ...(oauth.role === undefined ? {} : { role: oauth.role }),
        ...(oauth.bounds === undefined ? {} : { bounds: oauth.bounds }),
        token: bearerToken,
        ...optionalPrincipals([...((oauth.principals) ?? []), ...principals]),
        authMethod: "oauth",
        oauthClientId: oauth.clientId,
        oauthTokenId: oauth.tokenId,
      };
    }
  }
  if (!trustHeaders) {
    return {};
  }
  const headerScopes = firstHeader(request.headers["x-openwiki-scopes"]);
  const role = parseRole(firstHeader(request.headers["x-openwiki-role"]));
  const actorId = firstHeader(request.headers["x-openwiki-actor"]);
  const scopes = [
    ...(role === undefined ? [] : scopesForRole(role)),
    ...parseScopes(headerScopes),
    ...parseScopes(bearerToken),
  ];
  return {
    ...(scopes.length === 0 ? {} : { scopes }),
    ...(actorId === undefined ? {} : { actorId }),
    ...(role === undefined ? {} : { role }),
    ...(bearerToken === undefined ? {} : { token: bearerToken }),
    ...(principals.length === 0 ? {} : { principals }),
    authMethod: "trusted-headers",
    trustHeaders: true,
  };
}

export function mergeHttpPolicy(defaultPolicy: HttpPolicyOptions, requestPolicy: HttpPolicyOptions): HttpPolicyOptions {
  return {
    ...(defaultPolicy.scopes === undefined ? {} : { scopes: defaultPolicy.scopes }),
    ...(defaultPolicy.actorId === undefined ? {} : { actorId: defaultPolicy.actorId }),
    ...(defaultPolicy.role === undefined ? {} : { role: defaultPolicy.role }),
    ...(defaultPolicy.token === undefined ? {} : { token: defaultPolicy.token }),
    ...(defaultPolicy.principals === undefined ? {} : { principals: defaultPolicy.principals }),
    ...(defaultPolicy.bounds === undefined ? {} : { bounds: defaultPolicy.bounds }),
    ...(defaultPolicy.authMethod === undefined ? {} : { authMethod: defaultPolicy.authMethod }),
    ...(defaultPolicy.serviceAccountId === undefined ? {} : { serviceAccountId: defaultPolicy.serviceAccountId }),
    ...(defaultPolicy.oauthClientId === undefined ? {} : { oauthClientId: defaultPolicy.oauthClientId }),
    ...(defaultPolicy.oauthTokenId === undefined ? {} : { oauthTokenId: defaultPolicy.oauthTokenId }),
    ...(defaultPolicy.trustHeaders === undefined ? {} : { trustHeaders: defaultPolicy.trustHeaders }),
    ...(defaultPolicy.trustedHeaderSecret === undefined ? {} : { trustedHeaderSecret: defaultPolicy.trustedHeaderSecret }),
    ...(requestPolicy.scopes === undefined ? {} : { scopes: requestPolicy.scopes }),
    ...(requestPolicy.actorId === undefined ? {} : { actorId: requestPolicy.actorId }),
    ...(requestPolicy.role === undefined ? {} : { role: requestPolicy.role }),
    ...(requestPolicy.token === undefined ? {} : { token: requestPolicy.token }),
    ...(requestPolicy.principals === undefined ? {} : { principals: requestPolicy.principals }),
    ...(requestPolicy.bounds === undefined ? {} : { bounds: requestPolicy.bounds }),
    ...(requestPolicy.authMethod === undefined ? {} : { authMethod: requestPolicy.authMethod }),
    ...(requestPolicy.serviceAccountId === undefined ? {} : { serviceAccountId: requestPolicy.serviceAccountId }),
    ...(requestPolicy.oauthClientId === undefined ? {} : { oauthClientId: requestPolicy.oauthClientId }),
    ...(requestPolicy.oauthTokenId === undefined ? {} : { oauthTokenId: requestPolicy.oauthTokenId }),
    ...(requestPolicy.trustHeaders === undefined ? {} : { trustHeaders: requestPolicy.trustHeaders }),
    ...(requestPolicy.trustedHeaderSecret === undefined ? {} : { trustedHeaderSecret: requestPolicy.trustedHeaderSecret }),
  };
}

export function httpTrustsRequestHeaders(defaultPolicy: HttpPolicyOptions, request: IncomingMessage): boolean {
  const enabled = defaultPolicy.trustHeaders === true || process.env.OPENWIKI_TRUST_AUTH_HEADERS === "1";
  if (!enabled) {
    return false;
  }
  const secret = defaultPolicy.trustedHeaderSecret ?? process.env.OPENWIKI_TRUST_AUTH_HEADERS_SECRET?.trim();
  if (!secret) {
    return false;
  }
  return timingSafeStringEquals(firstHeader(request.headers["x-openwiki-proxy-secret"]), secret);
}

export function timingSafeStringEquals(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) {
    return false;
  }
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(actualBytes, expectedBytes);
}

function optionalPrincipals(principals: string[]): { principals?: string[] } {
  const unique = principals.filter((principal, index, values) => principal.trim().length > 0 && values.indexOf(principal) === index);
  return unique.length === 0 ? {} : { principals: unique };
}

function parsePrincipals(principalsHeader: string | undefined, groupsHeader: string | undefined): string[] {
  const direct = splitHeaderList(principalsHeader);
  const groups = splitHeaderList(groupsHeader).map((group) => (group.includes(":") ? group : "group:" + group));
  return [...direct, ...groups].filter((principal, index, principals) => principals.indexOf(principal) === index);
}

function splitHeaderList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function canSeeAdminSurface(policy: HttpPolicyOptions): boolean {
  const context = httpPolicyContext(policy);
  return context.bounds === undefined && (context.role === "admin" || context.scopes.includes("wiki:admin"));
}

export function identityLabelForPolicy(policy: HttpPolicyOptions): string {
  const context = httpPolicyContext(policy);
  if (context.actorId !== undefined) {
    return context.role === undefined ? shortIdentity(context.actorId) : `${shortIdentity(context.actorId)} · ${context.role}`;
  }
  if (context.role !== undefined) {
    return context.role;
  }
  if (context.principals !== undefined && context.principals.length > 0) {
    return shortIdentity(context.principals[0] ?? "");
  }
  return "Local viewer";
}

export function identityTitleForPolicy(policy: HttpPolicyOptions): string {
  const context = httpPolicyContext(policy);
  const parts = [
    context.actorId === undefined ? "Actor: local/anonymous" : `Actor: ${context.actorId}`,
    context.role === undefined ? "Role: viewer" : `Role: ${context.role}`,
    `Scopes: ${context.scopes.join(", ")}`,
    ...(context.principals === undefined || context.principals.length === 0 ? [] : [`Principals: ${context.principals.join(", ")}`]),
  ];
  return parts.join(" · ");
}

function shortIdentity(value: string): string {
  return value.replace(/^(actor:user:|actor:agent:|group:|role:)/, "");
}
