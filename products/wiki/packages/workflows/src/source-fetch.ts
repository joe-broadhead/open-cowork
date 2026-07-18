import { promises as dns } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { SourceFetchConnectorKind } from "@openwiki/connectors";
import { OpenWikiValidationError, isBlockedOpenWikiHost, normalizeOpenWikiHost, openWikiIPv4ToDotted, parseOpenWikiIPv4Literal, type OpenWikiSourceFetchBudgetConfig } from "@openwiki/core";

export interface SourceFetchMetricSnapshot {
  attempts: Array<{ connector_kind: SourceFetchConnectorKind | "unknown"; status: "success" | "failure" | "timeout"; count: number }>;
  duration_seconds: Array<{ connector_kind: SourceFetchConnectorKind | "unknown"; status: "success" | "failure" | "timeout"; seconds: number; count: number }>;
}

const DEFAULT_SOURCE_FETCH_MAX_BYTES = 1024 * 1024;
const DEFAULT_SOURCE_FETCH_MAX_BYTES_CEILING = 5 * 1024 * 1024;
const DEFAULT_SOURCE_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_SOURCE_FETCH_TIMEOUT_MS_CEILING = 30_000;
export const BASE_SOURCE_FETCH_HEADERS = {
  accept: "text/plain,text/markdown,text/html,application/json,application/xml,text/xml;q=0.9,*/*;q=0.1",
  "user-agent": "OpenWiki/0.1 source-fetch",
};

const sourceFetchMetricCounters = new Map<string, { count: number; seconds: number }>();

export interface SourceFetchBudget {
  maxBytes: number;
  timeoutMs: number;
  maxBytesCeiling: number;
  timeoutMsCeiling: number;
}

export function sourceFetchBudget(
  config: OpenWikiSourceFetchBudgetConfig | undefined,
  requested: { maxBytes?: number; timeoutMs?: number } = {},
): SourceFetchBudget {
  return calculateSourceFetchBudget(config, requested, process.env);
}

export function calculateSourceFetchBudget(
  config: OpenWikiSourceFetchBudgetConfig | undefined,
  requested: { maxBytes?: number; timeoutMs?: number } = {},
  env: NodeJS.ProcessEnv = {},
): SourceFetchBudget {
  const maxBytesCeiling = boundedSourceFetchInteger(
    numberFromEnv(env, "OPENWIKI_SOURCE_FETCH_MAX_BYTES") ?? config?.max_bytes ?? DEFAULT_SOURCE_FETCH_MAX_BYTES_CEILING,
    1,
    1024 * 1024 * 1024,
    "source fetch max_bytes ceiling",
  );
  const timeoutMsCeiling = boundedSourceFetchInteger(
    numberFromEnv(env, "OPENWIKI_SOURCE_FETCH_MAX_TIMEOUT_MS") ?? config?.max_timeout_ms ?? DEFAULT_SOURCE_FETCH_TIMEOUT_MS_CEILING,
    1,
    10 * 60 * 1000,
    "source fetch timeout_ms ceiling",
  );
  const configuredDefaultMaxBytes = numberFromEnv(env, "OPENWIKI_SOURCE_FETCH_DEFAULT_MAX_BYTES") ?? config?.default_max_bytes;
  const configuredDefaultTimeoutMs = numberFromEnv(env, "OPENWIKI_SOURCE_FETCH_DEFAULT_TIMEOUT_MS") ?? config?.default_timeout_ms;
  const defaultMaxBytes = boundedSourceFetchInteger(
    configuredDefaultMaxBytes ?? Math.min(DEFAULT_SOURCE_FETCH_MAX_BYTES, maxBytesCeiling),
    1,
    maxBytesCeiling,
    "source fetch default max_bytes",
  );
  const defaultTimeoutMs = boundedSourceFetchInteger(
    configuredDefaultTimeoutMs ?? Math.min(DEFAULT_SOURCE_FETCH_TIMEOUT_MS, timeoutMsCeiling),
    1,
    timeoutMsCeiling,
    "source fetch default timeout_ms",
  );
  const maxBytes = requested.maxBytes === undefined
    ? defaultMaxBytes
    : boundedSourceFetchInteger(requested.maxBytes, 1, maxBytesCeiling, "source fetch max_bytes");
  const timeoutMs = requested.timeoutMs === undefined
    ? defaultTimeoutMs
    : boundedSourceFetchInteger(requested.timeoutMs, 1, timeoutMsCeiling, "source fetch timeout_ms");
  return { maxBytes, timeoutMs, maxBytesCeiling, timeoutMsCeiling };
}

function boundedSourceFetchInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new OpenWikiValidationError(`${label} must be between ${min} and ${max}`);
  }
  return value;
}

function numberFromEnv(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const value = env[name];
  return value === undefined || value.trim() === "" ? undefined : Number(value);
}

/** Return process-local source fetch counters for HTTP metrics and tests. */
export function sourceFetchMetricsSnapshot(): SourceFetchMetricSnapshot {
  const attempts: SourceFetchMetricSnapshot["attempts"] = [];
  const duration_seconds: SourceFetchMetricSnapshot["duration_seconds"] = [];
  for (const [key, value] of sourceFetchMetricCounters) {
    const [connectorKind = "unknown", status = "failure"] = key.split("|") as [SourceFetchConnectorKind | "unknown" | undefined, "success" | "failure" | "timeout" | undefined];
    attempts.push({ connector_kind: connectorKind, status, count: value.count });
    duration_seconds.push({ connector_kind: connectorKind, status, seconds: value.seconds, count: value.count });
  }
  return { attempts, duration_seconds };
}

export function resetSourceFetchMetricsForTests(): void {
  sourceFetchMetricCounters.clear();
}

export function recordSourceFetchMetric(
  connectorKind: SourceFetchConnectorKind | "unknown",
  status: "success" | "failure" | "timeout",
  durationMs: number,
): void {
  const key = `${connectorKind}|${status}`;
  const current = sourceFetchMetricCounters.get(key) ?? { count: 0, seconds: 0 };
  current.count += 1;
  current.seconds += Math.max(durationMs, 0) / 1000;
  sourceFetchMetricCounters.set(key, current);
}

export function sourceFetchErrorStatus(error: unknown): "failure" | "timeout" {
  if (error instanceof Error) {
    const name = error.name.toLowerCase();
    const message = error.message.toLowerCase();
    if (name.includes("timeout") || name.includes("abort") || message.includes("timeout") || message.includes("timed out")) {
      return "timeout";
    }
  }
  return "failure";
}


export async function readFetchBody(response: Response, maxBytes: number): Promise<{ text: string; bytes: number }> {
  if (!response.body) {
    return { text: "", bytes: 0 };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Source fetch exceeded max_bytes ${maxBytes}`);
    }
    chunks.push(value);
  }
  const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return {
    text: new TextDecoder("utf-8", { fatal: false }).decode(buffer),
    bytes: buffer.byteLength,
  };
}

export function detectPromptInjection(content: string | undefined): { detected: boolean; patterns: string[] } {
  if (!content) {
    return { detected: false, patterns: [] };
  }
  const checks: Array<[string, RegExp]> = [
    ["ignore-previous-instructions", /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i],
    ["system-prompt", /\b(system|developer)\s+prompt\b/i],
    ["instruction-hijack", /\b(disregard|override)\s+(the\s+)?(above|previous|prior|system|developer)\b/i],
    ["model-command", /\b(chatgpt|assistant|model|agent)\s+(must|should|will|ignore|obey)\b/i],
    ["hidden-instructions", /\b(hidden|secret)\s+instructions?\b/i],
  ];
  const patterns = checks.filter(([, pattern]) => pattern.test(content)).map(([name]) => name);
  return {
    detected: patterns.length > 0,
    patterns,
  };
}

interface PinnedSourceFetchTarget {
  parsed: URL;
  hostname: string;
  address: string;
  hostHeader: string;
}

export type SourceFetchDnsLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>;

interface SourceFetchTransportOptions {
  lookup?: SourceFetchDnsLookup;
}

/** Fetch an HTTP(S) source through DNS pinning and private-address blocking. */
export async function fetchSourceWithPinnedDns(
  rawUrl: string,
  headers: Record<string, string>,
  timeoutMs: number,
  maxBytes: number,
  options: SourceFetchTransportOptions = {},
): Promise<Response> {
  const target = await resolvePinnedSourceFetchTarget(rawUrl, options);
  const requester = target.parsed.protocol === "https:" ? httpsRequest : httpRequest;
  const requestHeaders = {
    ...headers,
    host: target.hostHeader,
  };
  const requestPath = `${target.parsed.pathname}${target.parsed.search}`;

  return await new Promise<Response>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    const request = requester(
      {
        hostname: target.address,
        port: target.parsed.port || undefined,
        path: requestPath || "/",
        method: "GET",
        headers: requestHeaders,
        signal: AbortSignal.timeout(timeoutMs),
        ...(target.parsed.protocol === "https:" ? { servername: target.hostname } : {}),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer) => {
          if (settled) {
            return;
          }
          total += chunk.byteLength;
          if (total > maxBytes) {
            fail(new Error(`Source fetch exceeded max_bytes ${maxBytes}`));
            request.destroy();
            response.destroy();
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on("error", fail);
        response.on("end", () => {
          if (settled) {
            return;
          }
          const status = response.statusCode;
          if (status === undefined) {
            fail(new Error("Source fetch did not return an HTTP status"));
            return;
          }
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) {
              for (const item of value) {
                responseHeaders.append(name, item);
              }
            } else if (value !== undefined) {
              responseHeaders.set(name, String(value));
            }
          }
          settled = true;
          resolve(new Response(Buffer.concat(chunks), { status, headers: responseHeaders }));
        });
      },
    );
    request.on("error", fail);
    request.end();
  });
}

export async function resolvePinnedSourceFetchTarget(rawUrl: string, options: SourceFetchTransportOptions = {}): Promise<PinnedSourceFetchTarget> {
  const parsed = new URL(validateSourceUrl(rawUrl));
  const hostname = normalizeOpenWikiHost(parsed.hostname);
  const numericIpv4 = parseOpenWikiIPv4Literal(hostname);
  if (hostname.includes(":") || numericIpv4 !== undefined) {
    const address = numericIpv4 === undefined ? hostname : openWikiIPv4ToDotted(numericIpv4);
    if (isBlockedOpenWikiHost(address)) {
      throw new Error(`Blocked private or metadata source URL host: ${hostname}`);
    }
    return { parsed, hostname, address, hostHeader: parsed.host };
  }
  const lookup: SourceFetchDnsLookup = options.lookup ?? ((name, lookupOptions) => dns.lookup(name, lookupOptions) as Promise<Array<{ address: string; family: number }>>);
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new Error(`Source URL host did not resolve: ${hostname}`);
  }
  for (const address of addresses) {
    if (isBlockedOpenWikiHost(address.address)) {
      throw new Error(`Blocked private or metadata source URL resolved address: ${address.address}`);
    }
  }
  const address = addresses[0];
  if (!address) {
    throw new Error(`Source URL host did not resolve: ${hostname}`);
  }
  return { parsed, hostname, address: address.address, hostHeader: parsed.host };
}

/** Validate and normalize user-provided source URLs before connector fetches. */
export function validateSourceUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid source URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported source URL protocol: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("Source URL credentials are not allowed");
  }
  parsed.hash = "";
  const hostname = normalizeOpenWikiHost(parsed.hostname);
  if (isBlockedOpenWikiHost(hostname)) {
    throw new Error(`Blocked private or metadata source URL host: ${hostname}`);
  }
  return parsed.toString();
}
