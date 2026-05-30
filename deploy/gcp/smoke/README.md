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

## Desktop Cloud Sync Smoke

```bash
OPEN_COWORK_DESKTOP_SMOKE_CLOUD_URL=https://cowork.example.com \
OPEN_COWORK_DESKTOP_SMOKE_ADMIN_TOKEN=... \
pnpm deploy:desktop:smoke
```

This validates the deployed cloud from the Desktop client's point of view using
the same main-process cloud adapter/cache code as Electron Desktop. With an
admin-scoped token, the smoke issues a short-lived Desktop token, connects over
bearer-auth HTTP/SSE, creates a Desktop-originated session, verifies Cloud Web
API visibility, creates a Web-originated session, verifies Desktop visibility,
prompts from both sides, sends an abort command, checks read-only offline cache
fallback, verifies the local workspace remains independent, and revokes the
ephemeral token. Use `OPEN_COWORK_DESKTOP_SMOKE_SKIP_PROMPT=true` only for
early surface checks before workers/BYOK are ready.

## Gateway Cloud Smoke

```bash
OPEN_COWORK_GATEWAY_SMOKE_CLOUD_URL=https://cowork.example.com \
OPEN_COWORK_GATEWAY_SMOKE_GATEWAY_URL=https://gateway.example.com \
OPEN_COWORK_GATEWAY_SMOKE_ADMIN_TOKEN=... \
OPEN_COWORK_GATEWAY_SMOKE_GATEWAY_ADMIN_TOKEN=... \
pnpm deploy:gateway:smoke
```

This validates the #497 Gateway deployment path. The smoke checks the managed
Gateway endpoint when `OPEN_COWORK_GATEWAY_SMOKE_GATEWAY_URL` is set, verifies
metrics/diagnostics are not public, issues a short-lived gateway-scoped token,
creates temporary headless-agent/channel binding state through Cloud admin
APIs, proves the gateway token cannot administer channels or mint tokens, runs
a loopback self-host Gateway process with the fake provider, sends an inbound
message through `/webhooks/fake`, waits for Cloud session SSE rendering, routes
an approval interaction, drains an async delivery, exercises retry/dead-letter
operator controls, and revokes the service token. Use
`OPEN_COWORK_GATEWAY_SMOKE_REQUIRE_MANAGED=true` when a managed Gateway
endpoint is mandatory for the environment.
