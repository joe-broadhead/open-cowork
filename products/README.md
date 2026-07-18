# Product partitions

Open Cowork is the flagship monorepo product. Sibling products live under
`products/` and keep independent installables, versions, and CI path filters.

| Path | Public name | Installable bin (target) | Status |
| --- | --- | --- | --- |
| `products/gateway` | **Gateway** (durable work coordinator) | `cowork-gateway` | Imported snapshot (JOE-907) |
| `products/wiki` | **Wiki** | `cowork-wiki` | Imported snapshot (JOE-906); packages under `products/wiki/packages/*` |

Related apps (not under `products/`):

| Path | Public name |
| --- | --- |
| `apps/desktop` | Open Cowork Desktop |
| `apps/channel-gateway` | Channel Gateway (was `apps/channel-gateway`) |
| `apps/standalone-gateway` | Standalone Gateway |

## Dependency rules

See [docs/adr/product-partitions.md](../docs/adr/product-partitions.md).

1. One-way: `@open-cowork/*` shared libs may be used by products; products do not feed shared libs.
2. No product-to-product implementation imports.
3. Compose via MCP / HTTP / config only.
4. OpenCode remains execution authority.
5. Knowledge (in-app) ≠ Wiki (this partition).

## Where new code goes

- Desktop / Cloud / Channel / Standalone surfaces → `apps/*` + `packages/*` + `mcps/*`
- Durable Gateway daemon/CLI → `products/gateway`
- Wiki CLI/web/MCP packages → `products/wiki` and `products/wiki/packages/*`
- Native third-party binaries only → `third_party/`

Do not put durable Gateway source under `apps/channel-gateway` or `@open-cowork/channel-gateway`
(those names mean **Channel Gateway**).

## Legacy private remotes (frozen)

| Private repo | Freeze | Monorepo SoT |
| --- | --- | --- |
| `opencode-gateway` | 2026-07-18 | `products/gateway` |
| `open-wiki` | 2026-07-18 | `products/wiki` |

No new features on private remotes. Archive after monorepo lands on `master` and
product release/smoke gates pass. See
[docs/runbooks/product-repo-archive.md](../docs/runbooks/product-repo-archive.md)
and `pnpm archive:readiness`.
