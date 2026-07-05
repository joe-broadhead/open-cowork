import { sanitizeLogMessage } from "@open-cowork/shared";

const SECRET_KEY_PATTERN = /token|secret|password|credential|authorization|api[_-]?key/i;

const SECRET_TEXT_PATTERNS: Array<{
  pattern: RegExp;
  replacement: string | ((match: string, ...captures: string[]) => string);
}> = [
  {
    pattern: /\b(Authorization:\s*(?:Bearer|Basic)\s+)\S+/gi,
    replacement: "$1[redacted]",
  },
  {
    pattern: /(["']?authorization["']?\s*[:=]\s*["']?(?:Bearer|Basic)\s+)[^'"\s&,;}]+/gi,
    replacement: "$1[redacted]",
  },
  {
    pattern: /\b((?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]+/g,
    replacement: "$1[redacted]",
  },
  {
    pattern: /(["']?(?:token|secret|password|credential|api[_-]?key)["']?\s*[:=]\s*['"]?)[^'"\s&,;}]+/gi,
    replacement: "$1[redacted]",
  },
  {
    pattern: /:\/\/([^:\s/@]+):([^@\s/]+)@/g,
    replacement: (match, user) => `://${user}:[redacted]@`,
  },
  {
    pattern: /\b(?:sk|ghp|xoxb|occ|ocgw)-[A-Za-z0-9_-]{8,}\b/g,
    replacement: "[redacted]",
  },
];

export function redactSecretText(value: string, maxLength = 2000): string {
  const structured = SECRET_TEXT_PATTERNS.reduce((text, entry) => {
    if (typeof entry.replacement === "string") return text.replace(entry.pattern, entry.replacement);
    return text.replace(entry.pattern, entry.replacement);
  }, value);
  // Layer the shared sanitizer's comprehensive token/secret patterns — Google (ya29./AIza),
  // JWTs, AWS AKIA, GitHub ghp_/github_pat_, HuggingFace hf_, Databricks dapi, etc. — that this
  // internet-facing gateway's local list was missing (its "ghp-" arm did not even match ghp_).
  return sanitizeLogMessage(structured).slice(0, maxLength);
}

export function redactSecretRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [
    key,
    redactSecretValue(key, value),
  ]));
}

function redactSecretValue(key: string, value: unknown): unknown {
  if (SECRET_KEY_PATTERN.test(key)) return "[redacted]";
  if (typeof value === "string") return redactSecretText(value);
  if (Array.isArray(value)) return value.map((entry) => redactSecretValue(key, entry));
  if (value && typeof value === "object") return redactSecretRecord(value as Record<string, unknown>);
  return value;
}
