import { createHash } from "node:crypto";
import { isoNow } from "./ids.ts";

export type OpenWikiLogLevel = "debug" | "info" | "warn" | "error";

export interface OpenWikiLogOptions {
  enabled?: boolean;
  sink?: (entry: Record<string, unknown>) => void;
  env?: Record<string, string | undefined>;
}

export function hashOpenWikiOperationalValue(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function writeOpenWikiLog(
  entry: Record<string, unknown> & { event: string; level?: OpenWikiLogLevel },
  options: OpenWikiLogOptions = {},
): void {
  const enabled = options.enabled ?? openWikiStructuredLogsEnabled(options.env);
  if (!enabled && options.sink === undefined) {
    return;
  }
  const redacted = redactOpenWikiLogValue({
    timestamp: isoNow(),
    service: "openwiki",
    level: entry.level ?? "info",
    ...entry,
  });
  if (!isRecord(redacted)) {
    return;
  }
  if (options.sink !== undefined) {
    options.sink(redacted);
    return;
  }
  process.stderr.write(`${JSON.stringify(redacted)}\n`);
}

function openWikiStructuredLogsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.OPENWIKI_STRUCTURED_LOGS === "1";
}

function redactOpenWikiLogValue(value: unknown, key = ""): unknown {
  if (isSensitiveOpenWikiLogKey(key)) {
    return "[REDACTED]";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactOpenWikiLogValue(entry));
  }
  if (isRecord(value)) {
    const redacted: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      redacted[entryKey] = redactOpenWikiLogValue(entryValue, entryKey);
    }
    return redacted;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSensitiveOpenWikiLogKey(key: string): boolean {
  const normalized = key.toLowerCase();
  if (normalized === "token_hash" || normalized === "ip_hash" || normalized === "credential_ref") {
    return false;
  }
  return /(^|[_-])(authorization|body|cookie|credential|headers?|password|private[_-]?key|secret|token|access[_-]?key)([_-]|$)/.test(normalized);
}
