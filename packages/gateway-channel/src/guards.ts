// Shared runtime type guard for the gateway providers, which previously each carried an
// identical local copy (#925).
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
