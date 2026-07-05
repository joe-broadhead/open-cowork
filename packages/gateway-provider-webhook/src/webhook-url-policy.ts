import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  WebhookDeliveryNetworkError,
  WebhookDeliveryPolicyError
} from "./webhook-retry.js";

export type ResolvedWebhookAddress = {
  address: string;
  family: number;
};

export type ResolveWebhookHostname = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<string | { address: string; family?: number }>>;

export interface WebhookDeliveryUrlPolicy {
  allowedHosts?: readonly string[];
  allowPrivateDelivery?: boolean;
}

export function validateWebhookDeliveryUrl(value: string, policy: WebhookDeliveryUrlPolicy = {}): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Webhook delivery URL is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Webhook delivery URL must use http or https");
  }
  if (url.protocol === "http:" && !isLocalHttpHost(url.hostname)) {
    throw new Error("Webhook delivery URL must use https unless it targets localhost");
  }
  if (url.username || url.password) {
    throw new Error("Webhook delivery URL must not include embedded credentials");
  }

  const hostname = normalizePolicyHostname(url.hostname);
  const local = isLocalHttpHost(hostname);
  if (!local && !isHostnameAllowed(hostname, policy.allowedHosts)) {
    throw new Error("Webhook delivery URL host is not allowed");
  }
  // Cloud metadata is blocked unconditionally — never gated by allowPrivateDelivery.
  if (!local && isCloudMetadataHost(hostname)) {
    throw new Error("Webhook delivery URL must not target a cloud metadata endpoint");
  }
  if (!local && !policy.allowPrivateDelivery && isPrivateOrReservedIpAddress(hostname)) {
    throw new Error("Webhook delivery URL must not target a private or reserved IP literal");
  }
  url.hash = "";
  return url;
}

export async function resolveWebhookDeliveryAddresses(
  url: URL,
  input: {
    resolveHostname?: ResolveWebhookHostname;
    allowPrivateDelivery?: boolean;
  } = {},
): Promise<ResolvedWebhookAddress[]> {
  try {
    const hostname = normalizePolicyHostname(url.hostname);
    const resolved = await resolveHostAddresses(
      hostname,
      input.resolveHostname ?? lookup,
      "Webhook delivery URL",
      { allowPrivate: input.allowPrivateDelivery === true || isLocalHttpHost(hostname) },
    );
    if (isLocalHttpHost(hostname) && resolved.some((record) => !isPrivateOrReservedIpAddress(record.address))) {
      throw new Error("Webhook delivery URL localhost resolved to a public address");
    }
    return resolved;
  } catch (error) {
    if (error instanceof WebhookDeliveryPolicyError) throw error;
    if (isTransientResolverError(error)) throw new WebhookDeliveryNetworkError(error);
    throw new WebhookDeliveryPolicyError(error);
  }
}

export function isLocalHttpHost(hostname: string): boolean {
  const normalized = normalizePolicyHostname(hostname);
  return normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1";
}

export function isHostnameAllowed(hostname: string, allowedHosts: readonly string[] | undefined): boolean {
  const allowed = (allowedHosts || []).map(normalizePolicyHostname).filter(Boolean);
  if (allowed.length === 0) return true;
  const normalized = normalizePolicyHostname(hostname);
  return allowed.some((entry) => {
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(1);
      return normalized.endsWith(suffix) && normalized.length > suffix.length;
    }
    return normalized === entry;
  });
}

export function isPrivateOrReservedIpAddress(value: string): boolean {
  const normalized = normalizePolicyHostname(value);
  if (normalized.includes(":")) return isPrivateOrReservedIpv6(normalized);
  return isPrivateOrReservedIpv4(normalized);
}

// Cloud instance-metadata (IMDS) endpoints. These MUST be blocked even when
// allowPrivateDelivery is enabled — an operator opting into internal webhook
// delivery never legitimately targets the metadata service, and reaching it
// from a server-side fetch is the classic credential-exfil SSRF. Mirrors the
// always-blocked cloud-metadata class in mcp-url-policy.
const CLOUD_METADATA_HOSTNAMES = new Set(["metadata.google.internal", "metadata"]);
const CLOUD_METADATA_IPS = new Set([
  "169.254.169.254", // AWS / GCP / Azure / OpenStack IMDS (IPv4 link-local)
  "fd00:ec2::254", // AWS IMDSv6
]);

export function isCloudMetadataHost(value: string): boolean {
  const normalized = normalizePolicyHostname(value);
  if (CLOUD_METADATA_HOSTNAMES.has(normalized)) return true;
  if (CLOUD_METADATA_IPS.has(normalized)) return true;
  const embedded = ipv4FromMappedIpv6(normalized) ?? ipv4FromNat64(normalized);
  return embedded !== null && CLOUD_METADATA_IPS.has(embedded);
}

function normalizePolicyHostname(value: string): string {
  return value.trim().replace(/^\[/u, "").replace(/\]$/u, "").toLowerCase();
}

async function resolveHostAddresses(
  hostname: string,
  resolveHostname: ResolveWebhookHostname,
  label: string,
  options: { allowPrivate?: boolean } = {},
): Promise<ResolvedWebhookAddress[]> {
  const literalFamily = isIP(hostname);
  if (literalFamily) {
    if (isCloudMetadataHost(hostname)) {
      throw new Error(`${label} targets a cloud metadata endpoint`);
    }
    if (!options.allowPrivate && isPrivateOrReservedIpAddress(hostname)) {
      throw new Error(`${label} resolved to a private or reserved address`);
    }
    return [{ address: hostname, family: literalFamily }];
  }

  let records: Array<string | { address: string; family?: number }>;
  try {
    records = await resolveHostname(hostname, { all: true, verbatim: true });
  } catch (error) {
    if (isTransientResolverError(error)) throw error;
    throw new Error(`${label} host cannot be resolved`, { cause: error });
  }
  if (records.length === 0) {
    throw new Error(`${label} host cannot be resolved`);
  }

  return records.map((record) => {
    const address = typeof record === "string" ? record : record.address;
    const family = typeof record === "string" ? isIP(record) : record.family ?? isIP(record.address);
    if (!address || !family) throw new Error(`${label} host cannot be resolved`);
    const normalizedAddress = normalizePolicyHostname(address);
    if (isCloudMetadataHost(normalizedAddress)) {
      throw new Error(`${label} resolved to a cloud metadata endpoint`);
    }
    if (!options.allowPrivate && isPrivateOrReservedIpAddress(normalizedAddress)) {
      throw new Error(`${label} resolved to a private or reserved address`);
    }
    return { address: normalizedAddress, family };
  });
}

function isTransientResolverError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const code = typeof error.code === "string" ? error.code.toUpperCase() : "";
  return code === "EAI_AGAIN" ||
    code === "ETIMEOUT" ||
    code === "ETIMEDOUT" ||
    code === "ESERVFAIL" ||
    code === "SERVFAIL";
}

function isPrivateOrReservedIpv4(value: string): boolean {
  const parts = value.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && (parts[2] === 0 || parts[2] === 2)) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && parts[2] === 100) return true;
  if (a === 203 && b === 0 && parts[2] === 113) return true;
  return false;
}

function isPrivateOrReservedIpv6(value: string): boolean {
  const normalized = value.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  const mappedIpv4 = ipv4FromMappedIpv6(normalized);
  if (mappedIpv4) return isPrivateOrReservedIpv4(mappedIpv4);
  // NAT64 (64:ff9b::/96) embeds an IPv4 address that a NAT64 gateway translates to —
  // recheck the embedded IPv4 so a private/metadata target can't tunnel through.
  const nat64Ipv4 = ipv4FromNat64(normalized);
  if (nat64Ipv4) return isPrivateOrReservedIpv4(nat64Ipv4);
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
  if (normalized.startsWith("ff")) return true;
  if (normalized.startsWith("2001:db8")) return true;
  return false;
}

function ipv4FromMappedIpv6(value: string): string | null {
  if (!value.startsWith("::ffff:")) return null;
  const suffix = value.slice("::ffff:".length);
  if (suffix.includes(".")) return suffix;
  const parts = suffix.split(":");
  if (parts.length !== 2) return null;
  const high = parseIpv6MappedPart(parts[0]);
  const low = parseIpv6MappedPart(parts[1]);
  if (high === null || low === null) return null;
  return [
    (high >> 8) & 0xff,
    high & 0xff,
    (low >> 8) & 0xff,
    low & 0xff
  ].join(".");
}

function ipv4FromNat64(value: string): string | null {
  const prefix = "64:ff9b::";
  if (!value.startsWith(prefix)) return null;
  const suffix = value.slice(prefix.length);
  if (suffix.includes(".")) return suffix; // dotted form, e.g. 64:ff9b::169.254.169.254
  const parts = suffix.split(":");
  if (parts.length !== 2) return null;
  const high = parseIpv6MappedPart(parts[0]);
  const low = parseIpv6MappedPart(parts[1]);
  if (high === null || low === null) return null;
  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join(".");
}

function parseIpv6MappedPart(value: string | undefined): number | null {
  if (!value || !/^[0-9a-f]{1,4}$/u.test(value)) return null;
  const parsed = Number.parseInt(value, 16);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 0xffff ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
