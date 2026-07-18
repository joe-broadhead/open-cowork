/**
 * Canonical JSON stringification shared by every module that hashes or
 * fingerprints structured values. Two variants exist because their outputs
 * feed persisted hashes/ids and must stay byte-stable:
 *
 * - `stableStringify` sorts keys with the default array sort and keeps
 *   `undefined` values (rendered as the literal `undefined`). This matches the
 *   historical copies in work-store/config/team-assignment/team-assembly and
 *   the daemon system-route payload hash; changing it would change persisted
 *   ids such as promotion scorecard ids.
 * - `stableStringifyDefined` filters `undefined` entries and sorts keys with
 *   `localeCompare`. This matches the historical environments/cli-setup
 *   fingerprint behavior, where optional/undefined config fields must not
 *   affect the fingerprint.
 *
 * Two modules keep private canonicalizers on purpose:
 *
 * - audit-ledger.ts keeps its own `canonicalize`: it canonicalizes to an
 *   object (not a string) before hashing hash-chained ledger records.
 * - blueprints.ts keeps its own `stableStringify` (`JSON.stringify` over a
 *   key-sorted clone) feeding persisted blueprintRevision sha256 hashes. Its
 *   `undefined` semantics differ from this module's (it drops undefined
 *   object properties and emits null for undefined array elements), so
 *   swapping it for either export here would silently change persisted
 *   revision hashes.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function stableStringifyDefined(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringifyDefined).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stableStringifyDefined(v)}`).join(',')}}`
}
