---
title: Launch Readiness Gates
description: Load, soak, go/no-go, and release evidence gates for Open Cowork Cloud, Desktop sync, and Gateway launches.
---

# Launch Readiness Gates

Use these gates before treating a deployed Open Cowork Cloud plus Gateway stack
as ready for private beta, public beta, or managed BYOK SaaS rollout. The same
workflow applies to GCP, AWS, Azure, DigitalOcean, Kubernetes, or a downstream
internal platform: supply the deployed URLs and tokens at runtime; do not encode
provider project values in the repository.

## Target Profiles

Capacity targets live in
`deploy/load/launch-readiness-targets.json`.

- `private-beta`: design-partner and internal managed BYOK rollout.
- `public-beta`: first public hosted BYOK rollout.

Each profile defines initial targets for:

- Cloud Web users, Desktop clients, Gateway channels, and SSE streams.
- Stored cloud threads.
- session creation and prompt command throughput.
- active worker sessions.
- workflow run throughput.
- gateway inbound messages and outbound deliveries.
- artifact throughput.
- admin dashboard reads.

The targets are intentionally first-launch targets, not enterprise SLOs. Raise
them only after production evidence shows Postgres, object storage, BYOK
provider quota, worker leases, SSE fanout, and gateway delivery loops have
headroom.

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
```

Optional knobs:

- `OPEN_COWORK_LOAD_PROFILE=private-beta` or `public-beta`
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

Use short-lived scoped operator tokens. Never paste BYOK keys, OAuth refresh
tokens, cookie secrets, gateway service tokens, provider webhook secrets, or
GCP project-specific values into committed reports.

## Plan

Generate the operation plan before running traffic:

```bash
OPEN_COWORK_LOAD_PROFILE=private-beta \
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
OPEN_COWORK_LOAD_PROFILE=private-beta \
OPEN_COWORK_LOAD_CLOUD_TOKEN=... \
OPEN_COWORK_LOAD_GATEWAY_ADMIN_TOKEN=... \
OPEN_COWORK_LOAD_BYOK_PROVIDER=anthropic \
OPEN_COWORK_LOAD_INCLUDE_MUTATIONS=true \
OPEN_COWORK_LOAD_INCLUDE_SSE=true \
OPEN_COWORK_LOAD_OPERATOR_CHECKS=true \
OPEN_COWORK_LOAD_STRICT=true \
pnpm deploy:load
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
set.

## Soak Gate

Run the long-duration gate after the load gate is green:

```bash
OPEN_COWORK_LOAD_PROFILE=private-beta \
OPEN_COWORK_LOAD_CLOUD_TOKEN=... \
OPEN_COWORK_LOAD_GATEWAY_ADMIN_TOKEN=... \
OPEN_COWORK_LOAD_BYOK_PROVIDER=anthropic \
OPEN_COWORK_LOAD_INCLUDE_MUTATIONS=true \
OPEN_COWORK_LOAD_INCLUDE_SSE=true \
OPEN_COWORK_LOAD_OPERATOR_CHECKS=true \
OPEN_COWORK_LOAD_STRICT=true \
pnpm deploy:soak
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

## Validation

Validate committed launch-readiness artifacts:

```bash
pnpm deploy:launch:validate
```

This checks target profiles, harness coverage, required runbook wording, the
report template, package scripts, and release-checklist links.
