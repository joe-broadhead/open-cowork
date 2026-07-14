# GCP Terraform reference module

Reference IaC for the [GCP recipe](../README.md): the `open-cowork-cloud`
image split into Cloud Run roles (public `web`, internal always-on `worker`
and `scheduler`), Cloud SQL Postgres with PITR, a versioned GCS artifact
bucket, and Secret Manager wiring — all running as a dedicated service
account with resource-scoped grants.

```bash
terraform init
terraform validate
terraform plan \
  -var project_id=PROJECT \
  -var cloud_image=REGION-docker.pkg.dev/PROJECT/REPO/open-cowork-cloud@sha256:DIGEST \
  -var vpc_self_link=projects/PROJECT/global/networks/NETWORK \
  -var vpc_subnetwork_self_link=projects/PROJECT/regions/REGION/subnetworks/SUBNET
```

Notes:

- **Reference, not a managed product.** Files are syntax-checked in this
  repo; run `terraform validate` + review the plan against your project
  before applying. Real project ids, image tags, domains, and secret values
  belong in a private deployment repo. The module requires Google provider
  7.18 or newer within the 7.x line because that is the first release with
  managed Cloud SQL database-role assignments. The committed provider lock
  covers Linux amd64/arm64 and macOS arm64; refresh it deliberately with
  `terraform providers lock` when upgrading the provider.
- **Application images are immutable.** `cloud_image` rejects tags and accepts
  only a fully qualified `@sha256:` reference, keeping every Cloud Run revision
  reproducible and reviewable.
- **Secrets stay in Secret Manager.** `secret_env` maps env var names to
  secret ids (e.g. `OPEN_COWORK_CLOUD_SESSION_SECRET`); values never enter
  Terraform state. Injected secrets automatically receive accessor IAM;
  `secret_ids` is only needed for secrets the runtime fetches without direct
  environment injection.
- **The shared runtime identity is a documented reference limitation.** This
  module uses one service account for all three roles, so that principal has
  bucket Object Admin and `cloudsqlsuperuser`. Do not carry that layout into a
  managed multi-tenant deployment. First bootstrap app-specific PostgreSQL
  group roles and `ALTER DEFAULT PRIVILEGES` with a separate migration identity;
  then give web, worker, and scheduler distinct service accounts/IAM database
  users and only their required database and bucket grants. A Google-only
  Terraform module cannot safely create those in-database roles, and assigning
  `cloudsqlsuperuser` to every runtime identity would only multiply privilege.
- **Database IAM is identity-bound.** The module derives the PostgreSQL IAM
  username from its runtime service account and grants that identity Cloud SQL
  Client plus Cloud SQL Instance User; operators cannot configure a mismatched
  database principal. A digest-pinned Cloud SQL Auth Proxy 2.23 sidecar uses
  automatic IAM database authentication, private IP, and a startup gate; the
  application connects only to its local listener. Direct VPC egress through
  `vpc_self_link` and `vpc_subnetwork_self_link` is required for that private
  route. Provision private-service access first, use a subnet in `region` with
  at least a `/26`, and allow outbound TCP 443 and 3307. The proxy connection
  test receives Cloud Run's full 240-second startup allowance because Direct
  VPC establishment can exceed one minute. Because this module creates a
  dedicated database instance and the app runs its own schema migrations, that
  identity receives Cloud SQL's `cloudsqlsuperuser` database role; do not share
  the instance with unrelated applications. Cloud SQL cannot delete PostgreSQL
  users while database roles remain assigned, so Terraform abandons this IAM
  database principal when its resource is removed; retire the service account
  and clean up the principal deliberately during instance replacement.
- **Database availability is production-first.** PostgreSQL 17 is provisioned
  explicitly as Cloud SQL Enterprise edition to match the configurable
  `db-custom-*` tier. Regional high availability is enabled so a zonal outage
  can fail over automatically, and deletion protection is enforced in both
  Terraform and the Cloud SQL API. Cloud SQL charges for both the primary and
  standby capacity. Use a separate non-production module rather than weakening
  this reference to zonal availability.
- **Database recovery and diagnostics are explicit.** Daily backups begin at
  02:00 UTC, fourteen backups and seven days of transaction logs are retained,
  and stable-track maintenance runs Sunday at 04:00 UTC. Query Insights records
  bounded query text, plans, and application tags without client addresses.
- **Artifact storage is private.** Uniform bucket-level access and public
  access prevention are enforced, object versioning is enabled, and Terraform
  refuses to force-delete a non-empty bucket.
- **Workers are pinned, not autoscaled** — they hold OpenCode sessions.
  Scale `worker_instances` deliberately. Worker and scheduler containers use
  instance-based CPU allocation so their background loops keep running without
  incoming HTTP requests.
- **Health probes are role-specific.** Web startup waits for dependency
  readiness on `/readyz`; worker and scheduler start a dedicated heartbeat
  listener on port `8787` and use `/livez`, because those roles do not expose
  the Cloud web/API server.
- **SSE**: web revisions drain gracefully; clients re-attach and replay from
  their cursor, so `web_max_instances > 1` is safe.
- Run migrations (`cloud:migrate:start`) as a Cloud Run job or one-off
  execution against the same image before first boot.
