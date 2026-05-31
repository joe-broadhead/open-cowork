# GCP Smoke Commands

Use these commands after a GCP rollout. They intentionally read configuration
from environment variables so the same scripts work from a private deployment
repo, CI, or a local operator shell.

Keep raw evidence in a tmp/local or private/downstream deployment repo. The
public `open-cowork` repo should only receive generalized template fixes and
redacted evidence summaries. Use `OPEN_COWORK_GCP_REDACT_OUTPUT=true` before
attaching preflight or smoke output to public issues, PRs, or docs, and use
`evidence.template.json` as the public-safe shape.

## Read-Only Project Preflight

```bash
OPEN_COWORK_GCP_PROJECT=PROJECT \
OPEN_COWORK_GCP_REGION=us-central1 \
OPEN_COWORK_GCP_REDACT_OUTPUT=true \
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
OPEN_COWORK_GCP_SQL_INSTANCE=INSTANCE \
OPEN_COWORK_GCP_SECRET_REF=gcp-sm://projects/PROJECT/secrets/open-cowork-cloud-secret-key/versions/latest \
OPEN_COWORK_SMOKE_CLOUD_URL=https://cowork.example.com \
OPEN_COWORK_GCP_REDACT_OUTPUT=true \
pnpm deploy:gcp:smoke
```

The GCP smoke runs the Cloud Web smoke, writes/reads/deletes a temporary object
in Cloud Storage, resolves a Secret Manager reference without printing the
secret value, and verifies Cloud SQL restore readiness through automated backup
and point-in-time recovery checks. Set `OPEN_COWORK_GCP_SKIP_RESTORE_SMOKE=true`
only for pre-database or early surface checks that are not launch gates. Set
`OPEN_COWORK_GCP_ALLOW_NO_PITR=true` only for a documented non-production
exception.

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

## Continuation Parity Smoke

```bash
OPEN_COWORK_CONTINUATION_SMOKE_CLOUD_URL=https://cowork.example.com \
OPEN_COWORK_CONTINUATION_SMOKE_ADMIN_TOKEN=... \
OPEN_COWORK_CONTINUATION_SMOKE_REQUIRE_RICH_PROJECTION=true \
pnpm deploy:continuation:smoke
```

This validates the #498 Web/Desktop/Gateway continuation promise against one
deployed Cloud control plane. The smoke checks Cloud Web Workbench HTML/CSP and
`X-Request-Id` correlation, issues short-lived Web/Desktop/Gateway tokens,
creates Web-originated, Desktop-originated, and Gateway-originated sessions,
continues each from another surface, binds/renders through a loopback self-host
Gateway fake provider, verifies durable projection parity, resolves a
permission from Web, resolves a question from Gateway, checks artifact metadata,
prompts the same cloud thread concurrently from Web and Desktop, verifies stale
Desktop cursors replay from durable state, and revokes all smoke tokens.

## Launch Load And Soak

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

Run `pnpm deploy:soak` with the same environment after the load gate is green.
The harness writes JSON and Markdown reports under
`.open-cowork-test/launch-readiness/`. Attach those reports, Cloud Monitoring
or dashboard evidence, cost notes, and known limits to the release evidence
before calling a GCP rollout private-beta ready.
