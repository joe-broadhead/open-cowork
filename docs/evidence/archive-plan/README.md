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

## Status

| Step | Status |
| --- | --- |
| Monorepo SoT docs + readiness script | In monorepo (this branch) |
| Freeze banners applied to private clones | Local only until maintainer pushes |
| GitHub `gh repo archive` | **Not executed** — requires explicit approval after monorepo merge + release gate |
