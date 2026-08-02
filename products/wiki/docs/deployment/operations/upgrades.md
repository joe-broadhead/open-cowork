# Upgrades

OpenWiki upgrades are explicit source commits or GitHub release tarballs. The
CLI does not query or install from the npm registry.

## Before Upgrade

```sh
openwiki --root <wiki> doctor --profile personal --json
openwiki --root <wiki> backup create --verify --json
openwiki --root <wiki> backup rehearse --target-root <disposable-path> --json
```

Stop writers before changing the runtime. Record the source commit or tarball
checksum currently in service.

## Tarball Upgrade

```sh
npm install -g ./openwiki-cli-<new-version>.tgz
openwiki self-check
openwiki --root <wiki> doctor --profile personal --json
```

## Rollback

Stop writers, reinstall the previous known-good tarball (or check out the
previous source commit), restore only if a migration or write corrupted state,
then rebuild derived indexes and run doctor again.

Do not edit generated indexes or static output as rollback state; Git and
verified backups are canonical.
