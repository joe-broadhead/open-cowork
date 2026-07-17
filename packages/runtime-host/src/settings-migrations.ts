/**
 * Versioned settings migrations for GA (JOE-878).
 *
 * Pre-release builds fail closed on schema mismatch (see SettingsStoreLoadError).
 * GA must either migrate in place or present wipe+reauth UX before loading.
 *
 * Migration functions are pure: input is the parsed JSON object from disk;
 * output is the next schema version payload. Callers persist only after success.
 */

export const SETTINGS_MIGRATIONS: Record<number, (raw: Record<string, unknown>) => Record<string, unknown>> = {
  // v1 is the current schema — no-op identity when already at v1.
  1: (raw) => raw,
}

export type SettingsMigrationResult =
  | { ok: true, schemaVersion: number, value: Record<string, unknown>, migratedFrom: number | null }
  | { ok: false, reason: 'unsupported_version' | 'corrupt', detail: string }

/**
 * Attempt to migrate `raw` settings (must include numeric `schemaVersion`) up to
 * `targetVersion`. Unknown intermediate versions fail closed.
 */
export function migrateSettingsDocument(
  raw: unknown,
  targetVersion: number,
): SettingsMigrationResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'corrupt', detail: 'Settings document is not an object.' }
  }
  const doc = { ...(raw as Record<string, unknown>) }
  const parsedVersion = typeof doc.schemaVersion === 'number' && Number.isFinite(doc.schemaVersion)
    ? Math.trunc(doc.schemaVersion)
    : null
  if (parsedVersion === null) {
    return { ok: false, reason: 'corrupt', detail: 'Missing schemaVersion.' }
  }
  let version: number = parsedVersion
  if (version > targetVersion) {
    return {
      ok: false,
      reason: 'unsupported_version',
      detail: `Settings schema version ${version} is newer than supported ${targetVersion}.`,
    }
  }
  const migratedFrom = version === targetVersion ? null : version
  while (version < targetVersion) {
    const nextVersion: number = version + 1
    const migrate = SETTINGS_MIGRATIONS[nextVersion]
    if (!migrate) {
      return {
        ok: false,
        reason: 'unsupported_version',
        detail: `No migration path from settings schema v${version} to v${nextVersion}.`,
      }
    }
    const next = migrate({ ...doc, schemaVersion: version })
    Object.assign(doc, next)
    doc.schemaVersion = nextVersion
    version = nextVersion
  }
  return { ok: true, schemaVersion: targetVersion, value: doc, migratedFrom }
}
