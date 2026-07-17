# Settings migration (GA)

**Issue:** JOE-878

## Pre-release (current)

`packages/runtime-host/src/settings.ts` fails closed when `settings.json` /
`settings.enc` is not exactly `SETTINGS_SCHEMA_VERSION`. The existing file is
left untouched. Recovery: back up, delete only the settings files, reconfigure
(re-auth as needed).

## GA target

1. **Prefer in-place migrations** via
   `packages/runtime-host/src/settings-migrations.ts` (`migrateSettingsDocument`).
2. Add one pure function per new schema version under `SETTINGS_MIGRATIONS[n]`.
3. On load: if version &lt; current, migrate → write backup → persist new file.
4. If version &gt; current or migration missing: fail closed with wipe+reauth UX
   copy (never silently drop encrypted secrets).

## Recovery path (operators / support)

1. Export diagnostics if possible.
2. Back up `settings.json` / `settings.enc`.
3. Reset only those files (not the whole workspace).
4. Relaunch and complete first-run / provider auth.

## Tests

Unit-test each migration step with fixtures that include encrypted field
placeholders (do not require real secrets material).
