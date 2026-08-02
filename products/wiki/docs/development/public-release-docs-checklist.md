# Public Release Docs Checklist

Use this checklist for a `wiki@v*` GitHub release.

## Distribution

- README and installation lead with source checkout and the generated CLI
  tarball.
- The release links the exact tarball and `SHA256SUMS` from `Release Wiki`.
- Static export is described as generated output, not canonical state.
- No npm-registry, container, hosted-capacity, or provider-platform claim is
  present without immutable evidence from an active root workflow.

## Product And Security

- The first-user path creates a personal wiki, uses proposal-mode agents,
  verifies backup/restore, and can produce a static export.
- Source-hosted guidance requires authenticated ingress, same-origin browser
  protection, scoped service-account tokens, persistent Git storage, backups,
  and shared Postgres state before multiple writers or replicas.
- Security reporting points to the private vulnerability path.

## Navigation

- MkDocs navigation contains only existing pages.
- Generated CLI, MCP, schema, package, operation, and compatibility reference is
  current.
- Removed platform documentation and historical execution logs are not linked
  as product guidance.

## Validation

```sh
pnpm --filter cowork-wiki-workspace docs:reference -- --check
pnpm --filter cowork-wiki-workspace docs:build
pnpm --filter cowork-wiki-workspace typecheck
pnpm --filter cowork-wiki-workspace test
pnpm --filter cowork-wiki-workspace pack:cli
node products/wiki/scripts/standalone-smoke.mjs
```
