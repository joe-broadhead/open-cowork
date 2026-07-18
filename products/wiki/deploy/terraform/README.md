# OpenWiki Terraform Examples

These examples are starting points for small hosted OpenWiki deployments. They
all run the same OpenWiki container image and pass the standard runtime
environment variables used by the Docker, Compose, Helm, and Kubernetes profiles.

Examples:

- `aws/`: ECS Fargate service with an Application Load Balancer and EFS-backed
  `/data/wiki` volume for the `aws-ecs-efs` profile.
- `gcp/`: Cloud Run service, worker job, rebuild/sync job, Cloud SQL Postgres,
  Secret Manager, Artifact Registry, and a Cloud Storage volume mounted at
  `/data/wiki`. This maps to the `cloud-run-readmostly` preview/demo profile;
  do not treat GCS FUSE as production Git storage.

Each example is intentionally provider-native and expects you to review network,
identity, ingress, and persistence settings before production use.

Each module includes a `backend.tf.example`. Copy the relevant example to
`backend.tf` and configure the named cloud storage backend before production use
so state is encrypted, locked where supported, and not stored only in local
working directories.

Before production, pin the OpenWiki image by digest and choose the supported
deployment profile that matches your persistence and auth boundary.

## Production guardrails

The modules intentionally do not implement native OpenWiki login. Put human
browser writes behind a cloud auth boundary such as ALB OIDC, Google IAP,
Cloudflare Access, or a private network, then pass trusted
identity headers to OpenWiki from that boundary.
The examples set `OPENWIKI_RUNTIME_MODE=hosted` and
`OPENWIKI_REQUIRE_AUTH=true` so unauthenticated browser and MCP traffic fails
closed until you wire that boundary or scoped service-account bearer tokens.
Each module passes `OPENWIKI_PUBLIC_ORIGIN`; set it to the browser-visible HTTPS
origin after your auth boundary, for example `https://wiki.example.com`. The GCP
profile can derive the predictable Cloud Run run.app origin for disposable
tests.
Provider secret stores supply `DATABASE_URL` plus
`OPENWIKI_TRUST_AUTH_HEADERS_SECRET`; the GCP profile can create disposable
generated secrets when none are supplied. The modules set
`OPENWIKI_READ_BACKEND=postgres`, `OPENWIKI_SEARCH_BACKEND=postgres`,
`OPENWIKI_QUEUE_BACKEND=postgres`, and
`OPENWIKI_OPERATIONAL_STATE_BACKEND=postgres` plus
`OPENWIKI_WRITE_COORDINATOR_BACKEND=postgres` so hosted readiness does not pass
through Git parser, in-memory queue, or local write-coordination fallbacks. They also enable
`OPENWIKI_TRUST_AUTH_HEADERS=1`; your upstream auth boundary must inject
`x-openwiki-actor`, optional principal/group headers, and the matching
`x-openwiki-proxy-secret`.

Provider secret stores should supply runtime credentials:

- AWS: Secrets Manager or SSM Parameter Store for Postgres URLs, trusted-header
  shared secrets, Git deploy-key material, and object-storage credentials.
- GCP: Secret Manager with Cloud Run or GKE Workload Identity.

Use cloud-native lifecycle policies for backups and large objects. Terraform
state is not a backup for the Git workspace, Postgres, source captures, or
tokens; rehearse restore into a disposable environment before production.

## Apply Evidence

Use the cloud apply evidence runner before claiming that a Terraform profile has
been proven in a live environment:

```sh
pnpm deploy:cloud:evidence -- --provider aws --dry-run

OPENWIKI_CLOUD_EVIDENCE_PUBLIC_ORIGIN=https://wiki.example.com \
OPENWIKI_CLOUD_EVIDENCE_MCP_TOKEN="$OPENWIKI_READ_TOKEN" \
TF_VAR_image=ghcr.io/joe-broadhead/open-wiki@sha256:<digest> \
pnpm deploy:cloud:evidence -- --provider aws --apply --destroy
```

Run the same command with `--provider gcp` for the GCP Terraform example. The
runner records provider auth, Terraform fmt/init/validate/plan/apply, `/livez`,
`/readyz`, `/openapi.json`, HTTP MCP read-token smoke, and
optional destroy evidence in `artifacts/openwiki-cloud-apply-evidence-<provider>.json`.
It accepts health origins and MCP tokens only through environment variables or
Terraform outputs; do not put database URLs, service-account tokens, or cloud
secrets on the command line.

For the GCP disposable profile, the runner can build the current checkout into
the managed Artifact Registry repo before the final apply:

```sh
export TF_VAR_project_id="$(gcloud config get-value project 2>/dev/null)"
export TF_VAR_name="ow-$(date +%s)"

pnpm deploy:cloud:evidence -- \
  --provider gcp \
  --backend=false \
  --apply \
  --destroy \
  --gcp-build-image
```

That GCP flow also probes Cloud Run IAM denial, trusted-header denial/success,
Postgres index/search, queued lint processing through the worker job,
rebuild/sync readiness recovery, and post-destroy absence of the prefixed
resources.

Dry-run output is only an evidence inventory. It deliberately marks every check
as `not_checked` and `pass: false`; the provider issues remain open until a real
apply artifact, redacted command summary, auth-boundary note, backup/restore
evidence, and teardown result are attached.
