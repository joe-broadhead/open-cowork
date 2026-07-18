import { isoNow } from "@openwiki/core";
import { policyEffectiveScopes } from "./oauth-authorization.ts";
import type { OAuthClientRecord, OAuthState } from "./oauth-state.ts";
import type { HttpPolicyOptions, HttpRouteResult } from "./types.ts";

export function oauthClientApprovalId(pathname: string): string | undefined {
  const match = /^\/oauth\/clients\/([^/]+)\/approve$/.exec(pathname);
  if (match === null) {
    return undefined;
  }
  try {
    return decodeURIComponent(match[1] ?? "");
  } catch {
    return "";
  }
}

export async function approveOAuthDynamicClient(input: {
  clientId: string;
  policy: HttpPolicyOptions;
  updateState: <T>(update: (state: OAuthState) => T | Promise<T>) => Promise<T>;
}): Promise<HttpRouteResult> {
  const scopes = policyEffectiveScopes(input.policy);
  if (!scopes.includes("wiki:admin") || input.policy.bounds !== undefined) {
    return oauthError(403, "access_denied", "OAuth client approval requires unbounded wiki:admin");
  }
  const now = isoNow();
  let approved: OAuthClientRecord | undefined;
  await input.updateState((state) => {
    const client = state.dynamic_clients.find((candidate) => candidate.client_id === input.clientId);
    if (client === undefined || clientExpired(client)) {
      return;
    }
    client.approved_at = client.approved_at ?? now;
    client.updated_at = now;
    approved = client;
  });
  if (approved === undefined) {
    return oauthError(404, "invalid_client", "Unknown OAuth dynamic client");
  }
  return {
    status: 200,
    body: {
      client_id: approved.client_id,
      client_name: approved.client_name,
      redirect_uris: approved.redirect_uris,
      grant_types: approved.grant_types,
      approval_status: "approved",
      approved_at: approved.approved_at,
    },
  };
}

function clientExpired(client: OAuthClientRecord): boolean {
  return client.expires_at !== undefined && isPastIsoTimestamp(client.expires_at);
}

function isPastIsoTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

function oauthError(status: number, code: string, message: string): HttpRouteResult {
  return {
    status,
    body: {
      error: code,
      error_description: message,
    },
  };
}
