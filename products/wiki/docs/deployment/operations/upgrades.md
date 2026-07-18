# Upgrades

## Upgrades And Rollback

For personal or local CLI installs, back up the workspace before changing the
installed package:

```sh
openwiki backup create --verify
npm install -g @openwiki/cli@latest
openwiki self-check
openwiki doctor --profile personal
```

If the post-upgrade checks fail, reinstall the previous known-good CLI version
and keep the verified backup until the workspace has passed smoke checks:

```sh
npm install -g @openwiki/cli@0.0.0
openwiki self-check
openwiki doctor --profile personal
```

Upgrade sequence:

1. Read the changelog and release notes.
2. Back up Git, Postgres, object storage, and secrets.
3. Deploy the digest-pinned image to a staging workspace clone.
4. Run migrations, full Postgres sync, lint, and smoke checks.
5. Deploy production with the same digest.
6. Watch `/readyz`, `/metrics`, recent events, and run failures.

Rollback sequence:

1. Stop workers first.
2. Roll the web deployment back to the previous digest.
3. Restore Postgres only if the migration is not backward-compatible.
4. Rebuild derived stores from Git.
5. Resume workers after queue and Git state are understood.

Do not roll back by editing generated static artifacts or derived database rows.
