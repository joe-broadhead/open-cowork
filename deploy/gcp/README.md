# GCP Reference Deployment

This recipe is the first provider deployment target for Open Cowork Cloud. It
keeps GCP wiring in deploy assets and documentation; core cloud, Desktop sync,
Gateway, BYOK, billing, and projection code must stay provider-neutral.

Use this directory for reusable reference assets only. Put real project ids,
domains, image tags, and environment overlays in a private deployment repo or a
local scratch directory. Store secret values in GCP Secret Manager or KMS, not
in git.

## Deployment Repository Strategy

Use three separate working areas when proving a GCP deployment:

| Area | Purpose |
| --- | --- |
| Public `open-cowork` repo | Reference manifests, placeholder docs, redacted evidence templates, and validators. |
| Tmp/local deployment repo | Copied values files, generated manifests, raw `gcloud` output, and one-off smoke evidence during experiments. |
| Private/downstream repo | Real project ids, service accounts, domains, image digests, OIDC apps, prices, customer data, launch evidence, and private operator runbooks. |

Only generalized template fixes, portable scripts, docs, and redacted evidence
summaries should flow back to `open-cowork`. Do not paste raw provider output
into public issues or PRs. If you need evidence that can be shared publicly,
run the GCP scripts with `OPEN_COWORK_GCP_REDACT_OUTPUT=true` and start from
`smoke/evidence.template.json`.
The tmp/local deployment repo is a private scratch area, not a source of
public evidence until its outputs have been redacted and generalized.

## Recommended Topology

| Component | GCP service | Notes |
| --- | --- | --- |
| Cloud Web | GKE Deployment behind HTTPS Ingress | Stateless web/API/SSE surface. Cloud Run is acceptable for demo/all-in-one only. |
| Cloud Worker | GKE Deployment | Long-running OpenCode execution and fenced command processing. |
| Cloud Scheduler | GKE Deployment | Durable workflow claims; one replica is enough, multiple are safe. |
| Gateway | GKE Deployment or Cloud Run | Separate deployable with separate channel/provider secrets. |
| Control plane | Cloud SQL for PostgreSQL | Enable automated backups and Cloud SQL PITR. |
| Object store | Cloud Storage | Artifacts, uploads, exports, checkpoints, snapshots, diagnostics bundles. |
| Secrets | Secret Manager plus optional Cloud KMS | Cookie/internal secrets, envelope keys, OIDC secret, database URL, gateway tokens. |
| Images | Artifact Registry | `open-cowork-cloud` and `open-cowork-gateway` images. |
| Observability | Cloud Logging/Monitoring plus optional OTLP collector | JSON logs with request/session/run correlation. |

Production deployments should use the GKE split-role profile in
`gke/values.gke.yaml.example`. `cloud-run/all-in-one.service.yaml.example` is a
focused pilot profile for demos and smoke testing; it is not the scale-out
worker topology.

For teams that prefer Terraform over Helm/YAML, [`terraform/`](terraform/)
carries a syntax-checked reference module (Cloud Run split roles, Cloud SQL,
GCS, Secret Manager). Validate and plan against your own project before
applying.

## Required GCP APIs

Enable these APIs before rollout:

- `artifactregistry.googleapis.com`
- `compute.googleapis.com`
- `container.googleapis.com`
- `iam.googleapis.com`
- `iamcredentials.googleapis.com`
- `logging.googleapis.com`
- `monitoring.googleapis.com`
- `secretmanager.googleapis.com`
- `sqladmin.googleapis.com`
- `storage.googleapis.com`

Optional APIs:

- `cloudkms.googleapis.com` only when your private deployment overlay uses
  Cloud KMS directly.
- `run.googleapis.com` only when you use the Cloud Run demo profile.

Run a read-only preflight from the repo root:

```bash
OPEN_COWORK_GCP_REGION=us-central1 \
OPEN_COWORK_GCP_REDACT_OUTPUT=true \
pnpm deploy:gcp:preflight
```

The preflight checks the active `gcloud` account/project, configured region,
required APIs, and presence of the reference files. Set
`OPEN_COWORK_GCP_REQUIRE_KMS=true` to also require Cloud KMS. Set
`OPEN_COWORK_GCP_REQUIRE_CLOUD_RUN=true` or
`OPEN_COWORK_GCP_CLOUD_RUN_SERVICE=SERVICE` to also require Cloud Run. It does
not create or modify cloud resources. Omit `OPEN_COWORK_GCP_REDACT_OUTPUT`
inside a private deployment repo when operators need exact project/account
diagnostics.

## Required IAM

Use separate service accounts where possible:

- `open-cowork-cloud-web`: reads config secrets, connects to Cloud SQL, reads
  object metadata where needed.
- `open-cowork-cloud-worker`: reads BYOK/envelope/config secrets, connects to
  Cloud SQL, reads/writes Cloud Storage, executes OpenCode runtime work.
- `open-cowork-cloud-scheduler`: connects to Cloud SQL and writes scheduler
  audit/heartbeat state.
- `open-cowork-gateway`: reads channel credentials, uses a scoped cloud API
  token, writes Gateway logs/metrics.

Minimum IAM bindings:

- Cloud SQL Client for cloud roles that connect through Cloud SQL.
- Secret Manager Secret Accessor for the exact secrets each role needs.
- Storage Object Admin on the Open Cowork bucket for worker roles; narrower
  reader/writer roles can be split later.
- Logs Writer and Monitoring Metric Writer for runtime telemetry.
- Workload Identity binding from Kubernetes service accounts to GCP service
  accounts when using GKE.
- The GKE reference values create a Kubernetes service account named
  `open-cowork-cloud` annotated with
  `iam.gke.io/gcp-service-account: open-cowork-cloud@PROJECT.iam.gserviceaccount.com`.
  Bind that KSA to the matching GCP service account, or replace it in your
  private overlay with role-specific KSAs/GSAs.

Template commands for the shared reference service account:

```bash
gcloud iam service-accounts add-iam-policy-binding \
  open-cowork-cloud@PROJECT.iam.gserviceaccount.com \
  --project PROJECT \
  --role roles/iam.workloadIdentityUser \
  --member "serviceAccount:PROJECT.svc.id.goog[open-cowork/open-cowork-cloud]"

gcloud projects add-iam-policy-binding PROJECT \
  --member serviceAccount:open-cowork-cloud@PROJECT.iam.gserviceaccount.com \
  --role roles/cloudsql.client
```

Grant Secret Manager and Cloud Storage access at the narrowest practical scope
for your environment. For a first private deployment, project-level
`roles/secretmanager.secretAccessor` and bucket-level `roles/storage.objectAdmin`
are acceptable bring-up defaults, but managed environments should split
read/write and secret access by role before public rollout.

Run the preflight with optional IAM/resource checks before Helm:

```bash
OPEN_COWORK_GCP_PROJECT=PROJECT \
OPEN_COWORK_GCP_REGION=REGION \
OPEN_COWORK_GCP_SQL_INSTANCE=INSTANCE \
OPEN_COWORK_GCP_BUCKET=OPEN_COWORK_BUCKET \
OPEN_COWORK_GCP_GSA_EMAIL=open-cowork-cloud@PROJECT.iam.gserviceaccount.com \
OPEN_COWORK_GCP_REQUIRE_GKE_IAM=true \
OPEN_COWORK_GCP_REDACT_OUTPUT=true \
pnpm deploy:gcp:preflight -- \
  --secrets open-cowork-cloud-control-plane-url,open-cowork-cloud-cookie-secret,open-cowork-cloud-internal-token,open-cowork-cloud-secret-key,open-cowork-cloud-secret-key-ref,open-cowork-cloud-oidc-client-secret
```

The optional checks are read-only. They verify the Cloud SQL connection name,
Cloud SQL backup/PITR settings, bucket versioning, named Secret Manager
secrets, the GCP service account, Workload Identity binding, and required
project roles. Set `OPEN_COWORK_GCP_REQUIRED_PROJECT_ROLES` to a comma-separated
role list when a private overlay intentionally requires more than
`roles/cloudsql.client`. Set `OPEN_COWORK_GCP_ALLOW_NO_PITR=true` or
`OPEN_COWORK_GCP_ALLOW_UNVERSIONED_BUCKET=true` only for documented
non-production exceptions.

## Secret Inventory

Create these Secret Manager secrets, or map equivalent secret names through
External Secrets:

| Secret | Consumed as |
| --- | --- |
| `open-cowork-cloud-control-plane-url` | `OPEN_COWORK_CLOUD_CONTROL_PLANE_URL` |
| `open-cowork-cloud-cookie-secret` | `OPEN_COWORK_CLOUD_COOKIE_SECRET` |
| `open-cowork-cloud-internal-token` | `OPEN_COWORK_CLOUD_INTERNAL_TOKEN` |
| `open-cowork-cloud-secret-key` | Target Secret Manager secret that holds the envelope key. |
| `open-cowork-cloud-secret-key-ref` | `OPEN_COWORK_CLOUD_SECRET_KEY_REF`, with payload `gcp-sm://projects/PROJECT/secrets/open-cowork-cloud-secret-key/versions/latest`. |
| `open-cowork-cloud-oidc-client-secret` | `OPEN_COWORK_CLOUD_OIDC_CLIENT_SECRET` |
| `open-cowork-gateway-service-token` | `OPEN_COWORK_GATEWAY_SERVICE_TOKEN` |
| channel provider secrets | Gateway provider env vars such as Telegram/Slack/webhook secrets |

For GCP-native secret refs, use:

```text
gcp-sm://projects/PROJECT/secrets/open-cowork-cloud-secret-key/versions/latest
```

The app resolves that ref at runtime using the pod/service identity access
token. BYOK provider keys are still stored as tenant-scoped encrypted records;
they must not be injected as process env vars.

When the GKE values enable `cloudSqlProxy`, store
`open-cowork-cloud-control-plane-url` with a localhost host and the proxy port,
for example:

```text
postgres://open_cowork:PASSWORD@127.0.0.1:5432/open_cowork?sslmode=disable
```

Do not put the raw database URL in Helm values for
`cloud.deploymentTier=public_production`; keep it in Secret Manager or the
private deployment repo's secret system so it does not enter Helm release
history.

## GKE Split-Role Rollout

1. Create or select a GCP project and region.
2. Create Artifact Registry repository and publish `open-cowork-cloud` and
   `open-cowork-gateway` images.
3. Create Cloud SQL PostgreSQL, enable backups/PITR, create a database, and
   capture the connection name for `cloudSqlProxy.instanceConnectionName`:

   ```bash
   gcloud sql instances describe INSTANCE \
     --project PROJECT \
     --format='value(connectionName)'
   ```

4. Create a private Cloud Storage bucket with versioning/lifecycle policy.
5. Create Secret Manager secrets listed above.
6. Create or select a GKE cluster with Workload Identity and bind the
   `open-cowork-cloud` Kubernetes service account to the configured GCP
   service account.
7. Create the namespace, then install External Secrets Operator if using
   `gke/external-secret.example.yaml`. Apply the ExternalSecret before Helm so
   the chart's non-optional `open-cowork-cloud-secrets` reference is ready:

   ```bash
   kubectl create namespace open-cowork --dry-run=client -o yaml | kubectl apply -f -
   kubectl apply -f deploy/gcp/gke/external-secret.example.yaml
   ```

   If you are not using External Secrets Operator, create the
   `open-cowork-cloud-secrets` Kubernetes secret manually from Secret Manager
   values before installing the chart.
8. Apply the managed certificate before Helm creates the Ingress that references
   it:

   ```bash
   kubectl apply -f deploy/gcp/gke/managed-certificate.example.yaml
   ```

9. Copy `gke/values.gke.yaml.example` into your private deployment repo and
   replace placeholders, including `cloudSqlProxy.instanceConnectionName`.
   The reference chart runs a pinned Cloud SQL Auth Proxy sidecar in each
   Cloud role pod and keeps it bound to `127.0.0.1`; the Cloud control-plane
   database URL secret should point at that local listener. The proxy is
   rendered as a native Kubernetes sidecar with a startup health gate so it
   starts before the app and shuts down after Cloud workers and schedulers
   finish draining.
   When enabling the sidecar on an existing single-replica GKE Autopilot smoke
   environment, make sure the cluster has enough temporary surge capacity or
   temporarily set `roles.<role>.updateStrategy.rollingUpdate.maxUnavailable=1`
   and `maxSurge=0` for the migration window. Production overlays should prefer
   enough capacity for the default zero-unavailable rollout.
10. Render and install:

   ```bash
   helm upgrade --install open-cowork-cloud ./helm/open-cowork-cloud \
     --namespace open-cowork \
     --create-namespace \
     --values deploy/gcp/gke/values.gke.yaml.example
   ```

11. Route HTTPS traffic to the web Ingress and run deployment smoke:

    ```bash
    OPEN_COWORK_SMOKE_CLOUD_URL=https://cowork.example.com \
    OPEN_COWORK_SMOKE_SKIP_GATEWAY=true \
    pnpm deploy:smoke
    ```

    The reference GKE values disable plain HTTP on the public Ingress and set
    `OPEN_COWORK_CLOUD_TRUST_PROXY_HEADERS=true` with
    `OPEN_COWORK_CLOUD_TRUSTED_PROXY_CIDRS` set to the GCE Ingress/load
    balancer proxy ranges so auth backoff and request auditing use the client
    IP forwarded by the GCP load balancer. Keep those settings enabled for
    public GCE Ingress deployments.

12. Run the GCP infra smoke after Cloud Storage and Secret Manager are wired:

    ```bash
    OPEN_COWORK_GCP_PROJECT=PROJECT \
    OPEN_COWORK_GCP_BUCKET=OPEN_COWORK_BUCKET \
    OPEN_COWORK_GCP_SQL_INSTANCE=INSTANCE \
    OPEN_COWORK_GCP_SECRET_REF=gcp-sm://projects/PROJECT/secrets/open-cowork-cloud-secret-key/versions/latest \
    OPEN_COWORK_SMOKE_CLOUD_URL=https://cowork.example.com \
    OPEN_COWORK_GCP_REDACT_OUTPUT=true \
    pnpm deploy:gcp:smoke
    ```

    The GCP infra smoke runs Cloud Web smoke, Cloud Storage
    upload/download/delete, Secret Manager resolution without printing the
    secret value, and Cloud SQL restore-readiness checks for automated backups
    and PITR. Set `OPEN_COWORK_GCP_SKIP_RESTORE_SMOKE=true` only for early
    pre-database surface checks; production and launch gates should provide
    `OPEN_COWORK_GCP_SQL_INSTANCE`. Set `OPEN_COWORK_GCP_ALLOW_NO_PITR=true`
    only for a documented non-production exception.

13. Run the Desktop cloud-sync smoke with an admin-scoped token so the script
    can issue and revoke an ephemeral Desktop token. Keep tokens in the shell
    environment or your private deployment repo secret store; do not pass them
    on the command line:

    ```bash
    OPEN_COWORK_DESKTOP_SMOKE_CLOUD_URL=https://cowork.example.com \
    OPEN_COWORK_DESKTOP_SMOKE_ADMIN_TOKEN=... \
    pnpm deploy:desktop:smoke
    ```

    This is the #496 gate for deployed GCP environments. It validates the same
    Desktop cloud adapter/cache path used by Electron, including Desktop OIDC
    metadata when OIDC auth is configured, bearer-auth HTTP/SSE, Desktop-created and Web-created cloud
    sessions, prompt/abort routing, read-only offline cache fallback, local
    workspace isolation, and token revocation. Set
    `OPEN_COWORK_DESKTOP_SMOKE_SKIP_PROMPT=true` only for pre-worker surface
    checks; the full #496 acceptance gate should run prompts against a worker
    with BYOK/model credentials configured.

14. Run the Gateway cloud smoke with an admin-scoped Cloud token and, when a
    managed Gateway endpoint is deployed, its Gateway admin token. Keep all
    tokens in the shell environment or your private deployment repo secret
    store; do not pass them on the command line:

    ```bash
    OPEN_COWORK_GATEWAY_SMOKE_CLOUD_URL=https://cowork.example.com \
    OPEN_COWORK_GATEWAY_SMOKE_GATEWAY_URL=https://gateway.example.com \
    OPEN_COWORK_GATEWAY_SMOKE_ADMIN_TOKEN=... \
    OPEN_COWORK_GATEWAY_SMOKE_GATEWAY_ADMIN_TOKEN=... \
    pnpm deploy:gateway:smoke
    ```

    This is the #497 gate for deployed GCP environments. It validates managed
    Gateway health/readiness and public operator endpoint protection, then runs
    a loopback self-host Gateway process against the deployed Cloud control
    plane with an ephemeral gateway-scoped token. The self-host path exercises
    channel binding setup, token least privilege, inbound fake-channel prompt,
    session SSE rendering, approval interaction routing, async/proactive
    delivery, retry/dead-letter controls, and token revocation. The fake
    provider remains loopback-only; do not expose fake ingress on public
    Gateway deployments.

15. Run the Web/Desktop/Gateway continuation smoke with an admin-scoped Cloud
    token. This is the #498 gate and should run after the Cloud, Desktop, and
    Gateway smoke gates are green:

    ```bash
    OPEN_COWORK_CONTINUATION_SMOKE_CLOUD_URL=https://cowork.example.com \
    OPEN_COWORK_CONTINUATION_SMOKE_ADMIN_TOKEN=... \
    OPEN_COWORK_CONTINUATION_SMOKE_REQUIRE_RICH_PROJECTION=true \
    pnpm deploy:continuation:smoke
    ```

    The smoke issues short-lived Web/Desktop/Gateway tokens, checks Cloud Web
    Workbench bootstrap and `X-Request-Id` correlation, proves Web-created,
    Desktop-created, and Gateway-created sessions can be continued by the other
    surfaces, validates shared durable projection parity, resolves a permission
    from Web, resolves a question from Gateway, verifies artifact metadata,
    exercises concurrent prompts on one cloud thread, verifies stale Desktop
    cursors hydrate from durable projection state, and revokes all smoke tokens.
    For early BYOK/runtime bring-up, omit
    `OPEN_COWORK_CONTINUATION_SMOKE_REQUIRE_RICH_PROJECTION`; launch gates
    should enable it.

16. Run the strict production smoke wrapper after the individual Cloud,
    Desktop, Gateway, and Continuation smokes are green:

    ```bash
    OPEN_COWORK_SMOKE_CLOUD_URL=https://cowork.example.com \
    OPEN_COWORK_SMOKE_GATEWAY_URL=https://gateway.example.com \
    OPEN_COWORK_SMOKE_ADMIN_TOKEN=... \
    OPEN_COWORK_SMOKE_GATEWAY_ADMIN_TOKEN=... \
    pnpm deploy:smoke:strict
    ```

    The strict wrapper fails closed unless authenticated operator checks,
    runtime status, worker heartbeat visibility, mutation coverage, token
    revocation, managed Gateway checks, and rich continuation projection all
    pass.

17. Run the launch load and soak gates for the selected target profile. Keep
    tokens in environment variables or a private deployment repo secret store;
    do not commit real project ids, service names, domains, or tokens:

    ```bash
    OPEN_COWORK_LOAD_CLOUD_URL=https://cowork.example.com \
    OPEN_COWORK_LOAD_GATEWAY_URL=https://gateway.example.com \
    OPEN_COWORK_LOAD_CLOUD_TOKEN=... \
    OPEN_COWORK_LOAD_GATEWAY_ADMIN_TOKEN=... \
    OPEN_COWORK_LOAD_BYOK_PROVIDER=anthropic \
    OPEN_COWORK_LOAD_INCLUDE_MUTATIONS=true \
    OPEN_COWORK_LOAD_INCLUDE_SSE=true \
    OPEN_COWORK_LOAD_OPERATOR_CHECKS=true \
    OPEN_COWORK_LOAD_STRICT=true \
    OPEN_COWORK_LOAD_PROFILE=private-beta \
    pnpm deploy:load
    ```

    After the load gate is green, run `pnpm deploy:soak` with the same
    environment. Attach the JSON/Markdown reports, dashboard evidence, cost
    notes, and known limits to the release evidence before treating the GCP
    deployment as private-beta ready.

For quick Helm overrides, keep the same provider-neutral keys used by the
other recipes:

```bash
helm upgrade --install open-cowork-cloud ./helm/open-cowork-cloud \
  --set image.repository=REGION-docker.pkg.dev/PROJECT/open-cowork/open-cowork-cloud \
  --set cloud.auth.mode=oidc \
  --set cloud.auth.oidcIssuerUrl=https://accounts.google.com \
  --set cloud.auth.oidcClientId=OIDC_CLIENT_ID \
  --set cloud.publicUrl="$OPEN_COWORK_CLOUD_PUBLIC_URL" \
  --set cloud.checkpoints.enabled=true \
  --set cloud.objectStore.kind=gcs \
  --set cloud.objectStore.bucket=OPEN_COWORK_BUCKET \
  --set cloud.existingSecret=open-cowork-cloud-secrets

helm upgrade --install open-cowork-gateway ./helm/open-cowork-gateway \
  --set gateway.cloudBaseUrl="$OPEN_COWORK_CLOUD_PUBLIC_URL" \
  --set gateway.publicUrl="$OPEN_COWORK_GATEWAY_PUBLIC_URL" \
  --set gateway.existingSecret=open-cowork-gateway-secrets
```

Store gateway service tokens and provider webhook signing secrets in Secret
Manager/External Secrets. Keep billing disabled/stubbed for OSS self-host and
only enable the managed billing adapter for hosted SaaS.

## Cloud Run Demo Profile

`cloud-run/all-in-one.service.yaml.example` is useful for a focused pilot or a
smoke endpoint before the GKE worker topology is available. It runs web,
worker, and scheduler in one process, so it is not a horizontally scalable
production worker model.

Deploy the demo only with explicit OIDC/cookie/secret config and a managed
Postgres/Object Store backend:

```bash
gcloud run services replace deploy/gcp/cloud-run/all-in-one.service.yaml.example \
  --region us-central1
```

Do not use `auth.mode=none` for public Cloud Run URLs.

## Migrations And Rollback

Cloud control-plane migrations run idempotently on app startup under Postgres
advisory locks. Before a production rollout:

- apply to a staging clone first,
- run smoke checks against an already-populated database,
- keep the previous image tag available for web/worker/scheduler rollback,
- do not roll back database data manually unless a tested recovery plan says so.

Rollback order:

1. Scale worker and scheduler down to zero if command execution is unhealthy.
2. Roll web, worker, and scheduler deployments back to the previous image tag.
3. Verify `/readyz`, `GET /api/config`, and session list/projection reads.
4. Start one worker replica and run a smoke prompt.
5. Start scheduler and remaining workers.

## Validation Checklist

- `pnpm deploy:validate`
- `OPEN_COWORK_GCP_REGION=... OPEN_COWORK_GCP_REDACT_OUTPUT=true pnpm deploy:gcp:preflight`
- `OPEN_COWORK_SMOKE_CLOUD_URL=https://... pnpm deploy:smoke -- --skip-gateway`
- `OPEN_COWORK_GCP_PROJECT=... OPEN_COWORK_GCP_BUCKET=... OPEN_COWORK_GCP_SQL_INSTANCE=... OPEN_COWORK_GCP_REDACT_OUTPUT=true pnpm deploy:gcp:smoke`
- `OPEN_COWORK_DESKTOP_SMOKE_CLOUD_URL=https://... OPEN_COWORK_DESKTOP_SMOKE_ADMIN_TOKEN=... pnpm deploy:desktop:smoke`
- `OPEN_COWORK_GATEWAY_SMOKE_CLOUD_URL=https://... OPEN_COWORK_GATEWAY_SMOKE_GATEWAY_URL=https://... OPEN_COWORK_GATEWAY_SMOKE_ADMIN_TOKEN=... pnpm deploy:gateway:smoke`
- `OPEN_COWORK_CONTINUATION_SMOKE_CLOUD_URL=https://... OPEN_COWORK_CONTINUATION_SMOKE_ADMIN_TOKEN=... OPEN_COWORK_CONTINUATION_SMOKE_REQUIRE_RICH_PROJECTION=true pnpm deploy:continuation:smoke`
- `OPEN_COWORK_SMOKE_CLOUD_URL=https://... OPEN_COWORK_SMOKE_GATEWAY_URL=https://... OPEN_COWORK_SMOKE_ADMIN_TOKEN=... OPEN_COWORK_SMOKE_GATEWAY_ADMIN_TOKEN=... pnpm deploy:smoke:strict`
- `OPEN_COWORK_LOAD_CLOUD_URL=https://... OPEN_COWORK_LOAD_GATEWAY_URL=https://... OPEN_COWORK_LOAD_BYOK_PROVIDER=anthropic OPEN_COWORK_LOAD_INCLUDE_MUTATIONS=true OPEN_COWORK_LOAD_INCLUDE_SSE=true OPEN_COWORK_LOAD_OPERATOR_CHECKS=true OPEN_COWORK_LOAD_STRICT=true pnpm deploy:load`
- `OPEN_COWORK_LOAD_CLOUD_URL=https://... OPEN_COWORK_LOAD_GATEWAY_URL=https://... OPEN_COWORK_LOAD_BYOK_PROVIDER=anthropic OPEN_COWORK_LOAD_INCLUDE_MUTATIONS=true OPEN_COWORK_LOAD_INCLUDE_SSE=true OPEN_COWORK_LOAD_OPERATOR_CHECKS=true OPEN_COWORK_LOAD_STRICT=true pnpm deploy:soak`
- Cloud logs contain no raw database URLs, BYOK keys, API tokens, OAuth tokens,
  channel credentials, or signed object URLs.

## Provider Boundary

GCP configuration is adapter wiring only. Do not add GCP branches to cloud
sessions, gateway rendering, OpenCode runtime startup, projection reducers,
billing, Desktop sync, Gateway channel rendering, or BYOK core code.
