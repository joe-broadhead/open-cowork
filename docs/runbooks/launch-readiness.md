---
title: Launch Readiness Gates
description: Load, soak, go/no-go, and release evidence gates for Open Cowork Cloud, Desktop sync, and Gateway launches.
---

# Launch Readiness Gates

Use these gates before treating a deployed Open Cowork Cloud plus Gateway stack
as ready for local/self-host beta, private beta, public beta, general
availability, or enterprise-scale rollout. The same workflow applies to GCP,
AWS, Azure, DigitalOcean, Kubernetes, or a downstream internal platform: supply
the deployed URLs and tokens at runtime; do not encode provider project values
in the repository.

## Target Profiles

Capacity targets live in
`deploy/load/launch-readiness-targets.json`.

- `local-self-host-beta`: OSS self-host and local reference deployment target.
  This is the only launch tier currently accepted by the public evidence
  matrix.
- `private-beta`: design-partner and internal managed BYOK rollout.
- `public-beta`: first public hosted BYOK rollout.
- `enterprise-scale`: large organization readiness target for downstream or
  managed orgs after public-beta evidence is already green.

Each profile defines initial targets for:

- Cloud Web users, Desktop clients, Gateway channels, and SSE streams.
- Stored cloud threads.
- session creation and prompt command throughput.
- active worker sessions.
- workflow run throughput.
- gateway inbound messages and outbound deliveries.
- artifact throughput.
- admin dashboard reads.

Private and public beta are launch gates. `enterprise-scale` is the production
growth gate: run it only after the lower profiles are green and the deployment
has enough database, object-store, worker, and gateway capacity to absorb the
larger thread, SSE, and command queues.

## Current Accepted Tier

The current public launch-evidence matrix lives at
`deploy/load/launch-evidence-matrix.json`. It accepts only
`local-self-host-beta` as a public product claim:

- public Compose, Helm, GCP reference templates, validators, and CI gates are
  coherent enough for OSS/deployer beta evaluation,
- Cloud Web, Desktop cloud sync, and Gateway continuation have public smoke and
  test coverage,
- private hosted beta, public hosted beta, general availability, and
  enterprise-scale readiness are not claimed from public templates alone.

Higher hosted tiers require private operations evidence from the exact target
environment: load/soak reports, restore drills, failover drills, BYOK provider
validation, billing/entitlement evidence, support ownership, and cost/SLO
notes. Store that evidence outside this public repository.

## Required Environment

Set these for deployed load and soak runs:

```bash
export OPEN_COWORK_LOAD_CLOUD_URL=https://cowork.example.com
export OPEN_COWORK_LOAD_GATEWAY_URL=https://gateway.example.com
export OPEN_COWORK_LOAD_CLOUD_TOKEN=...
export OPEN_COWORK_LOAD_GATEWAY_ADMIN_TOKEN=...
export OPEN_COWORK_LOAD_BYOK_PROVIDER=anthropic
export OPEN_COWORK_LOAD_INCLUDE_MUTATIONS=true
export OPEN_COWORK_LOAD_INCLUDE_SSE=true
export OPEN_COWORK_LOAD_OPERATOR_CHECKS=true
export OPEN_COWORK_LOAD_STRICT=true
export OPEN_COWORK_EVIDENCE_COMMIT_SHA="$(git rev-parse HEAD)"
export OPEN_COWORK_EVIDENCE_CLOUD_IMAGE_DIGEST=sha256:REPLACE_WITH_CLOUD_IMAGE_DIGEST
export OPEN_COWORK_EVIDENCE_GATEWAY_IMAGE_DIGEST=sha256:REPLACE_WITH_GATEWAY_IMAGE_DIGEST
```

Optional knobs:

- `OPEN_COWORK_LOAD_PROFILE=local-self-host-beta` (default), `private-beta`,
  `public-beta`, or `enterprise-scale`
- `OPEN_COWORK_LOAD_DURATION_MS=...`
- `OPEN_COWORK_LOAD_CONCURRENCY=...`
- `OPEN_COWORK_LOAD_REQUEST_RATE=...`
- `OPEN_COWORK_LOAD_MAX_MUTATING_SESSIONS=...`
- `OPEN_COWORK_LOAD_MAX_MUTATING_ARTIFACTS=...`
- `OPEN_COWORK_LOAD_MAX_MUTATING_WORKFLOWS=...`
- `OPEN_COWORK_LOAD_BYOK_PROVIDER=...`
- `OPEN_COWORK_LOAD_EXPECT_QUOTA_REJECTIONS=true` for a deliberate
  quota-pressure run after the ordinary zero-unexpected-rejection gate passes
- `OPEN_COWORK_LOAD_OUTPUT_DIR=.open-cowork-test/launch-readiness`
- `OPEN_COWORK_EVIDENCE_COMMIT_SHA=...`
- `OPEN_COWORK_EVIDENCE_CLOUD_IMAGE_DIGEST=sha256:...`
- `OPEN_COWORK_EVIDENCE_GATEWAY_IMAGE_DIGEST=sha256:...`

Use short-lived scoped operator tokens. Never paste BYOK keys, OAuth refresh
tokens, cookie secrets, gateway service tokens, provider webhook secrets, or
GCP project-specific values into committed reports.

## Plan

Generate the operation plan before running traffic:

```bash
OPEN_COWORK_LOAD_PROFILE=local-self-host-beta \
OPEN_COWORK_LOAD_CLOUD_TOKEN=... \
OPEN_COWORK_LOAD_GATEWAY_ADMIN_TOKEN=... \
OPEN_COWORK_LOAD_BYOK_PROVIDER=anthropic \
OPEN_COWORK_LOAD_INCLUDE_MUTATIONS=true \
OPEN_COWORK_LOAD_INCLUDE_SSE=true \
OPEN_COWORK_LOAD_OPERATOR_CHECKS=true \
OPEN_COWORK_LOAD_STRICT=true \
pnpm deploy:load:plan
```

The plan records the selected profile, capacity targets, thresholds, and routes
that will be exercised.

## Load Gate

Run the short stress gate against local Compose and the production-like
deployment.

```bash
OPEN_COWORK_LOAD_PROFILE=local-self-host-beta \
OPEN_COWORK_LOAD_CLOUD_TOKEN=... \
OPEN_COWORK_LOAD_GATEWAY_ADMIN_TOKEN=... \
OPEN_COWORK_LOAD_BYOK_PROVIDER=anthropic \
OPEN_COWORK_LOAD_INCLUDE_MUTATIONS=true \
OPEN_COWORK_LOAD_INCLUDE_SSE=true \
OPEN_COWORK_LOAD_OPERATOR_CHECKS=true \
pnpm deploy:load:strict
```

The harness checks:

- Cloud Web Workbench and bootstrap routes.
- authenticated session, thread/tag/filter, workflow, BYOK, usage, and
  channel-delivery reads.
- session create, prompt enqueue, artifact upload/download, workflow create/run,
  and optional BYOK provider validation mutations.
- workspace SSE fanout.
- operator/admin metrics, projection lag, command age, quota rejection, gateway
  retry, gateway dead-letter, and SSE reconnect thresholds.
- gateway health, readiness, and metrics.

The output is a JSON report plus a Markdown report under
`.open-cowork-test/launch-readiness/` unless `OPEN_COWORK_LOAD_OUTPUT_DIR` is
set. Each report records the command name, commit SHA, image digests, sanitized
environment profile, dates, duration, and pass/fail or go/no-go status.

## Soak Gate

Run the long-duration gate after the load gate is green:

```bash
OPEN_COWORK_LOAD_PROFILE=local-self-host-beta \
OPEN_COWORK_LOAD_CLOUD_TOKEN=... \
OPEN_COWORK_LOAD_GATEWAY_ADMIN_TOKEN=... \
OPEN_COWORK_LOAD_BYOK_PROVIDER=anthropic \
OPEN_COWORK_LOAD_INCLUDE_MUTATIONS=true \
OPEN_COWORK_LOAD_INCLUDE_SSE=true \
OPEN_COWORK_LOAD_OPERATOR_CHECKS=true \
pnpm deploy:soak:strict
```

The soak run is intended to reveal:

- connection leaks.
- stale SSE cursors.
- projection lag growth.
- command backlog growth.
- worker lease renewal/failover problems.
- scheduler claim drift.
- gateway retry loops and dead-letter growth.
- quota/rate-limit pressure that degrades unrelated surfaces.

Attach the generated JSON/Markdown reports and dashboard evidence to the
private release tracking issue or downstream operations repository.

## Go/No-Go

A launch is **go** only when:

- strict load and soak runs pass the selected profile thresholds.
- `pnpm deploy:smoke`, `pnpm deploy:desktop:smoke`,
  `pnpm deploy:gateway:smoke`, and `pnpm deploy:continuation:smoke` pass
  against the same deployment.
- Cloud Web remains usable at target session/thread counts.
- workers and scheduler remain stable under command/workflow load.
- gateway delivery does not wedge on provider or transient failures.
- quotas and rate limits reject runaway usage without taking down the system.
- cost and scaling notes are recorded.
- known limits and follow-up work are explicit.

If a required token, mutation mode, SSE mode, operator mode, or gateway route is
skipped, the result is at best **conditional-go** and must not be treated as a
managed public launch approval.

## Evidence Categories

The launch evidence matrix requires every accepted tier to cover:

- load and soak behavior for Cloud sessions, SSE, workers, workflows, Gateway,
  artifacts, admin pagination, quotas/entitlements, and BYOK denials,
- failover and recovery for workers, scheduler, Gateway cursors, Cloud Web/API
  restarts, object-store failures, and BYOK reveal failures,
- backup and restore for Postgres records, events, projections, workflows,
  Gateway bindings/deliveries, artifacts, snapshots/checkpoints, BYOK refs, and
  audit events,
- security boundaries for secret redaction, operator endpoint separation,
  API-token TTL/scope/revocation, public webhook ingress, trusted-header auth,
  CSP/browser boundaries, package import boundaries, and private-value scans,
- release and packaging gates for Desktop, Cloud Web, Gateway, MCPs, docs,
  deployment validators, SBOM/notices/license checks, private-value scanning,
  script-contract tests, and reference deployment smoke evidence.

## Findings Workflow

Every failed launch-readiness check must have one disposition:

- `immediate-fix`: fix it in the current scope when the failure is narrow and
  safe,
- `narrow-follow-up-issue`: open a focused issue with owner, reproduction,
  evidence, launch tier, and blocking status,
- `tier-scoped-out-of-scope`: explicitly record that the selected launch tier
  does not claim the capability.

Do not reopen broad completed roadmap phases for narrow findings. Do not claim a
higher launch tier while a required category for that tier has missing,
conditional, or private-only evidence.

## Validation

Validate committed launch-readiness artifacts:

```bash
pnpm deploy:launch:validate
```

This checks target profiles, harness coverage, required runbook wording, the
launch evidence matrix, report template, package scripts, and release-checklist
links.
