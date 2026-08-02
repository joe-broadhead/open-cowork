# Smoke Checks

Run these from the monorepo root with the root `.nvmrc` Node version.

## Source Checkout

```sh
pnpm --filter cowork-wiki-workspace typecheck
pnpm --filter cowork-wiki-workspace test
pnpm --filter cowork-wiki-workspace docs:build
```

For a disposable local workspace:

```sh
pnpm --dir products/wiki openwiki setup personal /tmp/openwiki-smoke --agent none
pnpm --dir products/wiki openwiki --root /tmp/openwiki-smoke doctor --profile personal --json
pnpm --dir products/wiki openwiki --root /tmp/openwiki-smoke index --json
```

## CLI Tarball

```sh
pnpm --filter cowork-wiki-workspace pack:cli
node products/wiki/scripts/standalone-smoke.mjs
```

The standalone smoke installs the generated tarball into a clean temporary npm
project and exercises the packaged binary without relying on workspace links.

## Static Export

```sh
pnpm --dir products/wiki openwiki --root /tmp/openwiki-smoke export static \
  --out-dir public \
  --base-url https://example.com \
  --json
test -f /tmp/openwiki-smoke/public/index.html
test -f /tmp/openwiki-smoke/public/search-index.json
test -f /tmp/openwiki-smoke/public/static-export-report.json
```

These checks prove source, local tarball, and static-export behavior. They do
not qualify a container or hosted platform.
