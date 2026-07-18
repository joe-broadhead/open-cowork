# Distribution

The first public release supports source checkouts, a generated CLI artifact,
container images, and static export output. Until the tagged release publishes
to npm and GHCR, use the source-checkout tarball path and local Docker builds.

## Supported Channels

| Channel | Status | Contract |
| --- | --- | --- |
| Source checkout | Supported | Clone the repository, install with pnpm, run validation, and use contributor source-runner commands from the contributing docs. |
| npm CLI package | Release-candidate artifact | `@openwiki/cli` is generated as a bundled package with the stable `openwiki` binary. Before publication, install `./artifacts/npm/openwiki-cli-0.0.0.tgz`; after publication, pin `@openwiki/cli@0.0.0`. |
| Docker image | Release-candidate image path | Before publication, build locally. After publication, pull the GHCR digest listed in the release notes and pin that digest in deployments. |
| Static export | Supported output | Generated sites are deployable to GitHub Pages or any static host. |
| npm library packages | Not released | Internal package APIs can change until an explicit library compatibility policy exists. |
| Homebrew or native package manager | Deferred | Do not ship before npm CLI release evidence is stable. A formula can be added later by this project or by the community. |

## CLI Package Contract

The generated CLI package is rooted at `packages/cli/dist` and contains:

- `openwiki.js` with the `openwiki` binary entrypoint
- web assets needed by `serve` and static rendering helpers
- the OpenCode integration pack used by `openwiki integrate opencode`
- protocol schemas, template reference files, generated reference docs, license,
  and build metadata for installed-package self-checks
- a narrow package manifest with `files`, `bin`, `types`, and npm provenance
  publish settings

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

After the public package is published, the exact user install command is:

```sh
npm install -g @openwiki/cli@0.0.0
openwiki --version
openwiki self-check
```

For a project-local install:

```sh
npm install --save-dev @openwiki/cli@0.0.0
npx openwiki version --check
npx openwiki setup personal ./wiki --agent opencode --tools proposal
```

For one-off use without adding a dependency:

```sh
npm exec --package @openwiki/cli@0.0.0 -- openwiki version --check
```

Install shell completions from the packaged binary:

```sh
openwiki completion zsh > "${fpath[1]}/_openwiki"
openwiki completion bash > ~/.local/share/bash-completion/completions/openwiki
openwiki completion fish > ~/.config/fish/completions/openwiki.fish
```

Check the installed version and upgrade command without scraping release notes:

```sh
openwiki version --check
```

Upgrade and rollback:

```sh
openwiki backup create --verify
npm install -g @openwiki/cli@0.0.0
openwiki self-check
openwiki doctor --profile personal

# rollback to a known version if the smoke checks fail
npm install -g @openwiki/cli@0.0.0
```

Uninstall:

```sh
npm uninstall -g @openwiki/cli
```

Publishing should use npm provenance from CI or an equivalent release
environment; do not publish the monorepo workspace package directly.

The tagged `OpenWiki Release Validation` workflow is the canonical publish
path. It smoke-tests the generated tarball, uploads it as `openwiki-npm-package`,
verifies the package name and `v<version>` tag match, checks that the exact
version is not already present on npm, verifies the npm trusted publishing client
version, runs `npm publish --dry-run`, and then publishes that same tarball from
the protected `npm-release` environment. Configure `@openwiki/cli` on npm with a
trusted publisher for GitHub Actions: repository `joe-broadhead/open-wiki`,
workflow filename `openwiki-release.yml`, environment `npm-release`, and allowed
action `npm publish`. Trusted publishing generates npm provenance automatically
when the repository and package are public.

The package content is intentionally allowlisted. It must not include
`node_modules`, live `.openwiki` state, demo databases, local caches, `.env`
files, raw service-account tokens, provider credentials, private keys, or
workspace backup artifacts.

## Versioning

The repository version is the product version. The generated CLI package,
container tags, documentation, schemas, and protocol docs should all align on
that version for a release.

Use immutable image digests for production. Treat `latest` as a convenience tag
for demos and local evaluation.

The image workflow publishes BuildKit provenance and SBOM attestations, signs
the pushed digest with keyless Cosign, creates a GitHub build provenance
attestation, and scans the smoke image with Trivy before publishing.
