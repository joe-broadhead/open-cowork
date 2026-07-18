# cloud-run-readmostly

This profile is preview/demo/read-mostly. It is useful for small hosted demos,
preview environments, and read-mostly review surfaces. It is not the recommended
enterprise writable Git path unless `/data/wiki` is backed by a proper POSIX
filesystem.

## Quickstart

```sh
cd deploy/terraform/gcp
cp backend.tf.example backend.tf
terraform init
terraform apply -var='project_id=my-project'
```

## Preflight

```sh
OPENWIKI_RATE_LIMIT_ENABLED=1 \
openwiki --root /data/wiki deploy preflight \
  --deploy-profile cloud-run-readmostly \
  --public-origin https://wiki.example.com \
  --image ghcr.io/joe-broadhead/open-wiki@sha256:<digest>
```

## Security Notes

- Cloud Storage FUSE is not POSIX Git storage and must not be presented as the
  production writable Git recommendation.
- Use Cloud Run/IAP or private ingress for browser access.
- Keep `allow_unauthenticated=false` unless the service is intentionally
  read-only or protected elsewhere.

## Readiness Checks

```sh
curl --fail https://<cloud-run-url>/livez
curl --fail https://<cloud-run-url>/readyz
gcloud run services describe openwiki --region <region>
```

## Backup And Restore

Back up Git separately. Treat Cloud Storage volume contents as deployment state,
not as the sole canonical backup. Move write-heavy deployments to GKE, a VM, or
another runtime with a normal filesystem. For any write-capable hosted variant,
follow the hosted restore order in [Backup Restore](../operations/backup-restore.md):
Git workspace, object storage, Postgres, derived stores, service secrets, then
`/readyz` and MCP smoke.

## Rollback

Route traffic to the previous Cloud Run revision, restore Git from the canonical
remote, and regenerate derived stores. If writes were enabled against Cloud
Storage FUSE, audit Git integrity before accepting new proposals.

## MCP

Use service-account bearer tokens for HTTP MCP only when the service is private
or behind IAP. For public demos, prefer static export or read-only tools.
For remote inbox submitters and proposal-mode team agents, follow
[Hosted Inbox Agents](../../guides/hosted-inbox-agents.md) and keep writable Git
on a POSIX filesystem.
