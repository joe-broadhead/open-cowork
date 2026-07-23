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

## Status (revalidated 2026-07-22 post-#959)

| Step | Status |
| --- | --- |
| Monorepo SoT docs + readiness script | **Pass** (`node scripts/check-product-archive-readiness.mjs`) |
| Freeze banners on private repos | **Wiki:** merged [open-wiki#49](https://github.com/joe-broadhead/open-wiki/pull/49). **Gateway:** merged [opencode-gateway#239](https://github.com/joe-broadhead/opencode-gateway/pull/239) |
| GH repo descriptions | Updated to MOVED → open-cowork `products/{gateway,wiki}` |
| Monorepo on `master` (partition + post-#958/#959) | **Done** — product partitions and subsequent production next-steps are on `master` |
| GitHub `gh repo archive` | **Still pending maintainer ops** — not an in-repo code residual; freeze banners + SoT are done. Final `gh repo archive` for `opencode-gateway` / `open-wiki` remains an offline maintainer step when product smoke/release gate is accepted. |

**JOE-915 freeze residual (process):** freeze and monorepo SoT are complete;
only the private-repo **archive** action is stale-as-open (maintainer gate).
Do not re-open engineering work for freeze banners or SoT docs.

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
