---
title: Product repo freeze and archive (Gateway + Wiki)
description: Freeze dual-publish, README redirects, and archive procedure for private opencode-gateway and open-wiki (JOE-915).
---

# Product repo freeze and archive (JOE-915)

After monorepo import, **open-cowork** is the source of truth for **Gateway**
(`products/gateway`) and **Wiki** (`products/wiki`). Private historical
repos must not receive new product development.

| Legacy private repo | Monorepo path | Preferred CLI |
| --- | --- | --- |
| [opencode-gateway](https://github.com/joe-broadhead/opencode-gateway) | `products/gateway` | `cowork-gateway` |
| [open-wiki](https://github.com/joe-broadhead/open-wiki) | `products/wiki` | `cowork-wiki` |

## Freeze policy

| Field | Value |
| --- | --- |
| **Freeze date** | **2026-07-18** |
| **Meaning** | No new features or releases ship from private default branches after this date. Bugfix only if monorepo is not yet merged to `master`; prefer monorepo patches. |
| **Import snapshots** | Gateway import commit `e57831aa…` · Wiki import commit `03f3d797…` (see `products/*/.import-source-commit`) |
| **Archive gate** | After monorepo milestone branch is on `master` **and** at least **one** successful monorepo product release workflow (or equivalent pack + standalone smoke) for each product |

Until archive:

1. Default branch on private repos stays open for emergency hotfixes only.
2. Every PR / release note on private repos must point at monorepo paths.
3. Dual-publish is **frozen**: do not cut new npm tags / GH releases from private repos for product features.

## Support matrix (where to file issues)

| Topic | File where |
| --- | --- |
| Gateway product bugs/features | Linear project **open-cowork** (team Joe); optional GH issue on **open-cowork** with label `product:gateway` |
| Wiki product bugs/features | Linear **open-cowork**; optional GH issue on **open-cowork** with label `product:wiki` |
| Desktop / Cloud / Channel Gateway | Linear **open-cowork** / GH **open-cowork** as today |
| Security | Repository root `SECURITY.md` — **not** public issues |
| Private legacy repos | **Read-only after archive**; do not open new feature issues there |

Do not use private repo issue trackers for ongoing product work after freeze.

## Docs site URLs

Monorepo public docs remain under Open Cowork MkDocs:

| Product | Monorepo docs page | Historical product docs (optional keep) |
| --- | --- | --- |
| Gateway | [Gateway](../opencode-gateway.md) (`docs/opencode-gateway.md` slug stable) | `products/gateway/docs/` deep-link in monorepo |
| Wiki | [Wiki](../openwiki.md) | `products/wiki/docs/` deep-link in monorepo |

Historical GH Pages sites (`joe-broadhead.github.io/opencode-gateway`,
`…/open-wiki`) may keep serving last frozen build. Prefer adding a top banner
on those sites (or Pages `index` redirect notice) pointing at:

- https://joe-broadhead.github.io/open-cowork/opencode-gateway/
- https://joe-broadhead.github.io/open-cowork/openwiki/

MkDocs in open-cowork keeps slug-stable pages (no rename required). Additional
redirects live in `mkdocs.yml` `plugins.redirects.redirect_maps` if slugs change later.

## npm / package deprecation

| Name | Action after public monorepo publish |
| --- | --- |
| `opencode-gateway` (if ever published) | `npm deprecate opencode-gateway@"*" "Use cowork-gateway from open-cowork monorepo products/gateway"` |
| `openwiki` / `@openwiki/cli` | Prefer dual-bin `cowork-wiki`; deprecate only if a confusing public name ships without monorepo path |
| Unpublished private packages | No npm action required until a public name exists |

Do **not** publish new major features under legacy package names after freeze.

## README banner (copy for legacy repos)

Place at the **top** of each private repo `README.md` (see also templates under
`docs/runbooks/archive-plan/`):

```markdown
> **DEVELOPMENT MOVED (frozen 2026-07-18).**
> Active development lives in the public **open-cowork** monorepo:
> - Gateway → [`products/gateway`](https://github.com/joe-broadhead/open-cowork/tree/master/products/gateway) (`cowork-gateway`)
> - Wiki → [`products/wiki`](https://github.com/joe-broadhead/open-cowork/tree/master/products/wiki) (`cowork-wiki`)
> Issues and PRs: [open-cowork](https://github.com/joe-broadhead/open-cowork) / Linear project open-cowork.
> This repository is frozen and will be archived. Do not land new features here.
```

Use the Gateway-only or Wiki-only variant from the templates so each repo links
only its monorepo path.

## Archive procedure (manual; irreversible-ish)

**Do not run archive until freeze gates pass.** Archiving is a shared GitHub
action — confirm with the maintainer before executing.

### Preflight (local)

```bash
# From open-cowork monorepo
node scripts/check-product-archive-readiness.mjs
pnpm smoke:gateway-standalone
pnpm smoke:wiki-standalone
```

### Private repo freeze commits

1. Apply README banner (templates in `docs/runbooks/archive-plan/`).
2. Optionally disable Actions workflows or add a workflow that fails with a
   monorepo pointer message.
3. Push freeze commit to private default branch (`main` / `master`).
4. Set repo description to include `MOVED: open-cowork products/...`.

### Archive on GitHub

```bash
# After maintainer approval — archives make the repo read-only
gh repo edit joe-broadhead/opencode-gateway \
  --description "MOVED → https://github.com/joe-broadhead/open-cowork/tree/master/products/gateway (archived)"
gh repo archive joe-broadhead/opencode-gateway --yes

gh repo edit joe-broadhead/open-wiki \
  --description "MOVED → https://github.com/joe-broadhead/open-cowork/tree/master/products/wiki (archived)"
gh repo archive joe-broadhead/open-wiki --yes
```

Unarchive is possible via GitHub UI/API but dual-development must not resume.

### Post-archive checklist

- [ ] Monorepo README / packaging docs still list monorepo paths only as SoT
- [ ] Linear JOE-915 Done with archive date
- [ ] No Dependabot / release automation still targeting private default branches for product ships
- [ ] Team chat note: “Gateway/Wiki only via open-cowork”

## Out of scope

- Deleting git history or private repos
- Force-pushing monorepo import history into private remotes
- Immediate archive before monorepo lands on public `master`

## Related

- [Monorepo privacy ADR](../adr/monorepo-privacy.md)
- [Product partitions ADR](../adr/product-partitions.md)
- [Packaging and product modes](../packaging-and-product-modes.md)
- Archive plan templates: `docs/runbooks/archive-plan/`
