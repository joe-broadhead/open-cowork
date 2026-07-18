# Contributing

Thanks for helping improve OpenWiki. This project is preparing for a public
release, so changes should keep the repository easy to audit, document, test,
and operate.

## Development Setup

```sh
corepack enable
corepack prepare pnpm@11.4.0 --activate
pnpm install --frozen-lockfile
pnpm validate
```

Contributor checkouts can run the source CLI with `pnpm openwiki -- ...`. Public
user docs should use the packaged `openwiki` binary unless they are explicitly
describing source checkout development.

Requirements:

- Node.js `>=22.22.3` (Node 24 recommended)
- pnpm `11.4.0`
- Git
- Docker for deployment/image changes
- Python 3.12 for docs builds

## Common Commands

```sh
pnpm typecheck
pnpm test
pnpm validate
pnpm docs:build
pnpm docs:reference -- --check
pnpm build:web
pnpm test:ui
pnpm test:ui-quality
pnpm check:bundle
```

Docs:

```sh
python3 -m pip install -r docs/requirements.txt
pnpm docs:build
python3 -m mkdocs serve
```

If `pnpm`, `npm`, `gh`, or Python console scripts are installed outside the
default shell path, add that directory before running gates. On Homebrew macOS
installs this is commonly `/opt/homebrew/bin`.

Postgres integration:

```sh
DATABASE_URL=postgres://openwiki:openwiki@127.0.0.1:5432/openwiki pnpm test:postgres
```

## Code Standards

- Preserve strict TypeScript.
- Do not add `any`, `@ts-ignore`, or non-null assertions as shortcuts.
- Keep Git, filesystem, network, and shell boundaries explicit and tested.
- Prefer package-local helpers before adding broad shared utilities.
- Keep public behavior stable unless the issue explicitly calls for a contract change.

## Documentation Standards

- Public features need docs under `docs/`.
- Interface changes should update CLI, HTTP, MCP, OpenAPI, and static export references where relevant.
- Run `pnpm docs:reference` after changing CLI help, MCP tools, operations,
  JSON schemas, package manifests, or error model entries.
- Schema changes should update JSON Schemas, fixtures, and validation tests together.
- Deployment changes should update the relevant deployment docs and tests.

## Pull Request Checklist

- [ ] The change is scoped to one issue or a small related set.
- [ ] `pnpm validate` passes.
- [ ] `pnpm docs:build` passes when docs are affected.
- [ ] `pnpm docs:reference -- --check` passes when public references are affected.
- [ ] Docs are updated for public behavior changes.
- [ ] Tests cover new behavior or risk.
- [ ] Security-sensitive changes explain the trust boundary.
- [ ] Deployment changes have render/smoke coverage where practical.
- [ ] Schemas and examples stay in sync.

## Security

Do not disclose vulnerabilities in public issues or discussions. Follow
`SECURITY.md`.
