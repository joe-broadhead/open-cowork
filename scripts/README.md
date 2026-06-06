# Scripts

Repository automation scripts for release, packaging, documentation,
notices, performance, and CI support.

Most scripts are called through `package.json` commands or GitHub
Actions. Prefer the package scripts where available so local and CI
behavior stay aligned:

```bash
pnpm lint
pnpm perf:check
pnpm test:cloud-web
pnpm cloud:dev
pnpm cloud:build
pnpm cloud:start
pnpm cloud:smoke:compose
pnpm deploy:validate
pnpm deploy:smoke
pnpm deploy:desktop:smoke
pnpm deploy:gateway:smoke
pnpm deploy:continuation:smoke
pnpm deploy:gcp:preflight
pnpm deploy:gcp:smoke
pnpm ops:validate
pnpm notices
pnpm --dir apps/desktop dist:ci
```

Release-sensitive scripts should stay deterministic, avoid network calls
unless the caller clearly expects them, and produce actionable errors for
CI logs.

`pnpm cloud:dev` builds the Cloud Web React client, then starts the TypeScript source entrypoint for local iteration.
`pnpm cloud:build` first builds the Cloud Web package, including the Vite
React client asset, then emits the production cloud bundle and copies the
client asset under `apps/desktop/dist/cloud/assets`. `pnpm cloud:start` starts
the role selected by `OPEN_COWORK_CLOUD_ROLE` from that bundle. Use
`docker-compose.cloud.yml` for local all-in-one checks and
`docker-compose.cloud.split.yml` for web/worker/scheduler topology checks.
`pnpm cloud:smoke:compose` starts the split-role compose topology, waits
for `/healthz`, runs the deployment smoke against the Cloud Web Workbench at
`GET /`, and prints service logs if the smoke fails.

`pnpm deploy:validate` checks local Compose files, Helm chart guardrails, and
deployment readiness docs. It runs `docker compose config` and Helm
lint/template checks when those tools are installed; set
`OPEN_COWORK_DEPLOY_REQUIRE_TOOLS=true` or pass `--require-tools` in CI to fail
instead of falling back to static validation.

`pnpm deploy:smoke` validates a running deployment through HTTP health,
Cloud Web Workbench HTML/CSP/bootstrap checks, API bootstrap endpoint
reachability, and gateway readiness endpoints. Override
`OPEN_COWORK_SMOKE_CLOUD_URL` and `OPEN_COWORK_SMOKE_GATEWAY_URL` for provider
deployments, or use `--skip-cloud` / `--skip-gateway` when checking one
surface.
Set `OPEN_COWORK_SMOKE_OPERATOR_CHECKS=true` and provide operator tokens to
also validate cloud runtime status, worker heartbeats, cloud `/api/metrics`,
and Gateway `/metrics`.

`pnpm deploy:smoke:strict` is the production evidence wrapper. It requires
Cloud and managed Gateway URLs plus admin/operator tokens, runs the baseline
smoke in strict authenticated mode, then runs the Desktop, Gateway, and
Continuation smokes with revocation, managed-gateway, and rich-projection gates
enabled. It fails closed if any deep smoke skips mutation coverage, token
revocation, runtime status, worker heartbeat visibility, or Gateway operator
coverage.

`pnpm proof:opencode:compatibility` validates the OpenCode compatibility
registry used by runtime diagnostics. It fails closed on missing bundled
OpenCode version metadata, undocumented private assumptions, unknown
compatibility states, missing proving tests, and source-version drift.

`pnpm proof:sandbox:opencode-session -- --json` records redacted sandbox
OpenCode session proof evidence. Without a configured sandbox image or engine it
reports typed prerequisite failures and exits successfully for CI evidence. Use
`--strict --image <sandbox-image> --image-sha256 <sha256:...>` when a release
claim requires a successful sandboxed no-reply OpenCode session.

`pnpm ops:validate` runs the OpenCode compatibility proof, then statically
validates the production operations bundle: metric catalog, Grafana dashboard,
Prometheus alert rules, incident runbooks, backup/restore instructions, and
restore drill report requirements.

`pnpm deploy:desktop:smoke` validates the Desktop cloud-workspace path against
a running cloud deployment. It uses the same main-process cloud adapter and
cache code as Electron Desktop, verifies HTTPS/base URL handling, Desktop OIDC
metadata when configured, bearer-auth HTTP/SSE, Desktop-created and Web-created session
continuation, prompt/abort routing, read-only offline cache fallback, local
workspace isolation, and token revocation when
`OPEN_COWORK_DESKTOP_SMOKE_ADMIN_TOKEN` is provided. Tokens are read from
environment variables only, not command-line arguments.

`pnpm deploy:gateway:smoke` validates the Gateway deployment path against a
running cloud deployment. It builds the Gateway package, checks managed Gateway
health/readiness when `OPEN_COWORK_GATEWAY_SMOKE_GATEWAY_URL` is set, verifies
public metrics/diagnostics are blocked, issues a short-lived gateway-scoped
service token from `OPEN_COWORK_GATEWAY_SMOKE_ADMIN_TOKEN`, creates temporary
headless-agent/channel binding state, proves least privilege, runs a loopback
self-host fake-provider Gateway, validates inbound prompt routing, session SSE
rendering, approval interaction routing, async delivery, retry/dead-letter
controls, and token revocation. Tokens are read from environment variables
only, not command-line arguments. For loopback `auth.mode=none` local/demo
clouds, set `OPEN_COWORK_GATEWAY_SMOKE_SKIP_TOKEN_REVOCATION=true`; the smoke
still revokes the ephemeral token, but skips the post-revocation mutation check
because local-auth fallback makes bearer revocation non-authoritative.

`pnpm deploy:continuation:smoke` validates the three-surface continuation
promise against one running cloud deployment. It builds the Gateway and shared
packages, issues short-lived Web/Desktop/Gateway API tokens from
`OPEN_COWORK_CONTINUATION_SMOKE_ADMIN_TOKEN`, checks Cloud Web Workbench
bootstrap and request-id correlation, creates and continues the same cloud
sessions across Web API, Desktop cloud workspace adapter, and a loopback
self-host Gateway fake provider, verifies projection parity, permission/question
resolution, artifact metadata, concurrent prompt ordering, stale-cursor
hydration, gateway rendering, and token revocation. Set
`OPEN_COWORK_CONTINUATION_SMOKE_REQUIRE_RICH_PROJECTION=true` for launch gates
that require task/tool/artifact/todo/cost projection fields.

`pnpm deploy:gcp:preflight` is a read-only GCP check for the reference
deployment. It verifies the active `gcloud` account/project, region, required
APIs, and required files under `deploy/gcp`. Cloud KMS and Cloud Run are
checked only when `OPEN_COWORK_GCP_REQUIRE_KMS=true`,
`OPEN_COWORK_GCP_REQUIRE_CLOUD_RUN=true`, or
`OPEN_COWORK_GCP_CLOUD_RUN_SERVICE` is set. Set `OPEN_COWORK_GCP_PROJECT` and
`OPEN_COWORK_GCP_REGION` when those are not already configured in `gcloud`.

`pnpm deploy:gcp:smoke` wraps the generic deployment smoke and adds GCP infra
checks: Cloud Storage write/read/delete and Secret Manager access through a
`gcp-sm://projects/{project}/secrets/{secret}/versions/{version}` ref. It does
not print secret values.
