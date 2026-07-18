import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { OpenWikiAuthOAuthConfig, OpenWikiRole, OpenWikiScope } from "@openwiki/core";
import type { PolicyBounds } from "@openwiki/policy";
import type { OAuthClientRecord } from "./oauth-state.ts";

export type OAuthStateBackend = "file" | "postgres";

export interface OAuthAuthorizeParams {
  responseType: string;
  clientId?: string;
  redirectUri: string;
  codeChallengeMethod: string;
  codeChallenge: string;
  scope?: string;
  state?: string;
}

export interface OAuthAuthorizePostParams extends OAuthAuthorizeParams {
  csrfToken?: string;
}

export interface PreparedOAuthAuthorization {
  ready: { issuer: string; config: OpenWikiAuthOAuthConfig; stateBackend: OAuthStateBackend };
  client: OAuthClientRecord;
  params: OAuthAuthorizeParams;
  scopes: OpenWikiScope[];
  actorId: string;
  role?: OpenWikiRole;
  principals: string[];
  bounds?: PolicyBounds;
}

const processOAuthAuthorizeCsrfSecret = randomBytes(32);

export function oauthAuthorizeParamsFromUrl(url: URL): OAuthAuthorizeParams {
  return {
    responseType: url.searchParams.get("response_type") ?? "",
    ...optionalStringProperty(url.searchParams.get("client_id"), "clientId"),
    redirectUri: url.searchParams.get("redirect_uri") ?? "",
    codeChallengeMethod: url.searchParams.get("code_challenge_method") ?? "",
    codeChallenge: url.searchParams.get("code_challenge") ?? "",
    ...optionalStringProperty(url.searchParams.get("scope"), "scope"),
    ...optionalStringProperty(url.searchParams.get("state"), "state"),
  };
}

export function oauthAuthorizeParamsFromBody(body: unknown): OAuthAuthorizePostParams {
  const params = objectBody(body);
  return {
    responseType: stringValue(params.response_type),
    ...optionalStringProperty(params.client_id, "clientId"),
    redirectUri: stringValue(params.redirect_uri),
    codeChallengeMethod: stringValue(params.code_challenge_method),
    codeChallenge: stringValue(params.code_challenge),
    ...optionalStringProperty(params.scope, "scope"),
    ...optionalStringProperty(params.state, "state"),
    ...optionalStringProperty(params.csrf_token, "csrfToken"),
  };
}

export function renderOAuthConsentForm(prepared: PreparedOAuthAuthorization, csrfToken: string): string {
  const clientName = prepared.client.client_name ?? prepared.client.client_id;
  const fields: Record<string, string | undefined> = {
    response_type: prepared.params.responseType,
    client_id: prepared.client.client_id,
    redirect_uri: prepared.params.redirectUri,
    code_challenge_method: prepared.params.codeChallengeMethod,
    code_challenge: prepared.params.codeChallenge,
    scope: prepared.scopes.join(" "),
    state: prepared.params.state,
    csrf_token: csrfToken,
  };
  const hiddenFields = Object.entries(fields)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `<input type="hidden" name="${htmlEscape(name)}" value="${htmlEscape(value)}">`)
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${htmlEscape(clientName)}</title>
</head>
<body>
<main>
<h1>Authorize ${htmlEscape(clientName)}</h1>
<p>${htmlEscape(clientName)} is requesting access as ${htmlEscape(prepared.actorId)}.</p>
<form method="post" action="/oauth/authorize">
${hiddenFields}
<button type="submit">Authorize</button>
</form>
</main>
</body>
</html>
`;
}

export function signOAuthAuthorizeCsrf(prepared: PreparedOAuthAuthorization): string {
  const payload = Buffer.from(JSON.stringify(oauthAuthorizeCsrfPayload(prepared))).toString("base64url");
  const mac = oauthAuthorizeCsrfMac(payload);
  return `owcsrf_${payload}.${mac}`;
}

export function verifyOAuthAuthorizeCsrf(prepared: PreparedOAuthAuthorization, token: string | undefined): boolean {
  if (token === undefined || !token.startsWith("owcsrf_")) {
    return false;
  }
  const encoded = token.slice("owcsrf_".length);
  const dot = encoded.lastIndexOf(".");
  if (dot <= 0) {
    return false;
  }
  const payload = encoded.slice(0, dot);
  const mac = encoded.slice(dot + 1);
  if (!timingSafeStringEquals(mac, oauthAuthorizeCsrfMac(payload))) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
  } catch {
    return false;
  }
  if (!isOAuthAuthorizeCsrfPayload(parsed)) {
    return false;
  }
  if (Date.now() - parsed.issued_at > 10 * 60 * 1000) {
    return false;
  }
  return JSON.stringify({ ...parsed, issued_at: 0 }) === JSON.stringify({ ...oauthAuthorizeCsrfPayload(prepared), issued_at: 0 });
}

function oauthAuthorizeCsrfPayload(prepared: PreparedOAuthAuthorization): Record<string, unknown> {
  return {
    issued_at: Date.now(),
    actor_id: prepared.actorId,
    client_id: prepared.client.client_id,
    redirect_uri: prepared.params.redirectUri,
    code_challenge_method: prepared.params.codeChallengeMethod,
    code_challenge: prepared.params.codeChallenge,
    scopes: prepared.scopes,
    state: prepared.params.state ?? null,
  };
}

function isOAuthAuthorizeCsrfPayload(value: unknown): value is { issued_at: number } & Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { issued_at?: unknown }).issued_at === "number" &&
    Number.isFinite((value as { issued_at: number }).issued_at)
  );
}

function oauthAuthorizeCsrfMac(payload: string): string {
  const envSecret = process.env.OPENWIKI_OAUTH_CSRF_SECRET?.trim() || process.env.OPENWIKI_TRUST_AUTH_HEADERS_SECRET?.trim();
  const secret = envSecret === undefined || envSecret.length === 0 ? processOAuthAuthorizeCsrfSecret : Buffer.from(envSecret, "utf8");
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function timingSafeStringEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "\"":
        return "&quot;";
      default:
        return "&#39;";
    }
  });
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
