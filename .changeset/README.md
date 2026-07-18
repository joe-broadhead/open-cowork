# Changesets

This monorepo uses [Changesets](https://github.com/changesets/changesets) in
**independent** mode for publishable product packages under `products/`
(`cowork-gateway`, `cowork-wiki` after import).

- Open Cowork Desktop/Cloud family releases continue to use the existing
  `vX.Y.Z` tag + root `CHANGELOG.md` workflow.
- Product packages under `products/` get their own semver and optional
  `gateway@…` / `wiki@…` tags (see `docs/versioning.md`).

`@open-cowork/*` workspace packages are ignored here (private; not npm-
published by default).

When you change a publishable product package:

```bash
pnpm exec changeset
```

Until Gateway/Wiki are imported, the only product stubs are private and not
published.
