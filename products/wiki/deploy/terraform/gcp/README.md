# OpenWiki on Google Cloud Run

This Terraform profile deploys a disposable, hosted OpenWiki stack on Google
Cloud Run. It uses the topology proven by the 2026-06-03 GCP smoke test:

- Cloud Run service for the OpenWiki web/API container.
- Cloud Run worker job for queued runs.
- Cloud Run rebuild/sync job for derived stores and Postgres sync.
- Cloud SQL for PostgreSQL.
- Cloud SQL Auth Proxy sidecars on the service and both jobs.
- Secret Manager for `DATABASE_URL` and
  `OPENWIKI_TRUST_AUTH_HEADERS_SECRET`.
- Cloud Storage mounted at `/data/wiki` through Cloud Storage FUSE.
- Artifact Registry for disposable images when the evidence runner builds the
  current checkout.
- Optional project-scoped budget alerts through `billing_account_id`.

Important: this remains the `cloud-run-readmostly` preview/demo profile, not the
recommended writable Git backend for a production company wiki. Cloud Storage
FUSE is not POSIX and should not be used for long-lived mutable Git
repositories. For a writable Git-backed OpenWiki on Google Cloud, prefer the
`gcp-gke` Kubernetes/Helm profile on GKE with a proper persistent volume, or run
the container on a VM/managed platform with a normal filesystem and connect it
to a Git remote using `OPENWIKI_GIT_REMOTE_URL`.

## Disposable Evidence Run

From a clean checkout with `gcloud` authenticated:

```sh
export TF_VAR_project_id="$(gcloud config get-value project 2>/dev/null)"
export TF_VAR_name="ow-$(date +%s)"

pnpm deploy:cloud:evidence -- \
  --provider gcp \
  --backend=false \
  --apply \
  --destroy \
  --gcp-build-image \
  --json \
  --out artifacts/openwiki-cloud-apply-evidence-gcp.json
```

When `TF_VAR_image` is unset, `--gcp-build-image` creates the managed Artifact
Registry repository first, builds the current checkout with Cloud Build, pins
the final Terraform apply to the built image digest, then runs the hosted smoke
probes. The runner verifies Cloud Run IAM blocks anonymous traffic, trusted
headers work, index/search use Postgres, a lint run is queued and processed by
the worker job, the rebuild/sync job completes, and Terraform destroy removes
the prefixed stack.

Set `TF_VAR_billing_account_id=000000-000000-000000` to create a disposable
budget with 50%, 80%, 100%, and 100% forecasted thresholds. Leave it unset to
skip budget creation.

## Direct Terraform Apply

Use this path when you already have a digest-pinned image:

```sh
terraform init
terraform apply \
  -var='project_id=my-project' \
  -var='name=openwiki-preview' \
  -var='image=ghcr.io/joe-broadhead/open-wiki@sha256:<digest>'
```

`public_origin` is optional. If omitted, the module uses the predictable Cloud
Run origin:

```text
https://<name>-<project-number>.<region>.run.app
```

You can provide existing secrets with `database_url_secret_name` and
`trusted_auth_headers_secret_name`. If omitted, Terraform creates Cloud SQL
credentials and generated disposable Secret Manager secrets.

## Auth Boundary

The module does not implement human login. It defaults to
`allow_unauthenticated=false`, so direct Cloud Run requests require Cloud Run
IAM. OpenWiki also runs with `OPENWIKI_REQUIRE_AUTH=true`,
`OPENWIKI_TRUST_AUTH_HEADERS=1`, and a trusted-header shared secret. A production
deployment still needs IAP, private ingress, an authenticated gateway, or an
equivalent trusted proxy before browser writes are enabled.

## State And Cleanup

Copy `backend.tf.example` to `backend.tf` and configure the GCS backend before
production use so Terraform state is stored in a managed, access-controlled
bucket instead of only on a workstation.

Disposable runs default `force_destroy_bucket=true`,
`sql_backup_enabled=false`, and `sql_deletion_protection=false` so
`terraform destroy` can clean up the stack. Set `production_mode=true` only for
private, guarded previews. It requires a digest-pinned image,
`allow_unauthenticated=false`, `force_destroy_bucket=false`,
`sql_backup_enabled=true`, and `sql_deletion_protection=true`; it does not make
Cloud Storage FUSE safe for production Git writes.
