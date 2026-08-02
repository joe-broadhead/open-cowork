import type { CliOptions } from "./args.ts";
import { printJson } from "./output.ts";
import { resolveRoot } from "./utils.ts";

export type DiagnosticStatus = "pass" | "warn" | "fail" | "skip";
export type DiagnosticRequirement = "skip" | "warn" | "required";

export interface DiagnosticCheck {
  name: string;
  status: DiagnosticStatus;
  message: string;
  details?: Record<string, unknown>;
}

interface DiagnosticReport {
  command: "doctor";
  status: "pass" | "warn" | "fail";
  profile?: string;
  checks: DiagnosticCheck[];
}

export function publicOriginDiagnostic(origin: string | undefined, required: DiagnosticRequirement | boolean): DiagnosticCheck {
  const requirement = requirementFrom(required);
  if (origin === undefined || origin.trim() === "") {
    return {
      name: "public-origin",
      status: requirementStatus(requirement),
      message:
        requirement === "required"
          ? "This runtime profile requires OPENWIKI_PUBLIC_ORIGIN or --public-origin."
          : requirement === "warn"
            ? "Configure OPENWIKI_PUBLIC_ORIGIN before exposing this runtime through a browser hostname."
            : "No public origin configured for this local profile.",
    };
  }
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "https:" && requirement !== "skip") {
      return { name: "public-origin", status: requirementStatus(requirement), message: "Hosted public origins must use HTTPS.", details: { origin } };
    }
    return { name: "public-origin", status: "pass", message: `Public origin is ${parsed.origin}.`, details: { origin: parsed.origin } };
  } catch {
    return { name: "public-origin", status: "fail", message: `Invalid public origin: ${origin}` };
  }
}

export function trustedHeaderDiagnostic(options: CliOptions): DiagnosticCheck {
  const enabled = options.trustHeaders || process.env.OPENWIKI_TRUST_AUTH_HEADERS === "1";
  const proxyOriginEnabled = process.env.OPENWIKI_TRUST_PROXY_ORIGIN === "1";
  const proxyOriginSecret = (process.env.OPENWIKI_TRUST_PROXY_ORIGIN_SECRET ?? process.env.OPENWIKI_TRUST_AUTH_HEADERS_SECRET ?? options.trustedHeaderSecret ?? "").trim();
  if (proxyOriginEnabled && proxyOriginSecret.length === 0) {
    return {
      name: "trusted-headers",
      status: "fail",
      message: "Trusted proxy origin requires OPENWIKI_TRUST_PROXY_ORIGIN_SECRET or OPENWIKI_TRUST_AUTH_HEADERS_SECRET.",
    };
  }
  if (proxyOriginEnabled && proxyOriginSecret.length < 16) {
    return { name: "trusted-headers", status: "fail", message: "Trusted proxy origin secret must be at least 16 characters." };
  }
  if (!enabled) {
    return proxyOriginEnabled
      ? { name: "trusted-headers", status: "pass", message: "Trusted proxy origin has a shared proxy secret configured." }
      : { name: "trusted-headers", status: "skip", message: "Trusted SSO headers are not enabled." };
  }
  const secret = options.trustedHeaderSecret ?? process.env.OPENWIKI_TRUST_AUTH_HEADERS_SECRET;
  if (secret === undefined || secret.trim() === "") {
    return { name: "trusted-headers", status: "fail", message: "Trusted auth headers require OPENWIKI_TRUST_AUTH_HEADERS_SECRET or --trusted-header-secret." };
  }
  if (secret.trim().length < 16) {
    return { name: "trusted-headers", status: "fail", message: "Trusted auth header secret must be at least 16 characters." };
  }
  return { name: "trusted-headers", status: "pass", message: "Trusted auth headers have a shared proxy secret configured." };
}

export function rateLimitDiagnostic(required: DiagnosticRequirement | boolean): DiagnosticCheck {
  const requirement = requirementFrom(required);
  const configured = process.env.OPENWIKI_RATE_LIMIT_ENABLED?.trim();
  if (configured === "0" && requirement !== "skip") {
    return { name: "rate-limits", status: requirementStatus(requirement), message: "Hosted profiles should not disable rate limits." };
  }
  if (configured === "1") {
    return { name: "rate-limits", status: "pass", message: "HTTP/MCP rate limits are explicitly enabled." };
  }
  if (requirement === "required") {
    return { name: "rate-limits", status: "pass", message: "Hosted defaults enable rate limits when runtime profile or public origin is configured." };
  }
  if (requirement === "warn") {
    return { name: "rate-limits", status: "warn", message: "Enable HTTP/MCP rate limits before exposing this runtime to untrusted networks." };
  }
  return { name: "rate-limits", status: "skip", message: "Rate limits are optional for local personal profiles." };
}

export function writeCoordinatorDiagnostic(required: DiagnosticRequirement | boolean): DiagnosticCheck {
  const requirement = requirementFrom(required);
  const coordinator = process.env.OPENWIKI_WRITE_COORDINATOR_BACKEND?.trim();
  const queue = process.env.OPENWIKI_QUEUE_BACKEND?.trim();
  const runtime = process.env.OPENWIKI_RUNTIME_BACKEND?.trim();
  if (coordinator === "postgres") {
    return { name: "write-coordinator", status: "pass", message: "Postgres write coordinator is configured." };
  }
  if (queue === "postgres" || runtime === "postgres") {
    return { name: "write-coordinator", status: "pass", message: "Postgres write coordinator is auto-selected by queue/runtime backend." };
  }
  if (requirement === "required") {
    return { name: "write-coordinator", status: "fail", message: "This runtime profile requires OPENWIKI_WRITE_COORDINATOR_BACKEND=postgres or a Postgres queue/runtime backend." };
  }
  if (requirement === "warn") {
    return { name: "write-coordinator", status: "warn", message: "Use the Postgres write coordinator before running multiple web or worker writers." };
  }
  return { name: "write-coordinator", status: "skip", message: "Local file lock coordinator is acceptable for a single local process." };
}

export function requirementFrom(value: DiagnosticRequirement | boolean): DiagnosticRequirement {
  if (value === true) {
    return "required";
  }
  if (value === false) {
    return "skip";
  }
  return value;
}

export function requirementStatus(requirement: DiagnosticRequirement): DiagnosticStatus {
  if (requirement === "required") {
    return "fail";
  }
  if (requirement === "warn") {
    return "warn";
  }
  return "skip";
}

export function summarizeDiagnosticStatus(checks: DiagnosticCheck[]): "pass" | "warn" | "fail" {
  if (checks.some((check) => check.status === "fail")) {
    return "fail";
  }
  if (checks.some((check) => check.status === "warn")) {
    return "warn";
  }
  return "pass";
}

export function printDiagnosticReport(report: DiagnosticReport, options: CliOptions): void {
  if (options.json) {
    printJson(report);
  } else {
    console.log(`OpenWiki ${report.command}: ${report.status}`);
    for (const check of report.checks) {
      console.log(`${check.status.toUpperCase().padEnd(4)} ${check.name} - ${check.message}`);
    }
  }
  if (report.status === "fail") {
    process.exitCode = 1;
  }
}

export async function resolveRootOptional(options: CliOptions): Promise<string | undefined> {
  try {
    return await resolveRoot(options);
  } catch {
    return undefined;
  }
}

export function compareSemver(actual: string, minimum: string): number {
  const actualParts = actual.split(".").map((part) => Number(part));
  const minimumParts = minimum.split(".").map((part) => Number(part));
  for (let index = 0; index < 3; index += 1) {
    const diff = (actualParts[index] ?? 0) - (minimumParts[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}
