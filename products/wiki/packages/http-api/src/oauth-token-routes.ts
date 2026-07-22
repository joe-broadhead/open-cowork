import { isoNow } from "@openwiki/core";
import { hashOpenWikiToken } from "@openwiki/policy";
import {
  activeAuthorizationCodeMatches,
  activeTokenMatches,
  clientCredentialsFromRequest,
  clientExpired,
  clientSecretMatches,
  findOAuthClient,
  grantAllowed,
  issueOAuthTokens,
  objectBody,
  oauthError,
  optionalString,
  pkceChallenge,
  requestedOAuthScopes,
  stringValue,
  tokenMatches,
  tokenResponse,
} from "./oauth-helpers.ts";
import { oauthReady, readOAuthStateForRuntime, updateOAuthStateForRuntime } from "./oauth-runtime.ts";
import type { HttpRequestContext, HttpRouteResult } from "./types.ts";

export async function oauthToken(root: string, body: unknown, context: HttpRequestContext): Promise<HttpRouteResult> {
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

export async function oauthRevoke(root: string, body: unknown, context: HttpRequestContext): Promise<HttpRouteResult> {
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

export async function oauthIntrospect(root: string, body: unknown, context: HttpRequestContext): Promise<HttpRouteResult> {
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
