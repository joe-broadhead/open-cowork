# Distribution

The current monorepo release path supports source checkouts, a generated CLI
tarball attached to a GitHub release, and static-export output. npm and
container publishing are not active.

## Supported Channels

| Channel | Status | Contract |
| --- | --- | --- |
| Source checkout | Supported | Clone the repository, install with pnpm, run validation, and use contributor source-runner commands from the contributing docs. |
| Generated CLI tarball | Release-candidate artifact | `@openwiki/cli` is the bundled package identity. Install the tarball produced by the root `CI Wiki` or `Release Wiki` workflow; it is not published to npm. |
| Static export | Supported output | Generated sites are deployable to any static host. |
| npm library packages | Not released | Internal package APIs can change until an explicit library compatibility policy exists. |

## CLI Package Contract

The generated CLI package is rooted at `packages/cli/dist` and contains:

- `openwiki.js` with the `openwiki` binary entrypoint
- web assets needed by `serve` and static rendering helpers
- the OpenCode integration pack used by `openwiki integrate opencode`
- protocol schemas, template reference files, generated reference docs, license,
  and build metadata for installed-package self-checks
- a narrow package manifest with `files`, `bin`, and `types`

Build and dry-run the package locally:

```sh
pnpm pack:cli
tmp="$(mktemp -d)"
npm install --prefix "$tmp" artifacts/npm/openwiki-cli-*.tgz
"$tmp/node_modules/.bin/openwiki" --version
"$tmp/node_modules/.bin/openwiki" version --json
"$tmp/node_modules/.bin/openwiki" self-check --json
```

For a local global install from the generated release candidate tarball:

```sh
npm install -g ./artifacts/npm/openwiki-cli-0.0.0.tgz
openwiki --version
openwiki self-check
```

For a project-local install from the generated tarball:

```sh
npm install --save-dev ./artifacts/npm/openwiki-cli-0.0.0.tgz
npx openwiki --version
npx openwiki setup personal ./wiki --agent opencode --tools proposal
```

Install shell completions from the packaged binary:

```sh
openwiki completion zsh > "${fpath[1]}/_openwiki"
openwiki completion bash > ~/.local/share/bash-completion/completions/openwiki
openwiki completion fish > ~/.config/fish/completions/openwiki.fish
```

Upgrade and rollback:

```sh
openwiki backup create --verify
npm install -g ./openwiki-cli-<new-version>.tgz
openwiki self-check
openwiki doctor --profile personal

# rollback to a known version if the smoke checks fail
npm install -g ./openwiki-cli-<known-good-version>.tgz
```

Uninstall:

```sh
npm uninstall -g @openwiki/cli
```

The root `Release Wiki` workflow is the canonical distribution path. It
smoke-tests the generated tarball and attaches it with `SHA256SUMS` to a GitHub
release. Do not publish the monorepo workspace package directly or describe the
tarball as an npm-registry release.

The package content is intentionally allowlisted. It must not include
`node_modules`, live `.openwiki` state, demo databases, local caches, `.env`
files, raw service-account tokens, provider credentials, private keys, or
workspace backup artifacts.

## Versioning

The Wiki product version, generated CLI tarball, documentation, schemas, and
protocol docs should align for a release.
