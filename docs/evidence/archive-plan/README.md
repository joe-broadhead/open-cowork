# Archive plan evidence (JOE-915)

Freeze date: **2026-07-18**.

| Artifact | Purpose |
| --- | --- |
| [freeze-banner-gateway.md](freeze-banner-gateway.md) | Top-of-README banner for `opencode-gateway` |
| [freeze-banner-wiki.md](freeze-banner-wiki.md) | Top-of-README banner for `open-wiki` |
| [freeze-repo-description.txt](freeze-repo-description.txt) | Short GH description strings |
| [npm-deprecate-notes.md](npm-deprecate-notes.md) | Deprecation message text if packages publish |
| Runbook | [docs/runbooks/product-repo-archive.md](../../runbooks/product-repo-archive.md) |
| Readiness check | `node scripts/check-product-archive-readiness.mjs` |

## Status (2026-07-18)

| Step | Status |
| --- | --- |
| Monorepo SoT docs + readiness script | **Pass** (`node scripts/check-product-archive-readiness.mjs`) |
| Freeze banners on private repos | **Wiki:** merged [open-wiki#49](https://github.com/joe-broadhead/open-wiki/pull/49). **Gateway:** [opencode-gateway#239](https://github.com/joe-broadhead/opencode-gateway/pull/239) (auto-merge when required checks pass) |
| GH repo descriptions | Updated to MOVED → open-cowork `products/{gateway,wiki}` |
| GitHub `gh repo archive` | **Pending** monorepo PR merge to `master` + product smoke/release gate (maintainer) |

## Freeze PRs

| Repo | PR |
| --- | --- |
| opencode-gateway | https://github.com/joe-broadhead/opencode-gateway/pull/239 |
| open-wiki | https://github.com/joe-broadhead/open-wiki/pull/49 |

## Post-master archive commands

```bash
gh repo edit joe-broadhead/opencode-gateway \
  --description "MOVED → https://github.com/joe-broadhead/open-cowork/tree/master/products/gateway (archived)"
gh repo archive joe-broadhead/opencode-gateway --yes

gh repo edit joe-broadhead/open-wiki \
  --description "MOVED → https://github.com/joe-broadhead/open-cowork/tree/master/products/wiki (archived)"
gh repo archive joe-broadhead/open-wiki --yes
```
