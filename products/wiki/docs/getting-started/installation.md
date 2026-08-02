# Installation

OpenWiki runs from the open-cowork source checkout or a generated CLI tarball.
Static export is the supported public publishing output. The project does not
currently publish an npm-registry package or container image.

## Requirements

- Node.js `>=22.22.3`; contributors and CI use the exact monorepo root
  `.nvmrc` version.
- pnpm `10.32.1` through Corepack for source checkout work.
- Git, because the workspace repository is canonical.

## Source Checkout

From the open-cowork repository root:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter cowork-wiki-workspace typecheck
pnpm --filter cowork-wiki-workspace test
pnpm --dir products/wiki openwiki --version
```

Use `pnpm --dir products/wiki openwiki -- <arguments>` when running the source
CLI from the repository root.

## Generated CLI Tarball

Build the same standalone artifact exercised by Wiki CI:

```sh
pnpm --filter cowork-wiki-workspace pack:cli
npm install -g ./products/wiki/artifacts/npm/openwiki-cli-0.0.0.tgz
openwiki --version
openwiki self-check
```

For a project-local install:

```sh
npm install --save-dev ./products/wiki/artifacts/npm/openwiki-cli-0.0.0.tgz
npx openwiki --version
```

Tagged `wiki@v*` releases attach the generated tarball and `SHA256SUMS` to the
matching GitHub release. Verify the checksum before installing a downloaded
asset.

## First Local Wiki

```sh
openwiki setup personal ~/openwiki-personal --agent opencode --tools proposal
openwiki --root ~/openwiki-personal doctor --profile personal
openwiki --root ~/openwiki-personal serve --host 127.0.0.1 --port 3030
```

Keep a personal server on loopback and prefer stdio MCP for local agents.

## Static Export

```sh
openwiki --root ~/openwiki-personal export static \
  --out-dir public \
  --base-url https://example.com
```

Publish the generated `public/` directory to a static host. Back up the source
Git workspace; generated files are not canonical.

## Upgrade Or Roll Back A Tarball

```sh
openwiki --root ~/openwiki-personal backup create --verify
npm install -g ./openwiki-cli-<new-version>.tgz
openwiki self-check
openwiki --root ~/openwiki-personal doctor --profile personal

# rollback
npm install -g ./openwiki-cli-<known-good-version>.tgz
```
