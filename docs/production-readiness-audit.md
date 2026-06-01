# Production Readiness Audit

Last updated: 2026-06-01.

This audit records the current delta between the repository and a polished
enterprise-production target. It is based on local source inspection, targeted
validators, GitHub security API checks, and parallel focused reviews across
security, architecture, correctness, CI/release, testing, dead code, and
documentation.

## Current Verdict

Open Cowork has a strong production baseline: Electron isolation is strict,
Cloud tenant boundaries are guarded, release supply-chain controls are mature,
and deployment templates have explicit production gates. No critical issue was
found in the current review.

The remaining work is concentrated in four areas:

- high-value security hardening around renderer-accessible local secrets
- Cloud worker lifecycle and operational correctness under failure
- release/promotion proof for hosted production claims
- maintainability guardrails for the largest Cloud compatibility facades and
  generated or vendored surfaces

## Verified Baseline

- GitHub code scanning: 0 open alerts on `master` at
  `7fdbfb7203657b98a2b1d424404c9a3075152d29`.
- Dependabot alerts: 0 open alerts at the same point-in-time check.
- GitHub Actions checks on that `master` SHA were green for deploy, CodeQL,
  build, coverage, validate, docs, cloud-gates, macos-build, and linux-package.
- Secret scanning API returned 404 for this repository, which indicates secret
  scanning is not enabled or not available to the current token. Treat that as
  an external repository-governance gap until repo settings prove otherwise.
- Targeted local validators passed for deployment configuration, release gates,
  launch readiness, launch evidence manifest, private beta package validation,
  lint, preload channel checks, shared dist checks, and coverage summary.

## Fixed During This Audit

- Local/demo Cloud compose templates now publish Cloud, Gateway, and MinIO ports
  on `127.0.0.1` by default, with opt-in published-address environment
  variables for operators that intentionally expose them.
- `scripts/validate-deployment-configs.mjs` now rejects bare public demo port
  mappings for the Cloud compose templates.
- Deployment artifact tests now assert loopback compose defaults.
- The Workflow tool bridge now verifies bearer tokens with
  `timingSafeEqual`, matching the Agent tool bridge, with a same-length
  wrong-token regression test.
- Local credential editor IPC now returns descriptor-aware masked secret fields
  instead of raw provider or integration secrets. Non-secret descriptor fields
  can still be shown for editing, and echoed mask sentinels preserve the stored
  secret on save.

## High Priority

### Worker Lease Renewal Loss Does Not Cancel Active Execution

Evidence:

- `apps/desktop/src/main/cloud/worker.ts` renews leases while executing
  commands.
- Renewal failures are caught and recorded, but the active command is not
  aborted.

Impact: after lease expiry, another worker can reclaim a command while the
stale worker continues runtime or external side effects. Store writes are
fenced, but side effects outside the store are not.

Target state: propagate renewal loss through an `AbortSignal`, fail or cancel
the active command, and add a regression where renewal fails and another worker
attempts reclaim.

### Telemetry Failure Can Affect Command Correctness

Evidence:

- Composite observability adapters use `Promise.all`.
- Worker success-path metrics are awaited inside command execution.
- OTLP spans and metrics are buffered in arrays and flushed only on explicit
  flush or close.

Impact: a telemetry sink failure can turn an already-executed command into a
worker failure or retry. Long-running OTLP deployments can retain unbounded
telemetry until shutdown.

Target state: make hot-path telemetry best-effort, introduce bounded queues and
drop counters, add periodic OTLP flush, and test a failing adapter during a
successful command.

### Active SSE Streams Can Block Cloud Shutdown

Evidence:

- Cloud HTTP shutdown awaits `server.close()` before closing stream hubs.
- SSE timers and subscriptions clean up on request `close`, but active streams
  may keep the HTTP server open.

Impact: deploys and restarts can hang while clients keep long-lived streams
connected.

Target state: track active SSE responses and sockets, close replay hubs before
awaiting server close, end or destroy active streams on shutdown, and add a
lifecycle test with an open stream.

### Release Gates Do Not Prove Hosted Production Readiness

Evidence:

- CI and release validate the launch evidence manifest without the
  `--require-private-pass` flag.
- The public launch matrix honestly targets `local-self-host-beta`, not managed
  SaaS, GA, or enterprise hosting.

Impact: a release tag can pass while real load, soak, restore, failover, BYOK,
support, and on-call evidence is absent. This is acceptable for the current
public tier, but not for hosted production claims.

Target state: add a separate promotion gate for private beta, public beta, and
GA that runs the private-pass evidence validator plus strict environment
evidence for load, soak, failover, restore, BYOK, support, and rollback.

## Medium Priority

- Linux release artifacts should run the same packaged smoke validation in the
  release workflow that CI already runs for Linux packaged builds.
- Production deployment smoke should have a strict authenticated mode requiring
  Cloud and Gateway tokens, operator checks, mutation flow coverage, token
  revocation, runtime status, and worker heartbeat visibility.
- Workspace coverage gates are too broad and low for deployable workspace code:
  `lines: 40`, `functions: 28`, and `branches: 68`. Split thresholds by
  package/service, remove generated dist noise from source coverage, and fail
  when workspace packages are not represented in coverage inputs.
- Recovery and failover drills are currently evidence wrappers for public CI.
  Add an executable local compose recovery drill and require private
  environment drill evidence for hosted promotion.
- Workspace SSE reconnect replay loads retained events from sequence `0`.
  Add paged replay and earliest/latest event metadata so gap detection does not
  require loading all retained events.
- Expired lease and workflow claim reapers process unbounded expired rows in a
  single transaction. Batch reaping with limits, loop outside the transaction,
  and emit backlog metrics.
- Queue processing needs fairness and backpressure caps across hot sessions,
  gateway deliveries, providers, and bindings.
- Product diff fallback infers OpenCode tool semantics for write/edit tools.
  Prefer SDK `session.diff`; if fallback remains, label synthetic summaries as
  untrusted projection data.
- History replay still has a large heuristic child-task binding path. Persist
  live binding decisions or require explicit child session ids, keeping
  heuristic replay quarantined as fallback.
- Workflow setup policy is duplicated across kickoff prompt, generated agent
  config, and skill text. Centralize policy in a typed source and generate
  downstream text from it.
- `workflows.startDraft` exposes an options contract that the bridge ignores.
  Either implement workspace-aware draft creation or remove the unused options
  surface.
- Dead-code checks omit Gateway workspaces from `knip.json`. Add the Gateway
  app, standalone Gateway, gateway channel, provider packages, and gateway
  testing package, or generate Knip workspaces from `pnpm-workspace.yaml`.
- The vendored docs Mermaid bundle is version-drifted from the locked runtime
  dependency. Add deterministic regeneration/hash checking or build the bundle
  from the locked dependency.
- Public package metadata for `@open-cowork/cloud-client` and
  `@open-cowork/shared` conflicts with docs that describe them as workspace
  packages. Mark them private until npm publishing exists, or add explicit
  npm release, provenance, and support docs.

## Low Priority

- Webhook replay cache eviction is global, not source/org scoped. Add scoped
  caps plus a global cap and test cross-source eviction.
- OCI release verification checks the `v*` image tags but should also verify
  the unprefixed version tags it publishes.
- Cloud compatibility facades remain near their documented budgets:
  `postgres-control-plane-store.ts`, `in-memory-control-plane-store.ts`, and
  `session-service.ts` should be decomposed further before adding major Cloud
  scope, then budgets should ratchet down.
- TypeScript strictness can still improve with staged adoption of
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitOverride`, and stronger promise/`any` lint rules.
- Remaining renderer HTML sinks are intentionally sanitized, but should be
  tracked by an explicit sink registry and regression tests.
- Docs roadmap references should be periodically reconciled with closed GitHub
  issue state so public docs do not imply active work that has already shipped.

## Validation Notes

Commands run locally during this audit included:

```bash
node scripts/run-node-tests.mjs tests/cloud-deployment-artifacts.test.ts
node scripts/run-node-tests.mjs tests/workflow-runtime.test.ts
node scripts/validate-deployment-configs.mjs
node scripts/lint.mjs
node scripts/check-preload-channels.mjs
node scripts/check-shared-dist.mjs
./apps/desktop/node_modules/.bin/tsc -p apps/desktop/tsconfig.main.json --noEmit
./apps/desktop/node_modules/.bin/tsc -p apps/desktop/tsconfig.preload.json --noEmit
git diff --check
```

Local environment limits: `pnpm`, `corepack`, `gh`, Docker, and Helm were not
available in this shell. Docker/Helm checks therefore used the repository's
static deployment validators rather than live `docker compose config` or Helm
template execution.
