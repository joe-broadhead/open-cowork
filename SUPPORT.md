# Support

## Where to ask for help

Use the repository issue templates for:
- reproducible bugs
- feature requests
- packaging or configuration problems

Please include:
- platform
- Open Cowork version or commit
- provider/model in use
- whether the issue happened in a project thread or sandbox thread
- logs or screenshots with secrets removed

## Before opening an issue

Please check:
- the [README](README.md)
- the docs in [`docs/`](docs/)
- existing issues

## Security issues

For security-sensitive problems, do **not** open a public issue.

See [SECURITY.md](SECURITY.md).

## Funding

Open Cowork does not publish funding links yet. Sponsorship can be
revisited once project governance and maintenance expectations are
clearer.

## Scope

Open Cowork upstream supports:
- the generic desktop shell
- bundled MCPs and skills shipped in this repository
- config-driven provider and agent behavior
- monorepo product partitions (optional standalones):
  - **Gateway** — `products/gateway` (`cowork-gateway`)
  - **Wiki** — `products/wiki` (`cowork-wiki`)

Downstream internal distributions may add custom integrations, branding, auth, or packaging behavior that this upstream repository cannot fully support.

For downstream-specific issues, include enough context to separate:
- upstream behavior
- downstream customization

## Product partitions (Gateway + Wiki)

| Product | Source of truth | Preferred bin | File issues |
| --- | --- | --- | --- |
| Gateway | `products/gateway` in this repo | `cowork-gateway` | This repository / Linear **open-cowork** |
| Wiki | `products/wiki` in this repo | `cowork-wiki` | This repository / Linear **open-cowork** |
| Channel Gateway | `apps/channel-gateway` | OCI channel-gateway image | This repository / Linear **open-cowork** |

Private historical repos **opencode-gateway** and **open-wiki** are **frozen**
(2026-07-18) and must not receive new feature work. See
[Product repo freeze and archive](docs/runbooks/product-repo-archive.md).
