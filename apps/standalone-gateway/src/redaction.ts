import { redactSecretRecord as sharedRedactRecord, redactSecretText as sharedRedactText } from "@open-cowork/shared";

/**
 * Standalone Gateway redaction — thin wrappers over the monorepo-canonical
 * secret redaction API (audit 2026-07-18). Local pattern forks were removed
 * so token coverage cannot drift from Desktop/Cloud.
 */
export function redactSecretText(value: string, maxLength = 2000): string {
  return sharedRedactText(value, maxLength);
}

export function redactSecretRecord(input: Record<string, unknown>): Record<string, unknown> {
  return sharedRedactRecord(input);
}
