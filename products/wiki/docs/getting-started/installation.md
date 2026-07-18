# Installation

OpenWiki runs from the source checkout, the generated CLI tarball, or the Docker
image. The first public npm package and GHCR image are release-day artifacts; do
not start with those commands until the release notes point at an exact version
and image digest.

## Requirements

- Node.js 22.22.3 or newer; Node 24 is the primary CI and container runtime
- Git, because workspace history and sync are Git-backed
- pnpm 11.9.0 when working from a source checkout
- Docker when testing container deployment

## Source Checkout

```sh
git clone https://github.com/joe-broadhead/open-wiki.git
cd open-wiki
corepack enable
corepack prepare pnpm@11.9.0 --activate
pnpm install --frozen-lockfile
pnpm validate
```

Contributor checkouts can run the source CLI as documented in
[Contributing](../development/contributing.md). User-facing examples use the
stable `openwiki` binary from the generated package.

## Release-Candidate CLI

From a source checkout, build and install the same generated CLI package that
the release workflow publishes:

```sh
pnpm pack:cli
npm install -g ./artifacts/npm/openwiki-cli-0.0.0.tgz
openwiki --version
openwiki version --check
openwiki self-check
openwiki upgrade
openwiki doctor
```

To dry-run it without a global install:

```sh
pnpm pack:cli
tmp="$(mktemp -d)"
npm install --prefix "$tmp" artifacts/npm/openwiki-cli-*.tgz
"$tmp/node_modules/.bin/openwiki" --version
"$tmp/node_modules/.bin/openwiki" self-check
```

Workspace library packages remain private; only the generated CLI package is a
distribution artifact.

## First Local Wiki Smoke

After installing the release-candidate or published CLI, run this from any clean
directory to verify the real user path:

```sh
openwiki setup personal ./openwiki-personal \
  --title "Personal OpenWiki" \
  --agent none \
  --tools proposal

openwiki --root ./openwiki-personal validate
openwiki --root ./openwiki-personal index
openwiki --root ./openwiki-personal db rebuild
openwiki --root ./openwiki-personal search "personal wiki" --json
```

Generate stdio MCP config for a local desktop agent:

```sh
openwiki --root ./openwiki-personal mcp install generic \
  --mode proposal \
  --output ./openwiki-personal.mcp.json
```

Alternatively, for OpenCode-compatible clients, including clients that can read
OpenCode-style project packs, create the wiki with agent guidance and MCP config
in one step:

```sh
openwiki setup personal ./openwiki-opencode-personal \
  --title "Personal OpenWiki" \
  --agent opencode \
  --tools proposal
```

Create a public read-only export under the workspace. `--out-dir` is
workspace-relative; absolute output paths and traversal are rejected:

```sh
openwiki --root ./openwiki-personal export static --out-dir public
```

Create and verify a local backup before relying on the wiki:

```sh
openwiki --root ./openwiki-personal backup create \
  --out-dir ./openwiki-backups \
  --verify

openwiki --root ./openwiki-personal backup restore latest \
  --out-dir ./openwiki-backups \
  --target-root /tmp/openwiki-restore-check \
  --force

openwiki --root /tmp/openwiki-restore-check validate
```

Serve locally on loopback only:

```sh
openwiki --root ./openwiki-personal serve --host 127.0.0.1 --port 3030
```

Do not expose a write-capable personal wiki server to the internet. Use static
export for public read-only publishing, or put hosted servers behind SSO,
trusted proxy header stripping, service-account tokens, and the deployment
hardening documented under `docs/deployment/`.

## Published CLI After Release

After the public npm package is published and listed in the release notes, use
the versioned package command:

```sh
npm install -g @openwiki/cli@0.0.0
openwiki --version
openwiki self-check
```

For a project-local install:

```sh
npm install --save-dev @openwiki/cli@0.0.0
npx openwiki setup personal ./wiki --agent opencode --tools proposal
```

For one-off use:

```sh
npm exec --package @openwiki/cli@0.0.0 -- openwiki version --check
```

Update and rollback:

```sh
openwiki backup create --verify
npm install -g @openwiki/cli@0.0.0
openwiki self-check
openwiki doctor --profile personal

# rollback to the previous known-good version
npm install -g @openwiki/cli@0.0.0
```

Uninstall:

```sh
npm uninstall -g @openwiki/cli
```

## Docker

```sh
docker build -t openwiki/openwiki:local .
docker run --rm -p 127.0.0.1:3030:3030 -v openwiki_data:/data/wiki openwiki/openwiki:local
```

Open `http://127.0.0.1:3030` after the container is healthy.
