# GCP Terraform reference module

Reference IaC for the [GCP recipe](../README.md): the `open-cowork-cloud`
image split into Cloud Run roles (public `web`, internal always-on `worker`
and `scheduler`), Cloud SQL Postgres with PITR, a versioned GCS artifact
bucket, and Secret Manager wiring — all running as dedicated service
identities with resource-scoped grants. A separate migration identity owns DDL;
long-running services never receive `cloudsqlsuperuser`.

```bash
terraform init
terraform validate
terraform plan \
  -var project_id=PROJECT \
  -var cloud_image=REGION-docker.pkg.dev/PROJECT/REPO/open-cowork-cloud@sha256:DIGEST \
  -var vpc_self_link=projects/PROJECT/global/networks/NETWORK \
  -var vpc_subnetwork_self_link=projects/PROJECT/regions/REGION/subnetworks/SUBNET
```

The first apply intentionally leaves `deploy_runtime_services=false`. It
creates Cloud SQL, the runtime and migrator IAM principals, storage, and
secrets, but no long-running web/worker/scheduler revision. Start a private-IP
Cloud SQL Auth Proxy with automatic IAM auth while impersonating the
`migrator_service_account`, then run the pinned image's migration entrypoint:

```bash
export OPEN_COWORK_CLOUD_CONTROL_PLANE_URL="postgresql://$(terraform output -raw migrator_database_principal)@127.0.0.1:5432/open_cowork_cloud?sslmode=disable"
export OPEN_COWORK_CLOUD_RUNTIME_DATABASE_PRINCIPAL="$(terraform output -raw runtime_database_principal)"
export OPEN_COWORK_CLOUD_RUNTIME_DATABASE_ROLE="$(terraform output -raw runtime_database_role)"
node --experimental-sqlite apps/desktop/dist/cloud/open-cowork-cloud-migrate.mjs
terraform apply -var deploy_runtime_services=true # include the same reviewed variables as the first apply
```

The migration command applies the current schema, creates a non-login runtime
group role, grants only table CRUD and sequence access, installs matching
default privileges, and grants that role to the runtime IAM principal. Run it
from the immutable `cloud_image` or an exact checkout of the same commit. Do
not enable runtime services until it succeeds.

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
- **Runtime and migration authority are separate.** Web, worker, and scheduler
  share one least-privilege runtime service account because they operate on the
  same product data, object bucket, and secret set. That principal has no DDL or
  database-administration role. A distinct migrator service account receives
  `cloudsqlsuperuser` and is never attached to a long-running service.
- **Database IAM is identity-bound.** The module derives the PostgreSQL IAM
  username from its runtime service account and grants that identity Cloud SQL
  Client plus Cloud SQL Instance User; operators cannot configure a mismatched
  database principals. A digest-pinned Cloud SQL Auth Proxy 2.23 sidecar uses
  automatic IAM database authentication, private IP, and a startup gate; the
  application connects only to its local listener. Direct VPC egress through
  `vpc_self_link` and `vpc_subnetwork_self_link` is required for that private
  route. Provision private-service access first, use a subnet in `region` with
  at least a `/26`, and allow outbound TCP 443 and 3307. The proxy connection
  test receives Cloud Run's full 240-second startup allowance because Direct
  VPC establishment can exceed one minute. Every long-running role receives
  `OPEN_COWORK_CLOUD_RUN_MIGRATIONS=false`; only the reviewed one-shot migrator
  applies schema changes. Cloud SQL IAM principals use `ABANDON` deletion policy
  because users with database-role membership cannot be removed through the
  Admin API; retire both service accounts and clean up their principals during
  instance replacement.
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
- Keep `web_allow_unauthenticated=false` unless in-app OIDC and public-production
  policy have been configured and reviewed. Public invocation is opt-in.
