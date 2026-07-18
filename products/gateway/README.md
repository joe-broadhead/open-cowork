# Gateway (Open Cowork)

> **Monorepo partition:** this tree lives at `products/gateway` in
> [open-cowork](https://github.com/joe-broadhead/open-cowork). Package name
> `cowork-gateway`; CLI bins `cowork-gateway` (preferred) and
> `opencode-gateway` (compat shim). Import source commit is recorded in
> `.import-source-commit`. Path-filtered CI: `.github/workflows/ci-gateway.yml`.
> Standalone smoke: `node scripts/standalone-smoke.mjs` (from monorepo root:
> `pnpm smoke:gateway-standalone`). Product release workflow:
> `.github/workflows/release-gateway.yml` (`gateway@v*` tags).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node 22.13+ / 23.4+](https://img.shields.io/badge/node-22.13%2B%20%7C%2023.4%2B-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docs](https://img.shields.io/badge/docs-mkdocs%20material-blue.svg?logo=materialformkdocs&logoColor=white)](https://joe-broadhead.github.io/opencode-gateway/)

<pre>
   ______      __
  / ____/___ _/ /____ _      ______ ___  __
 / / __/ __ `/ __/ _ \ | /| / / __ `/ / / /
/ /_/ / /_/ / /_/  __/ |/ |/ / /_/ / /_/ /
\____/\__,_/\__/\___/|__/|__/\__,_/\__, /
                                  /____/
           Durable work coordination
              for OpenCode agents.
</pre>

OpenCode Gateway is a **local durable work coordinator for OpenCode**. It
gives OpenCode agents persistent Initiatives and Issues, a scheduler with
capacity admission and human-loop gates, channel bindings for Telegram, a
Mission Control dashboard, and deterministic MCP control tools — without
creating a second agent runtime. OpenCode keeps owning sessions, agents,
skills, tools, permissions, and model execution; Gateway owns the durable
work that outlives any one session.

[Docs](https://joe-broadhead.github.io/opencode-gateway/) • [Operator Mental Model](docs/getting-started/operator-mental-model.md) • [Quickstart](docs/getting-started/quickstart.md) • [Architecture](docs/concepts/architecture.md) • [Decision Log](docs/history/decision-log.md)

## What It Does

- **Keeps work durable** — Initiatives (roadmaps) and Issues (tasks) with
  dependencies, pipelines, completion proposals, and run history live in
  local SQLite and survive restarts, crashes, and session churn.
- **Schedules agent runs deliberately** — capacity admission, backpressure,
  per-profile budgets (tokens, cost, runtime), retry limits, worker leases
  with write-fencing, stale-worker recovery, and an emergency stop.
- **Keeps humans in the loop** — pipeline-stage human gates, and OpenCode's
  own permission and question prompts routed out to your channel and back.
- **Runs agent teams** — named scheduler profiles (model, agent, skills,
  permissions, budgets), team propose → validate → apply → bind lifecycles,
  assignment receipts, blueprints, and eval-driven promotion scorecards.
- **Manages OpenCode assets over MCP** — list, upsert, and delete OpenCode
  agents, skills, tools, and MCP servers; inspect and abort sessions.
- **Bridges channels truthfully** — Telegram commands, presence, and
  trusted-sender gating route into linked OpenCode sessions; WhatsApp and
  Discord ship as deterministic adapters without live-parity claims.
- **Shows you everything** — Mission Control dashboard with live SSE,
  attention routing, alerts, operator briefing, run explanations, and a
  release-claims view backed by the claim registry.
- **Operates like a service** — doctor, readiness, health, backup/verify/
  restore, recovery drills, redacted incident bundles, audit ledger with
  retention, and service lifecycle management.

## Quick Start

```sh
git clone https://github.com/joe-broadhead/opencode-gateway.git
cd opencode-gateway
npm install
npm run build
npm link   # provides the opencode-gateway binary

# guided setup: config, OpenCode connection, service install
opencode-gateway setup

# later, pull changes and reconcile config/state/service in one step
opencode-gateway update

# start the daemon and open Mission Control
opencode-gateway start
opencode-gateway status   # prints the configured port
open http://127.0.0.1:4097/dashboard   # default port; use status if changed

# create durable work
opencode-gateway task add "Ship the weekly report"
opencode-gateway status
```

OpenCode agents get the `gateway_*` MCP tools by adding Gateway as an MCP
server — see [OpenCode Setup](docs/getting-started/opencode-setup.md).

## Product Contract

Gateway stays OpenCode-native: **OpenCode owns** sessions, agents, tools,
permissions, and model execution; **Gateway owns** the durable orchestration,
SQLite state, scheduler decisions, channel sync, and MCP control tools that
outlive any session. Channels route into linked OpenCode sessions; they do
not create a separate assistant runtime. The full boundary is canonical in
the [Product Contract](docs/concepts/product-contract.md).

## Release Status

OpenCode Gateway is a **public local beta for one trusted local operator**.
That wording is enforced, not aspirational: the claim registry defines what
may be claimed, `opencode-gateway release claims` prints it, and
`npm run release:check` fails CI on any public copy that exceeds it.
Production certification remains blocked; hosted/team, SaaS, and
multi-tenant readiness remain blocked; universal-channel readiness remains
blocked; arbitrary scale remains blocked; unattended operation remains
blocked; managed support readiness remains blocked; formal compliance
certification remains blocked. The distilled history of how each boundary
was decided is in the [Decision Log](docs/history/decision-log.md).

## Development

```sh
npm run typecheck
npm test
npm run verify        # typecheck + tests + release/claims gate
npm run release:check
npm run evidence:safety
```

## Repository Layout

```text
src/            Daemon, scheduler, work-store, channels, MCP, dashboard, CLI
src/__tests__/  Vitest behavior suites (real SQLite, temp-dir isolated)
docs/           MkDocs documentation (getting started, concepts, operations)
scripts/        Verify pipeline, release/claims gates, boundary checks
```

## Contributing

See [docs/development/contributing.md](docs/development/contributing.md).
Changes to public wording must keep `npm run release:check` green.

## License

MIT. See [LICENSE](LICENSE).
