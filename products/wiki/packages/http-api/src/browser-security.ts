import type { IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { firstHeader } from "./http-headers.ts";

interface BrowserWriteProtectionResult {
  status: number;
  body: {
    error: {
      code: "forbidden";
      message: string;
    };
  };
}

export function browserWriteProtectionFailure(request: IncomingMessage): BrowserWriteProtectionResult | undefined {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://openwiki.local");
  if (method !== "POST") {
    return undefined;
  }

  const rawOrigin = firstHeader(request.headers.origin);
  const origin = normalizeOrigin(rawOrigin);
  const allowedOrigins = allowedBrowserWriteOrigins(request);
  const fetchSite = firstHeader(request.headers["sec-fetch-site"])?.trim().toLowerCase();
  const machineOAuthPath = isMachineOAuthPath(url.pathname);
  if (rawOrigin !== undefined && (origin === undefined || !allowedOrigins.has(origin))) {
    return forbiddenBrowserWrite("Browser write request Origin is not allowed");
  }
  if (origin === undefined && (isServerRenderedWritePath(url.pathname) || (!machineOAuthPath && isFormPost(request)))) {
    return forbiddenBrowserWrite("Browser write request requires an Origin header");
  }
  if (origin === undefined && fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none") {
    return forbiddenBrowserWrite("Browser write request Fetch Metadata is not same-origin");
  }
  if (origin === undefined && fetchSite === undefined && isJsonPost(request) && !isProviderWebhookPath(url.pathname) && hasTrustedIdentityHeaders(request)) {
    return forbiddenBrowserWrite("Trusted-header JSON write request requires an Origin or Fetch Metadata header");
  }
  return undefined;
}

export function requestOriginIsAllowed(request: IncomingMessage): boolean {
  const rawOrigin = firstHeader(request.headers.origin);
  if (rawOrigin === undefined) {
    return true;
  }
  const origin = normalizeOrigin(rawOrigin);
  return origin !== undefined && allowedBrowserWriteOrigins(request).has(origin);
}

function isFormPost(request: IncomingMessage): boolean {
  const contentType = firstHeader(request.headers["content-type"])?.toLowerCase() ?? "";
  return (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data") ||
    contentType.includes("text/plain")
  );
}

function isJsonPost(request: IncomingMessage): boolean {
  return (firstHeader(request.headers["content-type"])?.toLowerCase() ?? "").includes("application/json");
}

function hasTrustedIdentityHeaders(request: IncomingMessage): boolean {
  return [
    "x-openwiki-proxy-secret",
    "x-openwiki-role",
    "x-openwiki-scopes",
    "x-openwiki-actor",
    "x-openwiki-groups",
    "x-openwiki-principals",
  ].some((name) => firstHeader(request.headers[name]) !== undefined);
}

function isProviderWebhookPath(pathname: string): boolean {
  return pathname === "/api/v1/webhooks/github" || pathname === "/api/v1/webhooks/gitlab";
}

function isMachineOAuthPath(pathname: string): boolean {
  return pathname === "/oauth/token" || pathname === "/oauth/revoke" || pathname === "/oauth/introspect" || pathname === "/oauth/register";
}

function allowedBrowserWriteOrigins(request: IncomingMessage): Set<string> {
  const origins = new Set<string>();
  for (const origin of (process.env.OPENWIKI_PUBLIC_ORIGIN ?? "").split(",")) {
    const normalized = normalizeOrigin(origin);
    if (normalized !== undefined) {
      origins.add(normalized);
    }
  }

  const host = firstHeader(request.headers.host)?.trim();
  if (host !== undefined && host.length > 0 && localDevelopmentHost(host)) {
    origins.add(`http://${host}`);
    origins.add(`https://${host}`);
  }

  if (trustedProxyOriginRequest(request)) {
    const forwardedHost = firstHeader(request.headers["x-forwarded-host"])?.trim();
    const forwardedProto = firstHeader(request.headers["x-forwarded-proto"])?.trim().split(",")[0]?.trim();
    if (forwardedHost !== undefined && forwardedHost.length > 0 && (forwardedProto === "http" || forwardedProto === "https")) {
      origins.add(`${forwardedProto}://${forwardedHost}`);
    }
  }

  return origins;
}

function localDevelopmentHost(host: string): boolean {
  try {
    const parsed = new URL(`http://${host}`);
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1" || parsed.hostname === "[::1]";
  } catch {
    return false;
  }
}

export function trustedProxyOriginRequest(request: IncomingMessage): boolean {
  if (process.env.OPENWIKI_TRUST_PROXY_ORIGIN !== "1") {
    return false;
  }
  const secret = (process.env.OPENWIKI_TRUST_PROXY_ORIGIN_SECRET ?? process.env.OPENWIKI_TRUST_AUTH_HEADERS_SECRET ?? "").trim();
  if (!secret) {
    return false;
  }
  return timingSafeStringEquals(firstHeader(request.headers["x-openwiki-proxy-secret"]), secret);
}

function normalizeOrigin(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim().replace(/\/+$/, "");
  if (trimmed.length === 0 || trimmed === "null") {
    return undefined;
  }
  try {
    const url = new URL(trimmed);
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function isServerRenderedWritePath(pathname: string): boolean {
  return (
    pathname === "/policy/propose" ||
    pathname === "/oauth/authorize" ||
    pathname === "/policy/sections/propose" ||
    pathname === "/admin/service-accounts/revoke" ||
    webActionId(pathname, "/pages/", "propose") !== undefined ||
    webActionId(pathname, "/proposals/", "review") !== undefined ||
    webActionId(pathname, "/proposals/", "close") !== undefined ||
    webActionId(pathname, "/proposals/", "apply") !== undefined ||
    webActionId(pathname, "/proposals/", "comment") !== undefined
  );
}

function webActionId(pathname: string, prefix: string, action: string): string | undefined {
  if (!pathname.startsWith(prefix) || !pathname.endsWith(`/${action}`)) {
    return undefined;
  }
  const encoded = pathname.slice(prefix.length, -1 * (`/${action}`).length);
  return encoded.length === 0 ? undefined : decodeURIComponent(encoded);
}

function forbiddenBrowserWrite(message: string): BrowserWriteProtectionResult {
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

function timingSafeStringEquals(left: string | undefined, right: string): boolean {
  if (left === undefined) {
    return false;
  }
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
