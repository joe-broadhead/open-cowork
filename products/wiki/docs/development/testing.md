# Testing

Run Wiki commands from the open-cowork repository root with the exact root
`.nvmrc` Node version and pnpm `10.32.1`.

## Fast Loop

```sh
pnpm --filter cowork-wiki-workspace typecheck
pnpm --filter cowork-wiki-workspace test
```

Run one test file while iterating:

```sh
pnpm --dir products/wiki exec node --no-warnings --import tsx --test \
  tests/cli-distribution.test.ts
```

## Documentation And Generated Reference

```sh
pnpm --filter cowork-wiki-workspace docs:reference -- --check
pnpm --filter cowork-wiki-workspace docs:build
```

Regenerate reference docs intentionally with:

```sh
pnpm --filter cowork-wiki-workspace docs:reference
```

## Distribution Smoke

```sh
pnpm --filter cowork-wiki-workspace pack:cli
node products/wiki/scripts/standalone-smoke.mjs
```

This installs the tarball into a clean temporary project and proves the
packaged binary without workspace links.

## Additional Gates

```sh
pnpm --filter cowork-wiki-workspace lint
pnpm --filter cowork-wiki-workspace check:bundle
pnpm --filter cowork-wiki-workspace test:security
pnpm --filter cowork-wiki-workspace perf:check
pnpm boundaries:check
pnpm lint:dead-code
```

`test:postgres` requires an explicit disposable Postgres database. It is not
part of the default local test command.

The active release contract covers source checkout, the generated GitHub
release tarball, and static export. There is no container or provider-platform
smoke in the supported Wiki gate.
