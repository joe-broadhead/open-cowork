import { redactSecretText as sharedRedactText } from "@open-cowork/shared";

/**
 * Standalone Gateway redaction.
 *
 * Product-stable structured markers (URL userinfo, short token=/Bearer forms,
 * record-by-key `[redacted]`) run first, then the monorepo-canonical shared
 * sanitizer covers the long tail of token families (ya29., AIza, JWT, ghp_, …).
 * This preserves internet-facing gateway contracts while preventing pattern drift
 * on the token families that used to live only in Desktop/Cloud.
 */

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
    replacement: (_match, user: string) => `://${user}:[redacted]@`,
  },
  {
    pattern: /\b(?:sk|ghp|xoxb)-[A-Za-z0-9_-]{8,}\b/g,
    replacement: "[redacted]",
  },
];

export function redactSecretText(value: string, maxLength = 2000): string {
  const structured = SECRET_TEXT_PATTERNS.reduce((text, entry) => {
    if (typeof entry.replacement === "string") return text.replace(entry.pattern, entry.replacement);
    return text.replace(entry.pattern, entry.replacement as (match: string, ...captures: string[]) => string);
  }, String(value || ""));
  // Shared sanitizer for remaining token families; honor standalone maxLength.
  return sharedRedactText(structured, maxLength);
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
