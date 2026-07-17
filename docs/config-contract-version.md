# open-cowork.config contractVersion

**Issue:** JOE-892 (distinct from settings migration JOE-878)

## Current

`open-cowork.config.schema.json` fixes `contractVersion` as constant `1`.
Loaders reject configs that do not match.

## Upgrade policy

| Change type | Policy |
| --- | --- |
| Additive optional fields | Stay on `contractVersion: 1` when backward compatible |
| Breaking field renames/removals | Bump `contractVersion` and ship a migrator or fail-closed UX |
| Product-mode schema split | Coordinate with JOE-840; may keep one contractVersion with per-mode `$defs` |

## Multi-version story

1. Document the supported contractVersion range in release notes.
2. Prefer one-step migrators `n → n+1` in runtime-host config loaders.
3. Incompatible configs: fail closed with a message that names the file and
   supported versions; do not load partial secrets.
4. Desktop and cloud share the same contractVersion semantics for a given
   release train.

## Fail-closed UX

- Show “Config contract version N is unsupported (this build supports M)” with
  a link to upgrade docs.
- Never auto-delete `open-cowork.config.json`; operator must confirm migration
  or restore from backup.
