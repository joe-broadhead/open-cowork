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
