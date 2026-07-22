import { randomBytes } from "node:crypto";
import { isoNow, type OpenWikiRole, type OpenWikiScope } from "@openwiki/core";
import { hashOpenWikiToken, mergePolicyBounds, policyBoundsFromConfig, scopesForRole, type PolicyBounds } from "@openwiki/policy";
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
import {
  activeTokenMatches,
  clientExpired,
  findOAuthClient,
  grantAllowed,
  objectBody,
  oauthError,
  optionalBounds,
  optionalPrincipals,
  optionalString,
  randomToken,
  requestedOAuthScopes,
  stringArray,
  validRedirectUri,
} from "./oauth-helpers.ts";
import { oauthReady, oauthRuntime, oauthStateBackendFailure, readOAuthStateForRuntime, updateOAuthStateForRuntime } from "./oauth-runtime.ts";
import { oauthAuthorizationPrincipals, oauthAuthorizationRole, policyEffectiveScopes, scopesAllowedByPolicy } from "./oauth-authorization.ts";
import type { OAuthClientRecord } from "./oauth-state.ts";
import { oauthIntrospect, oauthRevoke, oauthToken } from "./oauth-token-routes.ts";
import type { HttpPolicyOptions, HttpRequestContext, HttpRouteResult } from "./types.ts";

interface OAuthRouteInput {
  root: string;
  method: string;
  url: URL;
  body: unknown | undefined;
  policy: HttpPolicyOptions;
  context: HttpRequestContext;
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
