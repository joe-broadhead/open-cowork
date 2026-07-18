# Umbrel

Use this for a personal or home-lab OpenWiki appliance where the Umbrel app
manager owns container lifecycle and local storage.

## Quickstart

Review `deploy/umbrel/umbrel-app.yml` and `deploy/umbrel/docker-compose.yml`,
then install the app through Umbrel's app workflow. Pin the OpenWiki image tag
or digest before publishing an app-store update.

## Security Notes

- Treat Umbrel as a local/private deployment, not a public write-capable hosted
  profile.
- Keep agent access local unless a trusted reverse proxy and service-account
  token policy are configured.
- Back up the Git workspace volume and the local backup artifact directory
  before upgrading the app.

## Operations

Use the same readiness probes as Docker deployments: `/livez`, `/readyz`,
and `/mcp-manifest.json`.

Backup artifacts are stored under `${APP_DATA_DIR}/data/backups` and the live
Git-backed workspace is stored under `${APP_DATA_DIR}/data/wiki`. The bundled
backup service writes immutable workspace snapshots every 24 hours to the
backup directory. For users who already run MinIO on Umbrel, configure a MinIO
destination in `runtime.backups` and keep credentials in Umbrel/Docker
environment secrets.

Restore by recovering the wiki volume first, then external object storage if
enabled, then any database/runtime state, then service secrets. Rebuild indexes
with `openwiki index` and `openwiki db rebuild` inside the container before
returning the app to trusted users. Rehearse the backup path after installation
and upgrades:

```sh
docker compose exec server \
  openwiki --root /data/wiki backup rehearse \
    --destination local-backups \
    --target-root /tmp/openwiki-restore \
    --json
docker compose exec server \
  openwiki --root /data/wiki doctor --profile personal --json
```
