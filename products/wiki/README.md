# Wiki (Open Cowork)

> **Monorepo partition:** this tree lives at `products/wiki` in
> [open-cowork](https://github.com/joe-broadhead/open-cowork). Workspace package
> `cowork-wiki-workspace`; packages under `@openwiki/*`; CLI bins `cowork-wiki`
> (preferred) and `openwiki` (compat). Nested `pnpm-workspace.yaml` is disabled
> (`pnpm-workspace.yaml.nested-disabled`) so the monorepo root owns workspaces.
> Import source commit is recorded in `.import-source-commit`. Path-filtered CI:
> `.github/workflows/ci-wiki.yml`. Standalone smoke:
> `node scripts/standalone-smoke.mjs` (from monorepo root:
> `pnpm smoke:wiki-standalone`). Product release workflow:
> `.github/workflows/release-wiki.yml` (`wiki@v*` tags).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node 22.22.3+](https://img.shields.io/badge/node-22.22.3%2B-brightgreen.svg?logo=nodedotjs&logoColor=white)](.nvmrc)
[![pnpm](https://img.shields.io/badge/pnpm-10.32.1-F69220.svg?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![Docs](https://img.shields.io/badge/docs-mkdocs%20material-blue.svg?logo=materialformkdocs&logoColor=white)](https://joe-broadhead.github.io/open-wiki/)

<pre>
   ____                 _       ___ __   _
  / __ \____  ___  ____| |     / (_) /__(_)
 / / / / __ \/ _ \/ __ \ | /| / / / //_/ /
/ /_/ / /_/ /  __/ / / / |/ |/ / / ,< / /
\____/ .___/\___/_/ /_/|__/|__/_/_/|_/_/
    /_/
           The knowledge substrate
           for humans and agents.
</pre>

OpenWiki is a **Git-backed, versioned, permissioned knowledge base** for
humans and agents. Teams use it to search, read, follow links, propose edits,
review history, and protect sensitive knowledge with Spaces. Git remains the
canonical ledger under the hood, while the web UI, CLI, HTTP API, MCP server,
and static export all serve the same records.

[Docs](https://joe-broadhead.github.io/open-wiki/) • [Quick Start](#quick-start) • [Protocol Spec](docs/spec/openwiki-protocol-v0.1.md) • [Architecture](docs/development/architecture.md) • [Deployment](docs/deployment/overview.md)

## What It Does

- **Keeps Git as the canonical ledger** — pages, sources, claims, proposals,
  decisions, and audit events are versioned records you can clone, diff,
  back up, and review in pull requests.
- **Searches with explainable fusion ranking** across lexical, graph,
  semantic, and governance signals, with deterministic explain output.
- **Traces every statement to evidence** through source manifests, claims,
  and citation records, so answers cite page and source IDs instead of vibes.
- **Governs writes with proposals and reviews** — agents and humans propose;
  reviewers and maintainers decide; Spaces scope who can read, propose,
  review, maintain, and administer.
- **Serves agents through scoped MCP tools** in read, proposal, and write
  tiers, with per-operation policy authorization on top of tier selection.
- **Exposes the same operations everywhere**: web UI, CLI, HTTP API
  (OpenAPI 3.1), MCP, and machine-readable static export.
- **Runs local-first and scales hosted** — SQLite and one process locally;
  Postgres, workers, and queues for teams.

## Quick Start

```sh
# From the open-cowork monorepo root:
pnpm install --frozen-lockfile
pnpm --filter cowork-wiki-workspace pack:cli
# Optional global install of the packed CLI:
# npm install -g ./products/wiki/artifacts/npm/openwiki-cli-0.0.0.tgz

pnpm --filter cowork-wiki-workspace openwiki -- setup team /tmp/openwiki-demo --title "Team Wiki"
# Or after packing: openwiki / cowork-wiki
cowork-wiki setup team /tmp/openwiki-demo --title "Team Wiki"
cowork-wiki search /tmp/openwiki-demo "team knowledge" --json
cowork-wiki export static --root /tmp/openwiki-demo --out-dir public
openwiki serve /tmp/openwiki-demo --host 127.0.0.1 --port 3030
```

Then open `http://127.0.0.1:3030`.

## Why

Knowledge systems usually split human docs, agent tools, permissions, audit
logs, and serving APIs into separate products. OpenWiki keeps them anchored to
one versioned wiki:

- humans search, read, link, propose edits, and inspect history
- Spaces define who can read, propose, review, maintain, and administer content
- agents use the same read/propose/review workflow through scoped MCP, HTTP, and CLI tools
- Git records preserve proposals, decisions, validation reports, and audit events

## Requirements

- Node.js `>=22.22.3` supported minimum; Node 24 is the primary CI and container runtime
- Git for versioned wiki storage and sync
- pnpm `11.9.0` for contributor source checkouts
- Docker for container deployment tests

## Interfaces

- **Web UI**: search, read, propose edits, review proposals, inspect history, and manage Spaces.
- **MCP server**: read, proposal, and trusted write tool modes for agents.
- **CLI**: setup, pages, proposals, Spaces, agents, sync, backup, deploy, serve, and jobs.
- **HTTP API**: the same operations for integrations and hosted deployments.
- **Static export**: public read-only HTML plus machine-readable artifacts.

## Deployment Modes

- **Static export / GitHub Pages**: safest public read-only tier.
- **Source checkout**: local development and evaluation.
- **Docker / Compose**: trusted local or team deployments.
- **Helm / Kubernetes / Terraform**: hosted starting points that need production hardening.

Hosted write-capable deployments require an explicit auth boundary. Users sign
in through an organization SSO or reverse proxy; OpenWiki receives trusted
identity headers or scoped service-account tokens. Browser write requests are
same-origin protected; public read-only deployments should use static export or
viewer-scoped serving. The hosted human and agent cookbook is in
`docs/deployment/hosted-human-agent.md`.

Do not bind a writable server to `0.0.0.0` without an auth boundary. Anonymous
HTTP requests are intentionally treated as viewer-scoped readers for trusted
private networks, so any network-reachable server can expose viewer-visible
content unless a proxy, firewall, or static export boundary is in front of it.

## Documentation

- Docs home: [joe-broadhead.github.io/open-wiki](https://joe-broadhead.github.io/open-wiki/)
- Protocol spec: [`docs/spec/openwiki-protocol-v0.1.md`](docs/spec/openwiki-protocol-v0.1.md)
- Architecture: [`docs/development/architecture.md`](docs/development/architecture.md)
- Deployment: [`docs/deployment/overview.md`](docs/deployment/overview.md)
- Operations matrix: [`docs/deployment/operations/matrix.md`](docs/deployment/operations/matrix.md)
- Dogfood and demo corpus: [`docs/guides/dogfood-and-demo-corpus.md`](docs/guides/dogfood-and-demo-corpus.md)
- Security: [`SECURITY.md`](SECURITY.md)
- Contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- Support: [`SUPPORT.md`](SUPPORT.md)
- Code of Conduct: [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)
- Release notes: [`CHANGELOG.md`](CHANGELOG.md)

Run the docs locally:

```sh
python3 -m pip install -r docs/requirements.txt
mkdocs serve
```

## Repository Layout

```text
packages/       TypeScript workspace packages
schemas/        JSON Schemas for OpenWiki protocol records
docs/           MkDocs documentation, specs, ADRs, and guides
deploy/         Docker, Compose, Helm, Kubernetes, Umbrel, and Terraform assets
integrations/   OpenCode and Open Cowork integration packs
templates/      Reference docs for code-backed starter wiki templates
examples/       Example workspaces
tests/          Node test suites and integration coverage
scripts/        UI, screenshot, eval, and scale/perf scripts
```

## Development

```sh
pnpm typecheck
pnpm test
pnpm validate
pnpm test:ui
pnpm test:ui-quality
pnpm check:bundle
pnpm eval:enterprise-demo -- --json
pnpm perf:check
```

Postgres integration tests require `DATABASE_URL`:

```sh
DATABASE_URL=postgres://openwiki:openwiki@127.0.0.1:5432/openwiki pnpm test:postgres
```

`pnpm perf:check` is the blocking 1k scale smoke. Larger non-blocking
benchmarks are available with `pnpm perf:scale:10k` and
`pnpm perf:scale:100k`.

## Release Status

OpenWiki `v0.0.0` is a public preview. Expect rapid iteration on the road to
`v0.1.0`: the protocol spec, record schemas, and adapter contracts are
stable-by-intent, while packaging, hosted deployment profiles, and enterprise
policy packs continue to evolve. Distribution channels are the source
checkout above, the tagged `ghcr.io/joe-broadhead/open-wiki` container image,
and the generated `@openwiki/cli` npm package with the stable `openwiki`
binary. The release checklist lives in
[`docs/development/release.md`](docs/development/release.md).

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request.
Public-facing changes should update docs, tests, schemas, and interface
contracts together.

## Security

Report vulnerabilities privately as described in [`SECURITY.md`](SECURITY.md).
Do not open a public issue for a suspected vulnerability.

## License

MIT. See [`LICENSE`](LICENSE).
