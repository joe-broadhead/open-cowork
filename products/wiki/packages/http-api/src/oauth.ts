import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isoNow, type OpenWikiOAuthClientConfig, type OpenWikiRole, type OpenWikiScope } from "@openwiki/core";
import { hashOpenWikiToken, mergePolicyBounds, parseScopes, policyBoundsFromConfig, scopesForRole, uniqueScopes, type PolicyBounds } from "@openwiki/policy";
import { readConfig } from "@openwiki/repo";
import { firstHeader } from "./http-headers.ts";
import {
  oauthAuthorizeParamsFromBody,
  oauthAuthorizeParamsFromUrl,
  renderOAuthConsentForm,
  signOAuthAuthorizeCsrf,
  verifyOAuthAuthorizeCsrf,
  type OAuthAuthorizeParams,
  type PreparedOAuthAuthorization,
} from "./oauth-consent.ts";
import { approveOAuthDynamicClient, oauthClientApprovalId } from "./oauth-dynamic-clients.ts";
import { oauthReady, oauthRuntime, oauthStateBackendFailure, readOAuthStateForRuntime, updateOAuthStateForRuntime } from "./oauth-runtime.ts";
import { oauthAuthorizationPrincipals, oauthAuthorizationRole, policyEffectiveScopes, scopesAllowedByPolicy } from "./oauth-authorization.ts";
import { type OAuthAuthorizationCodeRecord, type OAuthClientRecord, type OAuthTokenRecord } from "./oauth-state.ts";
import type { HttpPolicyOptions, HttpRequestContext, HttpRouteResult } from "./types.ts";

interface OAuthRouteInput {
  root: string;
  method: string;
  url: URL;
  body: unknown | undefined;
  policy: HttpPolicyOptions;
  context: HttpRequestContext;
}

interface OAuthTokenIssueInput {
  client: OAuthClientRecord;
  actorId: string;
  scopes: OpenWikiScope[];
  role?: OpenWikiRole;
  principals?: string[];
  bounds?: PolicyBounds;
  includeRefreshToken: boolean;
}

export interface ResolvedOAuthBearer {
  actorId: string;
  scopes: OpenWikiScope[];
  role?: OpenWikiRole;
  principals?: string[];
  bounds?: PolicyBounds;
  clientId: string;
  tokenId: string;
}

export async function routeOAuthPublicRoutes(input: OAuthRouteInput): Promise<HttpRouteResult | undefined> {
  if (input.method === "GET" && input.url.pathname === "/.well-known/oauth-authorization-server") {
    return oauthMetadata(input.root);
  }
  if (input.method === "GET" && input.url.pathname === "/.well-known/oauth-protected-resource") {
    return oauthProtectedResourceMetadata(input.root);
  }
  if (input.method === "POST" && input.url.pathname === "/oauth/register") {
    return oauthRegister(input.root, input.body);
  }
  if (input.method === "POST" && input.url.pathname === "/oauth/token") {
    return oauthToken(input.root, input.body, input.context);
  }
  if (input.method === "POST" && input.url.pathname === "/oauth/revoke") {
    return oauthRevoke(input.root, input.body, input.context);
  }
  if (input.method === "POST" && input.url.pathname === "/oauth/introspect") {
    return oauthIntrospect(input.root, input.body, input.context);
  }
  return undefined;
}

export async function routeOAuthProtectedRoutes(input: OAuthRouteInput): Promise<HttpRouteResult | undefined> {
  const approveClientId = oauthClientApprovalId(input.url.pathname);
  if (input.method === "POST" && approveClientId !== undefined) {
    const ready = await oauthReady(input.root);
    if (ready.failure !== undefined) {
      return ready.failure;
    }
    return approveOAuthDynamicClient({
      clientId: approveClientId,
      policy: input.policy,
      updateState: (update) => updateOAuthStateForRuntime(input.root, ready, update),
    });
  }
  if (input.method === "GET" && input.url.pathname === "/oauth/authorize") {
    return oauthAuthorizeConsent(input.root, input.url, input.policy);
  }
  if (input.method === "POST" && input.url.pathname === "/oauth/authorize") {
    return oauthAuthorize(input.root, input.body, input.policy);
  }
  return undefined;
}

export async function resolveOAuthBearerToken(root: string, token: string | undefined): Promise<ResolvedOAuthBearer | undefined> {
  if (!token?.trim()) {
    return undefined;
  }
  const runtime = await oauthRuntime(root);
  if (!runtime.enabled || runtime.issuer === undefined) {
    return undefined;
  }
  if (oauthStateBackendFailure(runtime) !== undefined) {
    return undefined;
  }
  const state = await readOAuthStateForRuntime(root, runtime).catch(() => undefined);
  if (state === undefined) {
    return undefined;
  }
  const tokenHash = hashOpenWikiToken(token);
  const record = state.access_tokens.find((candidate) => activeTokenMatches(candidate, tokenHash));
  if (record === undefined) {
    return undefined;
  }
  return {
    actorId: record.actor_id,
    scopes: record.scopes,
    clientId: record.client_id,
    tokenId: record.id,
    ...(record.role === undefined ? {} : { role: record.role }),
    ...(record.principals === undefined ? {} : { principals: record.principals }),
    ...(record.bounds === undefined ? {} : { bounds: record.bounds }),
  };
}

async function oauthMetadata(root: string): Promise<HttpRouteResult> {
  const ready = await oauthReady(root);
  if (ready.failure !== undefined) {
    return ready.failure;
  }
  const issuer = ready.issuer;
  return {
    status: 200,
    body: {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      introspection_endpoint: `${issuer}/oauth/introspect`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
    },
  };
}

async function oauthProtectedResourceMetadata(root: string): Promise<HttpRouteResult> {
  const ready = await oauthReady(root);
  if (ready.failure !== undefined) {
    return ready.failure;
  }
  return {
    status: 200,
    body: {
      resource: ready.issuer,
      authorization_servers: [ready.issuer],
      bearer_methods_supported: ["header"],
    },
  };
}

async function oauthRegister(root: string, body: unknown): Promise<HttpRouteResult> {
  const ready = await oauthReady(root);
  if (ready.failure !== undefined) {
    return ready.failure;
  }
  if (ready.config.dynamic_client_registration?.enabled !== true && process.env.OPENWIKI_OAUTH_DYNAMIC_CLIENT_REGISTRATION !== "1") {
    return oauthError(403, "access_denied", "OAuth dynamic client registration is disabled");
  }
  const params = objectBody(body);
  const redirectUris = stringArray(params.redirect_uris);
  if (redirectUris.length === 0 || !redirectUris.every(validRedirectUri)) {
    return oauthError(400, "invalid_client_metadata", "redirect_uris must contain valid absolute redirect URIs");
  }
  const now = isoNow();
  const clientSecret = randomToken("owcs");
  const registration = ready.config.dynamic_client_registration;
  const clientName = optionalString(params.client_name);
  const client: OAuthClientRecord = {
    client_id: `owc_${randomBytes(16).toString("hex")}`,
    ...(clientName === undefined ? {} : { client_name: clientName }),
    redirect_uris: redirectUris,
    public: false,
    client_secret_hashes: [hashOpenWikiToken(clientSecret)],
    actor_id: `actor:agent:oauth:${randomBytes(8).toString("hex")}`,
    role: registration?.default_role ?? "viewer",
    scopes: registration?.default_scopes ?? scopesForRole(registration?.default_role ?? "viewer"),
    grant_types: ["authorization_code", "refresh_token"],
    ...optionalBounds(policyBoundsFromConfig(registration?.default_bounds)),
    ...(registration?.access_token_ttl_seconds === undefined ? {} : { access_token_ttl_seconds: registration.access_token_ttl_seconds }),
    ...(registration?.refresh_token_ttl_seconds === undefined ? {} : { refresh_token_ttl_seconds: registration.refresh_token_ttl_seconds }),
    created_at: now,
    updated_at: now,
  };
  await updateOAuthStateForRuntime(root, ready, (state) => {
    state.dynamic_clients.push(client);
  });
  return {
    status: 201,
    body: {
      client_id: client.client_id,
      client_secret: clientSecret,
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      grant_types: client.grant_types,
      token_endpoint_auth_method: "client_secret_basic",
      approval_status: "pending",
      approval_endpoint: `${ready.issuer}/oauth/clients/${encodeURIComponent(client.client_id)}/approve`,
    },
  };
}

async function oauthAuthorizeConsent(root: string, url: URL, policy: HttpPolicyOptions): Promise<HttpRouteResult> {
  const prepared = await prepareOAuthAuthorization(root, oauthAuthorizeParamsFromUrl(url), policy);
  if ("failure" in prepared) {
    return prepared.failure;
  }
  const csrfToken = signOAuthAuthorizeCsrf(prepared);
  return {
    status: 200,
    body: renderOAuthConsentForm(prepared, csrfToken),
    contentType: "text/html; charset=utf-8",
    headers: {
      "cache-control": "no-store",
    },
  };
}

async function oauthAuthorize(root: string, body: unknown, policy: HttpPolicyOptions): Promise<HttpRouteResult> {
  const params = oauthAuthorizeParamsFromBody(body);
  const prepared = await prepareOAuthAuthorization(root, params, policy);
  if ("failure" in prepared) {
    return prepared.failure;
  }
  if (!verifyOAuthAuthorizeCsrf(prepared, params.csrfToken)) {
    return oauthError(403, "access_denied", "OAuth authorization requires a valid same-origin consent token");
  }
  return issueOAuthAuthorizationCode(root, prepared);
}

async function prepareOAuthAuthorization(
  root: string,
  params: OAuthAuthorizeParams,
  policy: HttpPolicyOptions,
): Promise<PreparedOAuthAuthorization | { failure: HttpRouteResult }> {
  const ready = await oauthReady(root);
  if (ready.failure !== undefined) {
    return { failure: ready.failure };
  }
  const client = await findOAuthClient(root, params.clientId);
  if (client === undefined || clientExpired(client)) {
    return { failure: oauthError(400, "invalid_request", "Unknown OAuth client") };
  }
  if (!grantAllowed(client, "authorization_code")) {
    return { failure: oauthError(400, "unauthorized_client", "Client is not allowed to use authorization_code") };
  }
  if (client.approved_at === undefined) {
    return { failure: oauthError(403, "access_denied", "OAuth client requires administrator approval before authorization") };
  }
  if (params.responseType !== "code") {
    return { failure: oauthError(400, "unsupported_response_type", "OAuth response_type must be code") };
  }
  if (!client.redirect_uris.includes(params.redirectUri)) {
    return { failure: oauthError(400, "invalid_request", "redirect_uri is not registered for this client") };
  }
  if (params.codeChallengeMethod !== "S256" || params.codeChallenge.length < 43) {
    return { failure: oauthError(400, "invalid_request", "OAuth authorization_code requires PKCE S256") };
  }
  const scopes = requestedOAuthScopes(client, params.scope);
  if (scopes === undefined) {
    return { failure: oauthError(400, "invalid_scope", "Requested OAuth scopes exceed the client grant") };
  }
  const policyScopes = policyEffectiveScopes(policy);
  if (!scopesAllowedByPolicy(scopes, policyScopes)) {
    return { failure: oauthError(400, "invalid_scope", "Requested OAuth scopes exceed the authenticated actor grant") };
  }
  const actorId = policy.actorId ?? client.actor_id;
  const principals = oauthAuthorizationPrincipals(client, policy, policyScopes);
  const role = oauthAuthorizationRole(client.role, policy.role);
  return {
    ready,
    client,
    params,
    scopes,
    actorId,
    ...(role === undefined ? {} : { role }),
    principals,
    ...optionalBounds(mergePolicyBounds(client.bounds, policy.bounds)),
  };
}

async function issueOAuthAuthorizationCode(root: string, prepared: PreparedOAuthAuthorization): Promise<HttpRouteResult> {
  const code = randomToken("owc");
  const now = Date.now();
  await updateOAuthStateForRuntime(root, prepared.ready, (state) => {
    state.authorization_codes.push({
      id: `oauth-code:${randomBytes(8).toString("hex")}`,
      code_hash: hashOpenWikiToken(code),
      client_id: prepared.client.client_id,
      redirect_uri: prepared.params.redirectUri,
      code_challenge: prepared.params.codeChallenge,
      scopes: prepared.scopes,
      actor_id: prepared.actorId,
      ...(prepared.role === undefined ? {} : { role: prepared.role }),
      ...optionalPrincipals(prepared.principals),
      ...optionalBounds(prepared.bounds),
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + 10 * 60 * 1000).toISOString(),
    });
  });
  const redirect = new URL(prepared.params.redirectUri);
  redirect.searchParams.set("code", code);
  if (prepared.params.state !== undefined) {
    redirect.searchParams.set("state", prepared.params.state);
  }
  return { status: 302, body: "", contentType: "text/plain; charset=utf-8", headers: { location: redirect.toString() } };
}

async function oauthToken(root: string, body: unknown, context: HttpRequestContext): Promise<HttpRouteResult> {
  const ready = await oauthReady(root);
  if (ready.failure !== undefined) {
    return ready.failure;
  }
  const params = objectBody(body);
  const grantType = stringValue(params.grant_type);
  if (grantType === "authorization_code") {
    return oauthAuthorizationCodeToken(root, params, context);
  }
  if (grantType === "refresh_token") {
    return oauthRefreshToken(root, params, context);
  }
  if (grantType === "client_credentials") {
    return oauthClientCredentialsToken(root, params, context);
  }
  return oauthError(400, "unsupported_grant_type", "Unsupported OAuth grant_type");
}

async function oauthAuthorizationCodeToken(root: string, params: Record<string, unknown>, context: HttpRequestContext): Promise<HttpRouteResult> {
  const code = stringValue(params.code);
  const redirectUri = stringValue(params.redirect_uri);
  const verifier = stringValue(params.code_verifier);
  const codeHash = hashOpenWikiToken(code);
  return updateOAuthStateForRuntime(root, undefined, async (state) => {
    const record = state.authorization_codes.find((candidate) => activeAuthorizationCodeMatches(candidate, codeHash));
    if (record === undefined || record.redirect_uri !== redirectUri || pkceChallenge(verifier) !== record.code_challenge) {
      return oauthError(400, "invalid_grant", "Invalid OAuth authorization code");
    }
    const client = await findOAuthClient(root, record.client_id);
    if (client === undefined || clientExpired(client)) {
      return oauthError(400, "invalid_client", "OAuth client is not active");
    }
    const clientAuth = clientCredentialsFromRequest(params, context);
    if (!client.public && !clientSecretMatches(client, clientAuth.secret)) {
      return oauthError(401, "invalid_client", "Client authentication failed");
    }
    record.consumed_at = isoNow();
    const issued = issueOAuthTokens({
      client,
      actorId: record.actor_id,
      scopes: record.scopes,
      ...(record.role === undefined ? {} : { role: record.role }),
      ...(record.principals === undefined ? {} : { principals: record.principals }),
      ...(record.bounds === undefined ? {} : { bounds: record.bounds }),
      includeRefreshToken: grantAllowed(client, "refresh_token"),
    });
    state.access_tokens.push(issued.accessRecord);
    if (issued.refreshRecord !== undefined) {
      state.refresh_tokens.push(issued.refreshRecord);
    }
    return tokenResponse(issued);
  });
}

async function oauthRefreshToken(root: string, params: Record<string, unknown>, context: HttpRequestContext): Promise<HttpRouteResult> {
  const refreshToken = stringValue(params.refresh_token);
  const refreshHash = hashOpenWikiToken(refreshToken);
  return updateOAuthStateForRuntime(root, undefined, async (state) => {
    const record = state.refresh_tokens.find((candidate) => activeTokenMatches(candidate, refreshHash));
    if (record === undefined) {
      return oauthError(400, "invalid_grant", "Invalid OAuth refresh token");
    }
    const client = await findOAuthClient(root, record.client_id);
    if (client === undefined || clientExpired(client) || !grantAllowed(client, "refresh_token")) {
      return oauthError(400, "invalid_client", "OAuth client is not active");
    }
    const clientAuth = clientCredentialsFromRequest(params, context);
    if (!client.public && !clientSecretMatches(client, clientAuth.secret)) {
      return oauthError(401, "invalid_client", "Client authentication failed");
    }
    record.revoked_at = isoNow();
    const issued = issueOAuthTokens({
      client,
      actorId: record.actor_id,
      scopes: record.scopes,
      ...(record.role === undefined ? {} : { role: record.role }),
      ...(record.principals === undefined ? {} : { principals: record.principals }),
      ...(record.bounds === undefined ? {} : { bounds: record.bounds }),
      includeRefreshToken: true,
    });
    state.access_tokens.push(issued.accessRecord);
    if (issued.refreshRecord !== undefined) {
      state.refresh_tokens.push(issued.refreshRecord);
    }
    return tokenResponse(issued);
  });
}

async function oauthClientCredentialsToken(root: string, params: Record<string, unknown>, context: HttpRequestContext): Promise<HttpRouteResult> {
  const clientAuth = clientCredentialsFromRequest(params, context);
  const client = await findOAuthClient(root, clientAuth.clientId);
  if (client === undefined || client.public || clientExpired(client) || !clientSecretMatches(client, clientAuth.secret)) {
    return oauthError(401, "invalid_client", "Client authentication failed");
  }
  if (!grantAllowed(client, "client_credentials")) {
    return oauthError(400, "unauthorized_client", "Client is not allowed to use client_credentials");
  }
  const scopes = requestedOAuthScopes(client, optionalString(params.scope));
  if (scopes === undefined) {
    return oauthError(400, "invalid_scope", "Requested OAuth scopes exceed the client grant");
  }
  return updateOAuthStateForRuntime(root, undefined, (state) => {
    const issued = issueOAuthTokens({
      client,
      actorId: client.actor_id,
      scopes,
      ...(client.role === undefined ? {} : { role: client.role }),
      ...(client.principals === undefined ? {} : { principals: client.principals }),
      ...(client.bounds === undefined ? {} : { bounds: client.bounds }),
      includeRefreshToken: false,
    });
    state.access_tokens.push(issued.accessRecord);
    return tokenResponse(issued);
  });
}

async function oauthRevoke(root: string, body: unknown, context: HttpRequestContext): Promise<HttpRouteResult> {
  const ready = await oauthReady(root);
  if (ready.failure !== undefined) {
    return ready.failure;
  }
  const params = objectBody(body);
  const token = stringValue(params.token);
  const clientAuth = clientCredentialsFromRequest(params, context);
  const tokenHash = hashOpenWikiToken(token);
  return updateOAuthStateForRuntime(root, undefined, async (state) => {
    const access = state.access_tokens.find((candidate) => tokenMatches(candidate.token_hash, tokenHash));
    const refresh = state.refresh_tokens.find((candidate) => tokenMatches(candidate.token_hash, tokenHash));
    const clientId = access?.client_id ?? refresh?.client_id ?? clientAuth.clientId;
    const client = await findOAuthClient(root, clientId);
    if (client !== undefined && !client.public && !clientSecretMatches(client, clientAuth.secret)) {
      return oauthError(401, "invalid_client", "Client authentication failed");
    }
    const now = isoNow();
    if (access !== undefined) {
      access.revoked_at = now;
    }
    if (refresh !== undefined) {
      refresh.revoked_at = now;
    }
    return { status: 200, body: {} };
  });
}

async function oauthIntrospect(root: string, body: unknown, context: HttpRequestContext): Promise<HttpRouteResult> {
  const ready = await oauthReady(root);
  if (ready.failure !== undefined) {
    return ready.failure;
  }
  const params = objectBody(body);
  const token = stringValue(params.token);
  const clientAuth = clientCredentialsFromRequest(params, context);
  const state = await readOAuthStateForRuntime(root);
  const tokenHash = hashOpenWikiToken(token);
  const record = state.access_tokens.find((candidate) => tokenMatches(candidate.token_hash, tokenHash)) ??
    state.refresh_tokens.find((candidate) => tokenMatches(candidate.token_hash, tokenHash));
  if (record === undefined || !activeTokenMatches(record, tokenHash)) {
    return { status: 200, body: { active: false } };
  }
  const client = await findOAuthClient(root, clientAuth.clientId || record.client_id);
  if (client !== undefined && !client.public && !clientSecretMatches(client, clientAuth.secret)) {
    return oauthError(401, "invalid_client", "Client authentication failed");
  }
  return {
    status: 200,
    body: {
      active: true,
      client_id: record.client_id,
      actor_id: record.actor_id,
      scope: record.scopes.join(" "),
      token_type: "Bearer",
      ...(record.expires_at === undefined ? {} : { exp: Math.floor(Date.parse(record.expires_at) / 1000) }),
    },
  };
}

function issueOAuthTokens(input: OAuthTokenIssueInput): {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  accessRecord: OAuthTokenRecord;
  refreshRecord?: OAuthTokenRecord;
} {
  const now = Date.now();
  const accessTtlSeconds = boundedTtl(input.client.access_token_ttl_seconds, 3600, 60, 24 * 60 * 60);
  const refreshTtlSeconds = boundedTtl(input.client.refresh_token_ttl_seconds, 30 * 24 * 60 * 60, 3600, 90 * 24 * 60 * 60);
  const accessToken = randomToken("owat");
  const refreshToken = input.includeRefreshToken ? randomToken("owrt") : undefined;
  const common = {
    client_id: input.client.client_id,
    actor_id: input.actorId,
    scopes: input.scopes,
    ...(input.role === undefined ? {} : { role: input.role }),
    ...(input.principals === undefined ? {} : { principals: input.principals }),
    ...(input.bounds === undefined ? {} : { bounds: input.bounds }),
    created_at: new Date(now).toISOString(),
  };
  return {
    accessToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    expiresIn: accessTtlSeconds,
    accessRecord: {
      id: `oauth-access:${randomBytes(8).toString("hex")}`,
      token_hash: hashOpenWikiToken(accessToken),
      ...common,
      expires_at: new Date(now + accessTtlSeconds * 1000).toISOString(),
    },
    ...(refreshToken === undefined
      ? {}
      : {
          refreshRecord: {
            id: `oauth-refresh:${randomBytes(8).toString("hex")}`,
            token_hash: hashOpenWikiToken(refreshToken),
            ...common,
            expires_at: new Date(now + refreshTtlSeconds * 1000).toISOString(),
          },
        }),
  };
}

function tokenResponse(input: ReturnType<typeof issueOAuthTokens>): HttpRouteResult {
  return {
    status: 200,
    body: {
      access_token: input.accessToken,
      token_type: "Bearer",
      expires_in: input.expiresIn,
      ...(input.refreshToken === undefined ? {} : { refresh_token: input.refreshToken }),
      scope: input.accessRecord.scopes.join(" "),
    },
  };
}

async function findOAuthClient(root: string, clientId: string | undefined): Promise<OAuthClientRecord | undefined> {
  if (clientId === undefined || clientId.length === 0) {
    return undefined;
  }
  const config = await readConfig(root);
  const configured = (config.auth?.oauth?.clients ?? []).map(oauthClientFromConfig);
  const state = await readOAuthStateForRuntime(root);
  return [...configured, ...state.dynamic_clients].find((client) => client.client_id === clientId);
}

function oauthClientFromConfig(client: OpenWikiOAuthClientConfig): OAuthClientRecord {
  const bounds = policyBoundsFromConfig(client.bounds);
  return {
    client_id: client.client_id,
    ...(client.client_name === undefined ? {} : { client_name: client.client_name }),
    redirect_uris: client.redirect_uris,
    ...(client.public === undefined ? {} : { public: client.public }),
    ...(client.client_secret_hashes === undefined ? {} : { client_secret_hashes: client.client_secret_hashes }),
    actor_id: client.actor_id,
    ...(client.role === undefined ? {} : { role: client.role }),
    ...(client.scopes === undefined ? {} : { scopes: client.scopes }),
    ...(client.principals === undefined ? {} : { principals: client.principals }),
    ...(client.grant_types === undefined ? {} : { grant_types: client.grant_types }),
    ...(bounds === undefined ? {} : { bounds }),
    ...(client.access_token_ttl_seconds === undefined ? {} : { access_token_ttl_seconds: client.access_token_ttl_seconds }),
    ...(client.refresh_token_ttl_seconds === undefined ? {} : { refresh_token_ttl_seconds: client.refresh_token_ttl_seconds }),
    ...(client.created_at === undefined ? {} : { created_at: client.created_at }),
    ...(client.updated_at === undefined ? {} : { updated_at: client.updated_at }),
    ...(client.expires_at === undefined ? {} : { expires_at: client.expires_at }),
    approved_at: client.created_at ?? "configured",
  };
}

function requestedOAuthScopes(client: OAuthClientRecord, requested: string | undefined): OpenWikiScope[] | undefined {
  const allowed = new Set(clientEffectiveScopes(client));
  const scopes = requested === undefined || requested.trim().length === 0 ? [...allowed] : parseScopes(requested);
  if (scopes.length === 0 || scopes.some((scope) => !allowed.has(scope))) {
    return undefined;
  }
  return uniqueScopes(scopes);
}

function clientEffectiveScopes(client: Pick<OAuthClientRecord, "role" | "scopes">): OpenWikiScope[] {
  return uniqueScopes([...(client.role === undefined ? scopesForRole("viewer") : scopesForRole(client.role)), ...(client.scopes ?? [])]);
}

function clientCredentialsFromRequest(params: Record<string, unknown>, context: HttpRequestContext): { clientId?: string; secret?: string } {
  const basic = firstHeader(context.headers?.authorization);
  if (basic?.toLowerCase().startsWith("basic ") === true) {
    const decoded = Buffer.from(basic.slice(6), "base64").toString("utf8");
    const index = decoded.indexOf(":");
    if (index >= 0) {
      return { clientId: decoded.slice(0, index), secret: decoded.slice(index + 1) };
    }
  }
  return {
    ...optionalStringProperty(params.client_id, "clientId"),
    ...optionalStringProperty(params.client_secret, "secret"),
  };
}

function clientSecretMatches(client: OAuthClientRecord, secret: string | undefined): boolean {
  if (secret === undefined || secret.length === 0) {
    return false;
  }
  const secretHash = hashOpenWikiToken(secret);
  return (client.client_secret_hashes ?? []).some((hash) => tokenMatches(hash, secretHash));
}

function grantAllowed(client: OAuthClientRecord, grant: "authorization_code" | "client_credentials" | "refresh_token"): boolean {
  const grants = client.grant_types ?? ["authorization_code", "refresh_token"];
  return grants.includes(grant);
}

function activeAuthorizationCodeMatches(record: OAuthAuthorizationCodeRecord, codeHash: string): boolean {
  return record.consumed_at === undefined && !isPastIsoTimestamp(record.expires_at) && tokenMatches(record.code_hash, codeHash);
}

function activeTokenMatches(record: OAuthTokenRecord, tokenHash: string): boolean {
  return record.revoked_at === undefined && (record.expires_at === undefined || !isPastIsoTimestamp(record.expires_at)) && tokenMatches(record.token_hash, tokenHash);
}

function tokenMatches(storedHash: string, candidateHash: string): boolean {
  const stored = Buffer.from(storedHash);
  const candidate = Buffer.from(candidateHash);
  return stored.byteLength === candidate.byteLength && timingSafeEqual(stored, candidate);
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function randomToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function boundedTtl(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function clientExpired(client: OAuthClientRecord): boolean {
  return client.expires_at !== undefined && isPastIsoTimestamp(client.expires_at);
}

function isPastIsoTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

function validRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"));
  } catch {
    return false;
  }
}

function objectBody(value: unknown): Record<string, unknown> {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalStringProperty<Key extends string>(value: unknown, key: Key): Partial<Record<Key, string>> {
  const string = optionalString(value);
  return string === undefined ? {} : ({ [key]: string } as Partial<Record<Key, string>>);
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim());
  }
  return [];
}

function optionalPrincipals(principals: string[]): { principals?: string[] } {
  const unique = principals.filter((principal, index, values) => principal.trim().length > 0 && values.indexOf(principal) === index);
  return unique.length === 0 ? {} : { principals: unique };
}

function optionalBounds(bounds: PolicyBounds | undefined): { bounds?: PolicyBounds } {
  return bounds === undefined ? {} : { bounds };
}

function oauthError(status: number, code: string, message: string): HttpRouteResult {
  return { status, body: { error: code, error_description: message } };
}
