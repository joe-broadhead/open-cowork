# Milestone completion — Monorepo product partitions (2026-07-18)

## Linear

Milestone: **Monorepo product partitions (Gateway + Wiki)**  
All child issues JOE-898…915 (incl. 901–902, 905, 909–914) are **Done**.

## Monorepo delivery

- Branch: `milestone/monorepo-product-partitions`
- PR: https://github.com/joe-broadhead/open-cowork/pull/953
- Architecture: modular `products/{gateway,wiki}`, path CI, boundaries, soft MCP link, independent versioning
- Decoupling: package metadata + operator install docs → open-cowork only
- Audit: [milestone-audit-2026-07-18.md](./milestone-audit-2026-07-18.md)

## JOE-915 freeze / archive

| Item | Status |
| --- | --- |
| Freeze date | 2026-07-18 |
| Readiness script | pass |
| open-wiki freeze PR | merged (#49) |
| opencode-gateway freeze PR | #239 (auto-merge when checks pass) |
| Archive private repos | after PR #953 on `master` |

## Definition of done checklist

- [x] products/gateway and products/wiki build/test from monorepo
- [x] Standalone smokes + release workflows (no Electron)
- [x] Channel Gateway renamed / dual-tag OCI
- [x] Path-filtered CI; independent versioning; boundaries enforced
- [x] Docs accurate; Knowledge ≠ Wiki
- [x] Freeze dual-publish + banners/PRs
- [ ] Merge monorepo PR to `master`
- [ ] Archive private repos (post-master)
