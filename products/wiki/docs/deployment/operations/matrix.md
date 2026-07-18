# Operations Matrix

This matrix is the production operations contract for OpenWiki deployment
profiles. Git remains the canonical wiki ledger in every profile. SQLite,
Postgres, object storage, static export output, queues, metrics, and rendered
HTML are serving or runtime layers and must either be backed up separately or
rebuilt from Git.

## Support Classes

| Class | Meaning | Operator expectation |
| --- | --- | --- |
| Supported | Product-supported for the described trust boundary. | Copy-paste docs and preflight checks should work with normal local prerequisites. |
| Supported private profile | Safe for private networks or trusted hosts. | Add an SSO/reverse-proxy boundary before public write exposure. |
| Supported enterprise profile | Intended for sensitive multi-team deployments. | Use digest-pinned images, external stores, backups, metrics, and restore drills. |
| Supported cloud reference | Validated starting point for a cloud provider. | Review provider storage semantics, auth boundary, secret store, and backup policy before production. |
| Preview/demo | Useful for demos or read-mostly review paths. | Do not treat as a production writable Git backend without extra filesystem validation. |

## Profile Matrix

| Profile | Support | Git backup and sync | Postgres | Object storage | Secrets and token rotation | Health, logs, and metrics | Failure and recovery |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `local-personal` | Supported | Private Git remote through `openwiki sync connect git` plus `openwiki sync now`; optional local workspace backups. | Not required; rebuild SQLite/search with `openwiki index` and `openwiki db rebuild`. | Local by default; if cloud backups are configured, credentials stay in environment variables. | Rotate local service-account tokens with `openwiki auth token rotate`; replace Git deploy keys or PATs in the user's credential store. | Loopback `/livez` and `/readyz`, `openwiki run lint --json`, local process logs. | Stop local agents, restore into a temporary path with `openwiki backup rehearse`, run lint/index, then promote. |
| `local-team` | Supported private profile | Shared private Git remote; require one writer at a time unless a hosted coordinator is configured. | Optional; use Postgres before multiple web/worker processes. | Optional S3/GCS/MinIO/rclone destinations with env-backed secrets. | Rotate SSO/proxy shared secret and service tokens on the host; keep raw values out of `openwiki.json`. | Private `/readyz`, `/metrics`, request logs when exposed beyond localhost. | Freeze writes, reconcile Git, restore workspace and optional Postgres/object storage, then rebuild derived stores. |
| `docker-private` | Supported private profile | Docker volume or host path plus private Git remote; optional sync sidecar. | Compose includes Postgres for read/search/queue/write coordination when enabled. | Optional MinIO profile or external bucket; publish MinIO ports only for admin work. | Rotate Compose env files, Docker secrets, Git credentials, and OpenWiki tokens; restart affected services. | Compose health checks, `/readyz`, `/metrics`, structured logs from `openwiki`, worker, sync, and backup services. | Stop worker first, restore wiki volume, Postgres, object storage, and secrets into new volumes, verify `/readyz`, then resume traffic. |
| `hosted-enterprise` | Supported hosted profile | Persistent POSIX Git workspace plus private Git remote; prove write coordination before multiple replicas. | Required for reads, search, queue, operational state, rate limiting, MCP sessions, and write leases. | Required for attachments, captures, backups, and restore evidence; keep bucket versioning enabled. | Rotate hosted platform secrets, trusted proxy secret, Git credentials, and service-account tokens; roll every web and worker replica. | Multi-replica `/readyz`, `/metrics`, structured logs with request IDs, queue depth, write-lease contention, and MCP session checks. | Pause ingress writes, stop workers, restore workspace/Git/Postgres/object storage/secrets, run migrations and `db sync-postgres`, then run hosted readiness evidence before traffic resumes. |
| `kubernetes-enterprise` | Supported enterprise profile | Persistent volume plus private Git remote; use Postgres write coordination for web and workers. | Managed Postgres recommended for reads, search, queue, operational state, and write leases. | Provider object storage or MinIO; back up buckets with versioning/replication. | Rotate Kubernetes or provider secrets, trusted proxy secret, and service tokens; roll deployments after secret changes. | Readiness/liveness probes, Prometheus scrape per replica, Grafana dashboard, structured logs with request IDs. | Scale workers to zero, pause ingress writes, restore PV/Git/object storage/Postgres/secrets, run migrations and `db sync-postgres`, verify MCP smoke. |
| `aws-ecs-efs` | Supported cloud reference | EFS-backed Git workspace plus private Git remote; enable EFS backups. | Use RDS/Aurora with PITR/WAL where available. | Use S3 versioning, lifecycle policies, and replication for captures/backups. | Rotate Secrets Manager values, Git deploy keys, ALB/OIDC config, and service-account tokens. | ALB target health, `/readyz`, ECS service events, CloudWatch logs, Prometheus-compatible scrape through an internal path. | Shift ALB traffic or pause writes, restore EFS/RDS/S3/secrets, deploy previous task definition digest, rebuild and smoke. |
| `gcp-gke` | Supported cloud reference | GKE PV or file share with POSIX Git semantics plus private Git remote. | Use Cloud SQL with backups/PITR for runtime state. | Use GCS bucket versioning/replication; do not use Cloud Storage FUSE as production mutable Git storage. | Rotate Secret Manager/Kubernetes secrets, Workload Identity bindings, proxy secrets, and OpenWiki tokens. | GKE readiness, Cloud Logging, managed Prometheus or Prometheus scrape, dashboard import from `deploy/observability`. | Restore PV/Git/Cloud SQL/GCS/secrets in a staging namespace, run derived-store rebuilds, verify `/readyz` and MCP read smoke. |
| `cloud-run-readmostly` | Preview/demo | Treat Git remote as canonical; Cloud Run storage is suitable only for read-mostly or externally validated POSIX-backed writes. | Use managed Postgres only if the deployment has a durable writable workspace. | Use GCS for artifacts/backups, not as the live Git filesystem unless POSIX semantics are proven. | Rotate Secret Manager values, IAP or gateway config, and service tokens. | Cloud Run revision health, `/readyz`, request logs, and platform metrics. | Route traffic to the previous revision, restore Git and external stores, audit Git integrity before accepting new writes. |
| `umbrel` | Supported private appliance | Umbrel app data volume plus optional private Git remote. | Usually not required; restore runtime state if an external database is configured. | Local backups under app data or user-managed MinIO/NAS. | Rotate Umbrel/Docker env secrets and OpenWiki tokens; keep remote agent tokens scoped. | `/livez`, `/readyz`, `/mcp-manifest.json`, container logs. | Restore app data/wiki volume, backups, optional object storage and database, run `openwiki index` and `openwiki db rebuild`. |
| `public-static` | Supported read-only | Source Git repository is the backup; generated `public/` output is disposable. | Not used. | Static host artifacts only; regenerate from Git. | Rotate CI deploy tokens and static host credentials. | Static host checks for `index.html`, `search-index.json`, `graph.json`, and `static-export-report.json`. | Roll back source Git or redeploy the previous static artifact; do not patch generated files as source of truth. |

## Rotation Checklist

| Secret or credential | Rotate with | Evidence to keep |
| --- | --- | --- |
| OpenWiki service-account token | `openwiki auth token rotate <principal>` then update the MCP client or integration secret. | Token id, principal, scopes/profile, expiry, and the deployment that consumed it. Never keep the raw token in the evidence bundle. |
| Trusted proxy secret | Replace `OPENWIKI_TRUST_AUTH_HEADERS_SECRET` or `OPENWIKI_TRUST_PROXY_ORIGIN_SECRET` in the platform secret store and roll web pods/tasks. | Secret version and rollout id. |
| Git deploy key or PAT | Replace the value in the platform credential store; run `openwiki sync check-remote --json`. | Remote URL, branch, check timestamp, and success result. |
| Object storage key | Rotate provider IAM/key material; keep the same `OPENWIKI_SECRET_*` env name when possible. | Backup verify result after rotation. |
| Postgres password or IAM binding | Rotate provider credential, update `OPENWIKI_DATABASE_URL`, run migrations and `db check --json`. | Database backup status, migration result, and readiness result. |
| CI/deployment token | Rotate in GitHub Actions, cloud build, or static host secrets. | Release workflow run or deployment id. |

## Evidence Standard

Before a public release candidate or enterprise rollout, keep these artifacts
with the deployment ticket:

```sh
pnpm release:evidence
pnpm smoke:kubernetes
openwiki --root /data/wiki deploy preflight --deploy-profile <profile> --json
openwiki --root /data/wiki backup rehearse --destination <id> --target-root /tmp/openwiki-restore --json
pnpm backup:postgres:restore-drill -- \
  --database-url "$OPENWIKI_DATABASE_URL" \
  --restore-database-url "$OPENWIKI_RESTORE_DATABASE_URL" \
  --workspace-root /data/wiki \
  --dry-run \
  --json
```

`pnpm release:evidence` writes `artifacts/openwiki-release-evidence.json` and a
deployment evidence bundle under `artifacts/deployment/`. It records Compose,
Helm, Kustomize, and Terraform render or validation attempts when those tools
are installed, and records an explicit `tool_unavailable` status otherwise so
the missing evidence is visible rather than silent.
The release workflow runs the same script in strict mode after installing the
required deployment-rendering tools, so missing Helm/Kustomize/Terraform
evidence fails the release train instead of producing a partial bundle.
