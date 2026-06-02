# Production Readiness Audit

Last updated: 2026-06-02.

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

The remaining work is concentrated in two areas:

- maintainability guardrails for the largest Cloud compatibility facades and
  generated or vendored surfaces
- shutdown and backpressure behavior for long-lived Cloud streams and queues

## Verified Baseline

- GitHub code scanning: 0 open alerts on `master` at
  `9de8383f3eb945d715a731ecea93398b5ab7509a`.
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
- Cloud worker command execution now aborts on lease-renewal loss, propagates
  `AbortSignal` through runtime command calls, uses stable OpenCode message IDs
  for prompt retries, and has regressions for active and cached lease renewal
  failure paths.
- Cloud observability hot paths are best-effort: composite adapters isolate
  failing sinks, worker/scheduler/HTTP record helpers suppress telemetry sink
  failures, and OTLP export uses bounded queues, drop counters, and periodic
  flush.
- Cloud HTTP shutdown now closes replay polling and active SSE streams before
  awaiting `server.close()`, with lifecycle regressions for open streams and
  shutdown during replay loading.
- Release promotion now has a separate tier-aware validator. CI and release
  preflight prove the public `local-self-host-beta` claim, and hosted
  promotion requires a private manifest with `private-pass` evidence plus
  strict per-item report metadata for load, soak, failover, restore, BYOK,
  support, rollback, commit SHA, image digests, and sanitized environment
  profile.
- Dead-code coverage now includes all source workspace packages in `knip.json`,
  including Gateway apps, channel/provider packages, and gateway test utilities.
  `tests/package-scripts.test.ts` derives the expected workspace list from
  actual `apps/*`, `packages/*`, and `mcps/*` package directories so future
  source workspaces cannot silently fall out of the dead-code gate.
- Cloud and Gateway Helm charts now default service-account token automounting
  to `false`; Gateway has an explicit service-account opt-in surface, and the
  static deployment validator checks the rendered chart templates keep that
  control wired.
- Dependabot now governs the digest-pinned Cloud and Gateway Dockerfiles with
  monthly Docker ecosystem updates, and contributor setup docs now match the
  enforced Node `>=22.12` engine.
- Telegram webhook ingress now deduplicates authenticated `update_id` values
  before handing updates to grammy, releases the claim if handling fails, and
  preserves Telegram `update_id` as the provider event id when mapping messages
  and callback interactions.
- Workflow run threads now start the same session-status reconciliation safety
  net used by normal prompts. If a runtime `session.idle` event is missed, the
  status poll fallback finalizes the saved workflow run instead of leaving it
  `running` until restart recovery marks it failed.
- Release policy now verifies the exact documented desktop artifact matrix
  before publish eligibility: macOS `x64`/`arm64` `.dmg` and `.zip`, Linux
  `x64` `.AppImage` and `.deb`, plus signed-only `latest-mac.yml` feed
  metadata. Fixture tests reject missing formats, missing architectures, and
  unexpected installer artifacts.

## High Priority

No open high-priority findings remain after the current audit remediations.

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
node scripts/run-node-tests.mjs tests/package-scripts.test.ts
./apps/desktop/node_modules/.bin/tsc -p apps/desktop/tsconfig.main.json --noEmit
./apps/desktop/node_modules/.bin/tsc -p apps/desktop/tsconfig.preload.json --noEmit
git diff --check
```

Local environment limits: `pnpm`, `corepack`, `gh`, Docker, and Helm were not
available in this shell. Docker/Helm checks therefore used the repository's
static deployment validators rather than live `docker compose config` or Helm
template execution.

`knip --production --files` could not execute in this macOS workspace because
Knip's native `oxc-parser` binding was rejected by the local Node runtime
code-signing loader. CI's Linux `pnpm lint:dead-code` job remains the
authoritative executable proof for the dead-code gate.
