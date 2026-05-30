# GCP Smoke Commands

Use these commands after a GCP rollout. They intentionally read configuration
from environment variables so the same scripts work from a private deployment
repo, CI, or a local operator shell.

## Read-Only Project Preflight

```bash
OPEN_COWORK_GCP_PROJECT=PROJECT \
OPEN_COWORK_GCP_REGION=us-central1 \
pnpm deploy:gcp:preflight
```

The preflight checks:

- active `gcloud` account and project,
- region selection,
- required GCP APIs,
- reference files under `deploy/gcp`,
- optional Cloud Run service names if provided.

It does not create, modify, or delete resources.

## Cloud Web Smoke

```bash
OPEN_COWORK_SMOKE_CLOUD_URL=https://cowork.example.com \
OPEN_COWORK_SMOKE_SKIP_GATEWAY=true \
pnpm deploy:smoke
```

This validates the public Cloud Web Workbench root, CSP/nonce/bootstrap
markers, `/api/config`, and `/api/workspace`.

## GCP Infra Smoke

```bash
OPEN_COWORK_GCP_PROJECT=PROJECT \
OPEN_COWORK_GCP_BUCKET=OPEN_COWORK_BUCKET \
OPEN_COWORK_GCP_SECRET_REF=gcp-sm://projects/PROJECT/secrets/open-cowork-cloud-secret-key/versions/latest \
OPEN_COWORK_SMOKE_CLOUD_URL=https://cowork.example.com \
pnpm deploy:gcp:smoke
```

The GCP smoke runs the Cloud Web smoke, writes/reads/deletes a temporary object
in Cloud Storage, and resolves a Secret Manager reference without printing the
secret value.
