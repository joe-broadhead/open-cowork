# Open Cowork Cloud Deploy Recipes

These recipes are thin provider-specific compositions of the same
`open-cowork-cloud` and `open-cowork-gateway` images, roles, and adapters.
Provider behavior should stay in deployment configuration, cloud services, and
adapter wiring rather than in core runtime/session logic.

Use these invariants across every provider:

- Run `web`, `worker`, and `scheduler` as separate roles for production.
- Run the gateway as a separate deployment or service. It owns channel
  credentials and long-poll/webhook connections, not OpenCode execution.
- Use Postgres for the control plane.
- Use object storage for artifacts and runtime/workspace checkpoints.
- Pin `open-cowork-cloud` and `open-cowork-gateway` images by release tag or
  digest. Do not use `latest`, `stable`, mutable registry aliases, or a local
  Compose build as a production image source.
- Use OIDC or explicit `OPEN_COWORK_CLOUD_AUTH_MODE=header` behind a trusted
  reverse-proxy identity layer before exposing the web role publicly;
  `OPEN_COWORK_CLOUD_AUTH_MODE=none` requires an explicit insecure local/demo
  override when the process binds beyond loopback.
- Store `OPEN_COWORK_CLOUD_SECRET_KEY`, `OPEN_COWORK_CLOUD_INTERNAL_TOKEN`,
  database URLs, object-store credentials, gateway service tokens, and channel
  credentials in the provider secret manager.
- Keep Cloud Run/App Platform/all-in-one deployments for demos or focused
  pilots unless the platform gives workers predictable long-running CPU.
- Use `OPEN_COWORK_CLOUD_DEPLOYMENT_TIER=public_production` only for split-role
  public deployments with Postgres, provider-backed object storage,
  production-strength secret/cookie material, enabled auth, non-inline web
  command handling, and worker checkpoints. Local/self-host beta tiers remain
  available for demos and internal evaluation.
- Wire Kubernetes probes to cloud `/livez` for liveness and `/readyz` for
  dependency readiness; `/healthz` is backward-compatible liveness only.
- Enable `OPEN_COWORK_CLOUD_CHECKPOINTS_ENABLED=true` before scaling worker
  replicas beyond one, and store checkpoints in a shared object store.
- Keep billing optional for self-hosted OSS deployments. Use no billing
  provider or the stub billing provider unless you are operating managed SaaS.
- Run `pnpm deploy:validate` before release and `pnpm deploy:smoke` against a
  live deployment after rollout.
- For the GCP reference deployment, run `pnpm deploy:gcp:preflight` before
  rollout and `pnpm deploy:gcp:smoke` after traffic is routed.
- Use `docs/setup-and-health-center.md` and the Desktop Health Center as the
  product-facing readiness view for Desktop, Cloud, Gateway, and pairing paths.
  It should agree with `pnpm deploy:validate`, `pnpm ops:validate`, Gateway
  doctor output, and smoke evidence before production traffic is routed.

The canonical scalable manifest is the provider-neutral Helm chart in
`helm/open-cowork-cloud`; the gateway chart lives in `helm/open-cowork-gateway`
and can also be enabled as the cloud chart's optional gateway dependency.

## Topology Profiles

Start with a topology profile, then choose a provider recipe. The topology
defines the product boundary and execution authority; the provider recipe only
wires infrastructure.

The machine-readable profile contract lives in
`deploy/topologies/topology-profiles.json`, with the operator guide in
`deploy/topologies/README.md` and the docs page in
`docs/deployment-topologies.md`.

Each topology must also pass its matching hybrid security gate before it is
exposed to users or public callbacks. The gate contract lives in
`deploy/security/hybrid-security-gates.json`, with the operator docs in
`docs/hybrid-security-gates.md`. These gates define per-mode auth, revocation,
approval/question policy, audit events, quotas/rate limits, durability,
backup/restore, redaction, and fail-closed behavior.

| Profile | Use case | Execution authority | Reference assets |
| --- | --- | --- | --- |
| `desktop-only` | private local Desktop with no Cloud dependency | Desktop Local | `docs/desktop-app.md` |
| `gateway-only` | Telegram-to-VPS OpenCode team | Standalone Team Gateway | `deploy/standalone-gateway/` |
| `cloud-only` | browser/org Cloud workspaces | Cloud worker | `helm/open-cowork-cloud/` |
| `cloud-channel-gateway` | Cloud workspaces through Telegram/Slack/email/webhook | Cloud worker; Gateway is a channel adapter | `deploy/gateway-appliance/`, `helm/open-cowork-gateway/` |
| `desktop-gateway` | remote surface reaches opted-in Desktop | Desktop Local; broker is a connector | `docs/desktop-outbound-pairing.md` |
| `cloud-gateway-edge` | Cloud registers an external Gateway authority | Cloud worker or Standalone Gateway per workspace | `docs/cloud-gateway-registration.md` |
| `full-hybrid` | enterprise combination of Desktop, Cloud, Gateway, and pairing | Desktop Local, Cloud worker, or Standalone Gateway per workspace | all smaller kits |

Every profile has a security boundary and validation command. Production
operators should run the profile validator through `pnpm deploy:validate`
before traffic and then run the profile-specific smoke commands listed in the
topology contract.

## Deployment Repository Strategy

Keep public templates separate from real operator state:

| Location | What belongs there | What must not be committed there |
| --- | --- | --- |
| Public `open-cowork` repo | Provider-neutral docs, placeholder templates, validation scripts, smoke scripts, redacted evidence templates, and generalized fixes. | Real project ids, account ids, private domains, customer names, prices, API tokens, database URLs, channel credentials, screenshots/logs with private values, or raw provider evidence. |
| Tmp/local deployment repo | Generated manifests, copied Helm values, `gcloud`/provider outputs, short-lived smoke reports, and operator scratch files while proving a deployment. | Anything intended to be pushed to the public repo without redaction and generalization. |
| Private/downstream deployment repo | SaaS-specific domains, cloud project ids, provider account ids, OIDC apps, image digests, secret refs, launch evidence, cost notes, customer data, private runbooks, and environment overlays. | Product source changes that should be shared back as reusable templates or provider-neutral fixes. |

Copy back only source-neutral changes: improved placeholders, stricter
validators, portable scripts, generic docs, and redacted evidence summaries.
Never paste raw preflight/smoke JSON into public issues, PRs, or docs. Use
`OPEN_COWORK_GCP_REDACT_OUTPUT=true` or the relevant provider redaction mode
before attaching evidence outside the private deployment repo.
The tmp/local deployment repo is disposable by design; assume every raw file in
it is private until it has been redacted and generalized.

## Provider Recipes

Each provider recipe is a deployment overlay for the same product topology. Do
not add provider-specific runtime branches to Cloud, Gateway, Desktop sync, or
OpenCode session execution.

| Target | Recipe | Scalable shape | Demo/pilot shape |
| --- | --- | --- | --- |
| GCP | `deploy/gcp/` | GKE, Cloud SQL for PostgreSQL, Cloud Storage, Secret Manager, Artifact Registry | Cloud Run all-in-one |
| AWS | `deploy/aws/` | EKS or ECS split roles, RDS for PostgreSQL, S3, Secrets Manager or SSM, ECR | ECS/Fargate all-in-one task |
| Azure | `deploy/azure/` | AKS or Container Apps split roles, Azure Database for PostgreSQL, Blob Storage, Key Vault, ACR | Container Apps all-in-one service |
| DigitalOcean | `deploy/digitalocean/` | DOKS split roles, Managed PostgreSQL, Spaces, registry, External Secrets or Kubernetes Secrets | App Platform all-in-one component |
| Generic Kubernetes | `deploy/kubernetes/` | Provider-neutral Helm on any conformant Kubernetes cluster | Single namespace split-role pilot |
| VPS/local Compose | `deploy/gateway-appliance/` plus root Compose files | Remote Cloud Channel Gateway appliance against managed Cloud, or local all-in-one Cloud + Cloud Channel Gateway | Local all-in-one Compose |

Every recipe must stay provider-config only:

- Use placeholders such as `PROJECT`, `ACCOUNT`, `SUBSCRIPTION`, `REGION`,
  `CLUSTER_NAME`, `OPEN_COWORK_BUCKET`, and `cowork.example.com`.
- Do not commit real account IDs, project IDs, subscription IDs, tenant IDs,
  domains, image tags, database URLs, tokens, or channel credentials.
- Keep secret values in the provider secret manager, External Secrets, private
  `.env` files, or a private deployment repo.
- Keep `web`, `worker`, `scheduler`, and Gateway independently scalable when a
  provider offers long-running compute.

For VPS, Mac mini, Raspberry Pi, and internal-server installs, use the Gateway
appliance path in `docs/gateway-appliance.md` plus the templates under
`deploy/gateway-appliance/`. The appliance supports remote Cloud mode through
`docker-compose.gateway-remote.yml` and local all-in-one mode through
`docker-compose.cloud-gateway.yml`. Both deployments use
`OPEN_COWORK_GATEWAY_PRODUCT_MODE=cloud_channel` and keep Gateway as a Cloud
client, not an OpenCode runtime.

For managed worker service-plane deployments, use the public-safe templates in
`deploy/managed-workers/`. They cover self-hosted worker env files,
managed-operator env shape, Helm worker-pool overlays, release evidence, drain
and rollback proof, emergency revoke proof, and restore drill evidence. Copy
them into a private deployment repo before adding real project ids, domains,
account ids, customer values, credentials, prices, or launch evidence.

## Deployer Configuration

Keep product policy in `open-cowork.config.json` and provider wiring in
Compose, Helm, or provider manifests. The public config schema covers the
shared knobs downstream operators need:

| Product surface | Config section | Deployment wiring |
| --- | --- | --- |
| Cloud Web/control plane | `cloud.publicBranding`, `cloud.auth`, `cloud.storage`, `cloud.features`, `cloud.profiles`, `cloud.projectSources`, `cloud.abuse`, `cloud.billing` | `OPEN_COWORK_CLOUD_*`, database/object-store/secret-manager refs, OIDC issuer/client settings |
| Desktop cloud connection | `branding`, `cloudDesktop` | packaged `open-cowork.config.json`, managed system config, or downstream root |
| Gateway | `gateway.branding`, `gateway.server`, `gateway.providers`, `gateway.metrics`, `gateway.diagnostics` | `OPEN_COWORK_CLOUD_BASE_URL`, `OPEN_COWORK_GATEWAY_*`, channel secrets, service tokens, webhook URLs |

Gateway reads the shared `gateway` section from `OPEN_COWORK_CONFIG_PATH`,
`OPEN_COWORK_CONFIG_DIR`, or `OPEN_COWORK_DOWNSTREAM_ROOT`; gateway-specific
config files and env vars override it. Gateway config JSON is for branding,
provider metadata, and process policy. Cloud URL, gateway service token,
cloud-request timeout, and insecure-HTTP policy must come from env or
deployment secrets so a mounted JSON file cannot redirect or shape the
gateway's control-plane client. This keeps a branded internal build auditable
without hardcoding provider values into product code.
Compose files bind-mount those config file or directory paths into containers
at the same path, so host-path overrides remain visible to Cloud and Gateway
processes.

Public URLs must be HTTPS except localhost development URLs. Public gateway
metrics/diagnostics require an admin token, webhook providers require a shared
secret, and self-host deployments can keep `cloud.billing.provider` set to
`none` or `stub`.

## Image Strategy

Helm charts default to the chart app version placeholder and fail closed when
`image.tag=latest`. Production overlays must set either a release `image.tag`
or `image.digest`. Prefer immutable digests for regulated environments:

```bash
helm upgrade --install open-cowork-cloud ./helm/open-cowork-cloud \
  --set image.repository=ghcr.io/joe-broadhead/open-cowork-cloud \
  --set image.digest=sha256:REPLACE_WITH_RELEASE_DIGEST \
  --set cloud.auth.mode=oidc \
  --set cloud.auth.oidcIssuerUrl=https://issuer.example.com \
  --set cloud.auth.oidcClientId=open-cowork-cloud
```

Release tags are acceptable when your registry prevents tag mutation:

```bash
--set image.tag=v0.1.0
```

The Compose files expose `OPEN_COWORK_CLOUD_IMAGE` and
`OPEN_COWORK_GATEWAY_IMAGE` for local image-name overrides, but they still
include `build:` blocks and insecure local defaults. Treat them as local/demo
references unless a downstream private repo removes the local build and
replaces every demo secret, public URL, auth mode, and object-store credential.

## Kubernetes Scaling

The base Helm chart keeps autoscaling provider-neutral. Add HPA or KEDA
resources in the deployment overlay that owns metrics and cluster policy:

- HPA: target `Deployment/open-cowork-cloud-web` for HTTP/API pressure and
  `Deployment/open-cowork-cloud-worker` for CPU/memory-constrained worker
  capacity.
- KEDA: scale workers from durable queue depth, backlog age, or another
  provider-native metric that maps to command pressure.
- PodDisruptionBudgets: enable
  `roles.<role>.podDisruptionBudget.enabled=true` for production web, worker,
  scheduler, and gateway deployments.
- topology spread constraints: set `roles.<role>.topologySpreadConstraints[]` and
  `gateway.topologySpreadConstraints[]` in private overlays so web and worker
  pods do not collapse onto one node or zone.

Scale-out workers require all of the following before `roles.worker.replicas`
is greater than one: `cloud.checkpoints.enabled=true`,
`roles.worker.checkpointsEnabled=true`, a non-filesystem
`cloud.objectStore.kind`, and `cloud.objectStore.bucket`. Local filesystem
storage and one PVC shared by multiple worker replicas are local/demo-only
patterns, not a production checkpoint contract.

## Required Production Inputs

Provider recipes are deployment wiring documents. They should resolve the same
runtime inputs through provider-native services without changing core code.

Every provider recipe should resolve the same inputs through provider-native
infrastructure:

| Input | Expected source |
| --- | --- |
| Images | `open-cowork-cloud` and `open-cowork-gateway` OCI images |
| Public origins | HTTPS cloud URL and optional HTTPS gateway URL |
| Auth | OIDC or trusted header auth with signed proxy headers |
| Control plane | Managed Postgres connection string |
| Object store | Bucket/container plus adapter-specific endpoint/region |
| Secrets | Provider secret manager or KMS-backed secret adapter |
| Runtime keys | BYOK status APIs plus worker-only plaintext reveal |
| Gateway | Scoped service token and provider signing secrets |
| Scaling | Split web/worker/scheduler roles and checkpoint-enabled workers |
| Worker operations | Drain, rolling update, rollback, emergency revoke, and restore evidence from `deploy/managed-workers/` |
| Observability | JSON logs, OTLP endpoint, metrics, and redaction policy |
| Recovery | Postgres and object-store backup/restore process |

Reusable observability assets live under `deploy/observability/`:

- `metrics-catalog.json` defines the Cloud and Gateway metric contract.
- `grafana-open-cowork-overview.json` provides a provider-neutral dashboard
  starting point for web, worker, scheduler, Gateway, auth, BYOK, quotas, and
  delivery health.
- `prometheus-alerts.yaml` defines launch-blocking alerts for user-impacting
  errors, backlog, projection lag, auth abuse, BYOK failures, and Gateway
  delivery failures.
- `managed-worker-slo-template.json` defines the public-safe worker SLO shape
  for heartbeat freshness, queue age, claim latency, command latency,
  projection lag, checkpoints, BYOK reveal failures, stale leases, and Gateway
  worker-related lag.

See `docs/deployment-readiness.md` for the production checklist and
`docs/runbooks/managed-byok-saas.md` for hosted BYOK operations. For a managed
BYOK private beta, use `docs/runbooks/private-beta-launch.md`,
`docs/runbooks/private-beta-support.md`, and `deploy/private-beta/` before
inviting design partners.

## Validation

Validate local manifests and Helm guardrails:

```bash
pnpm deploy:validate
```

Validate the managed BYOK private beta launch package and OSS boundary:

```bash
pnpm deploy:private-beta:validate
```

Smoke a running deployment:

```bash
OPEN_COWORK_SMOKE_CLOUD_URL=https://cowork.example.com \
OPEN_COWORK_SMOKE_GATEWAY_URL=https://gateway.example.com \
pnpm deploy:smoke
```

The same smoke command works for local Compose, Kubernetes/Helm, and the cloud
provider recipes once traffic is routed to the chosen endpoints.

Validate Desktop cloud workspace sync against the same deployment:

```bash
OPEN_COWORK_DESKTOP_SMOKE_CLOUD_URL=https://cowork.example.com \
OPEN_COWORK_DESKTOP_SMOKE_ADMIN_TOKEN=... \
pnpm deploy:desktop:smoke
```

Keep Desktop smoke tokens in environment variables or a private secret store;
the script intentionally does not accept token values as command-line
arguments.

Validate the Gateway as both a managed endpoint and a self-host/VPS-style
cloud client against the same deployment:

```bash
OPEN_COWORK_GATEWAY_SMOKE_CLOUD_URL=https://cowork.example.com \
OPEN_COWORK_GATEWAY_SMOKE_GATEWAY_URL=https://gateway.example.com \
OPEN_COWORK_GATEWAY_SMOKE_ADMIN_TOKEN=... \
OPEN_COWORK_GATEWAY_SMOKE_GATEWAY_ADMIN_TOKEN=... \
pnpm deploy:gateway:smoke
```

The Gateway smoke issues a short-lived gateway-scoped service token, creates
temporary headless-agent/channel binding state through admin APIs, proves the
gateway token cannot administer channels or mint tokens, runs a loopback fake
provider Gateway like a VPS/self-host process, validates inbound message to
cloud prompt, channel rendering, approval interaction routing, async delivery,
retry/dead-letter controls, operator-scoped diagnostics/metrics, and token
revocation. Keep tokens in environment variables or a private secret store;
the script intentionally does not accept token values as command-line
arguments.

Validate the three-surface continuation promise against the same Cloud control
plane:

```bash
OPEN_COWORK_CONTINUATION_SMOKE_CLOUD_URL=https://cowork.example.com \
OPEN_COWORK_CONTINUATION_SMOKE_ADMIN_TOKEN=... \
OPEN_COWORK_CONTINUATION_SMOKE_REQUIRE_RICH_PROJECTION=true \
pnpm deploy:continuation:smoke
```

The continuation smoke is the #498 product-promise gate. It checks Cloud Web
bootstrap and request-id correlation, issues short-lived Web/Desktop/Gateway
tokens, creates and continues cloud sessions across Web API, Desktop cloud
workspace adapter, and a loopback self-host Gateway fake provider, validates
projection parity, permission/question resolution, artifact metadata,
concurrent prompt ordering, stale-cursor hydration, gateway rendering, and
token revocation. Keep all token values in environment variables or a private
secret store.

GCP adds a provider-specific infra smoke:

```bash
OPEN_COWORK_GCP_PROJECT=PROJECT \
OPEN_COWORK_GCP_BUCKET=OPEN_COWORK_BUCKET \
OPEN_COWORK_GCP_SQL_INSTANCE=INSTANCE \
OPEN_COWORK_GCP_SECRET_REF=gcp-sm://projects/PROJECT/secrets/open-cowork-cloud-secret-key/versions/latest \
OPEN_COWORK_SMOKE_CLOUD_URL=https://cowork.example.com \
OPEN_COWORK_GCP_REDACT_OUTPUT=true \
pnpm deploy:gcp:smoke
```

The GCP infra smoke checks Cloud Web, Cloud Storage round-trip, Secret Manager
resolution without printing the value, and Cloud SQL automated backup/PITR
restore readiness. Set `OPEN_COWORK_GCP_SKIP_RESTORE_SMOKE=true` only for
pre-database or early surface checks that are not launch gates.
