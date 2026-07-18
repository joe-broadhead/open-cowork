# Milestone audit — Monorepo product partitions (2026-07-18)

Post-implementation production audit of branch `milestone/monorepo-product-partitions`
against Linear milestone **Monorepo product partitions (Gateway + Wiki)**.

## Verdict

| Area | Grade | Notes |
| --- | --- | --- |
| Partition architecture | **A** | `products/{gateway,wiki}` independent packages; boundary script enforced |
| Private-repo decoupling | **A** | SoT metadata + operator install docs remapped to open-cowork; freeze plan ready; GH archive still manual ops |
| CI modularity | **A** | Path-filtered product CI + monorepo style gates exclude products/** |
| Notices platform stability | **A** | Generator inherits esbuild companions + optional-native fallbacks (Linux/macOS parity) |
| Standalone installability | **A** | Pack + clean-prefix smoke scripts on CI/release workflows |
| Desktop soft integration | **A** | Default-off soft link; main-process only; token files only |
| Knowledge ≠ Wiki | **A** | ADR + no default MCP; separate stores |
| Modular / scalable / maintainable | **A−** | Clear package boundaries; dual-bin compat; residual historical private issue links in product history docs only |

## Issue checklist

| Issue | Status | Production notes |
| --- | --- | --- |
| JOE-899 privacy ADR | Done | Scrubbed snapshot import (not full private history) |
| JOE-900 partitions ADR | Done | Naming matrix locked |
| JOE-898 Knowledge vs Wiki | Done | Dual-track enforced |
| JOE-904 skeleton | Done | Workspace globs include products |
| JOE-903 Changesets | Done | Independent mode; product tags separate |
| JOE-902 Channel Gateway rename | Done (P1) | Dual-tag OCI window |
| JOE-905 boundaries | Done | `pnpm boundaries:check` + fixture test |
| JOE-906 Wiki import | Done | `@openwiki/*` retained; dual bin |
| JOE-907 Gateway import | Done | `cowork-gateway` dual bin; monorepo release checks |
| JOE-908 path CI | Done | ci-gateway / ci-wiki + standalone smoke |
| JOE-913 engines | Done | pnpm 10.32.1; Node ≥22.22.3 floor |
| JOE-914 smokes | Done | Clean temp install |
| JOE-912 release pipelines | Done | No Electron; tag/manual |
| JOE-910 docs | Done | Operator mental model + product pages; install paths monorepo-only |
| JOE-909 soft link | Done | Tools & Skills panel |
| JOE-915 archive | Done (plan) | Freeze banners local; `gh repo archive` waits for master + release |

## Architecture invariants verified

1. **No Electron ↔ product source imports** (`pnpm boundaries:check` green).
2. **No default Gateway/Wiki MCP** in `open-cowork.config.json` (Knowledge MCP only for wiki-like content).
3. **Single monorepo lockfile**; no product `package-lock.json`.
4. **Composition only** via MCP/config for Desktop soft links (`product-mcp-link` main-process helpers).
5. **Independent versioning** (gateway 1.3.x; wiki 0.x; desktop root tags; Changesets ignore `@open-cowork/*`).
6. **Package metadata SoT** points at `github.com/joe-broadhead/open-cowork` + `directory: products/{gateway,wiki}`.
7. **Operator install docs** clone open-cowork, not private remotes.

## Modularity / scalability / maintainability

| Concern | Implementation |
| --- | --- |
| Workspace isolation | `pnpm-workspace.yaml` globs: `products/gateway`, `products/wiki`, `products/wiki/packages/*` |
| CI fan-out | Path-filtered `ci-gateway.yml` / `ci-wiki.yml`; monorepo `validate` excludes product style |
| Release fan-out | `release-gateway.yml` / `release-wiki.yml` on product tags; no Electron |
| Boundary enforcement | `scripts/check-product-boundaries.mjs` (desktop↔products, channel-gateway↔products, wiki↔knowledge) |
| Soft integration | `packages/runtime-host` pure helpers + Desktop IPC; no product source import |
| Engine alignment | Root + products on pnpm 10.32.1 / Node ≥22.22.3 |

## Residual ops (not blockers for merge quality)

- Push freeze banners / archive private remotes after monorepo on `master` (JOE-915 maintainer gate).
- Optional: `@openwiki/*` → `@open-cowork/wiki-*` rename (explicitly deferred Option B).
- Optional: gradually rewrite Gateway runtime strings that still mention the `opencode-gateway` compat bin (dual bin remains supported).
- Historical product history docs may still cite private-repo issue numbers for provenance; operator paths must not.

## CI notes

- First post-push `validate` failed on monorepo trailing-whitespace gates applied to imported product trees. Fixed by whitespace cleanup + modular exclusion of `products/**` from monorepo style/`git diff --check`.
- Subsequent `validate` failed on platform-variant `THIRD_PARTY_NOTICES.md` (macOS vs Linux optional `@esbuild/*` / `fsevents` metadata). Fixed by platform-stable notices generation (esbuild companion inheritance, license-file fallback, committed non-registry Source preserve).
- Product CI (gateway/wiki), docs, coverage, packages, cloud-gates green on HEAD after fixes.
)
