# Milestone audit — Monorepo product partitions (2026-07-18)

Post-implementation production audit of branch `milestone/monorepo-product-partitions`
against Linear milestone **Monorepo product partitions (Gateway + Wiki)**.

## Verdict

| Area | Grade | Notes |
| --- | --- | --- |
| Partition architecture | **A** | `products/{gateway,wiki}` independent packages; boundary script enforced |
| Private-repo decoupling | **A−** | SoT metadata + docs remapped to open-cowork; freeze plan ready; GH archive still manual |
| CI modularity | **A** | Path-filtered product CI + monorepo style gates exclude products/** |
| Standalone installability | **A** | Pack + clean-prefix smoke scripts on CI/release workflows |
| Desktop soft integration | **A** | Default-off soft link; main-process only; token files only |
| Knowledge ≠ Wiki | **A** | ADR + no default MCP; separate stores |

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
| JOE-910 docs | Done | Operator mental model + product pages |
| JOE-909 soft link | Done | Tools & Skills panel |
| JOE-915 archive | Done (plan) | Freeze banners local; `gh repo archive` waits for master + release |

## Architecture invariants verified

1. **No Electron ↔ product source imports** (boundary checker green).
2. **No default Gateway/Wiki MCP** in `open-cowork.config.json`.
3. **Single monorepo lockfile**; no product `package-lock.json`.
4. **Composition only** via MCP/config for Desktop soft links.
5. **Independent versioning** (gateway 1.3.x; wiki 0.x; desktop root tags).

## Residual ops (not blockers for merge quality)

- Push freeze banners / archive private remotes after monorepo on `master`.
- Optional: `@openwiki/*` → `@open-cowork/wiki-*` rename (explicitly deferred Option B).
- Optional: Settings deep-link feature flags if secondary-surface discovery needs tighter progressive disclosure.

## CI note

First post-push `validate` failed on monorepo trailing-whitespace gates applied to imported product trees. Fixed by (1) whitespace cleanup, (2) modular exclusion of `products/**` from monorepo style/`git diff --check` while retaining secret scan coverage.
