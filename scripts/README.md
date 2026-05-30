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
pnpm deploy:gcp:preflight
pnpm deploy:gcp:smoke
pnpm notices
pnpm --dir apps/desktop dist:ci
```

Release-sensitive scripts should stay deterministic, avoid network calls
unless the caller clearly expects them, and produce actionable errors for
CI logs.

`pnpm cloud:dev` starts the TypeScript source entrypoint for local iteration.
`pnpm cloud:build` emits the production cloud bundle, and `pnpm cloud:start`
starts the role selected by `OPEN_COWORK_CLOUD_ROLE` from that bundle. Use
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

`pnpm deploy:desktop:smoke` validates the Desktop cloud-workspace path against
a running cloud deployment. It uses the same main-process cloud adapter and
cache code as Electron Desktop, verifies HTTPS/base URL handling, Desktop OIDC
metadata when configured, bearer-auth HTTP/SSE, Desktop-created and Web-created session
continuation, prompt/abort routing, read-only offline cache fallback, local
workspace isolation, and token revocation when
`OPEN_COWORK_DESKTOP_SMOKE_ADMIN_TOKEN` is provided. Tokens are read from
environment variables only, not command-line arguments.

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
