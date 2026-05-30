---
title: Launch Readiness Report
description: Go/no-go report template for Open Cowork Cloud, Desktop sync, and Gateway launch evidence.
---

# Launch Readiness Report

Use this report as the release evidence record for each private-beta,
public-beta, or managed rollout candidate. Generated harness output should be
attached from `.open-cowork-test/launch-readiness/` or copied into a downstream
private operations repository with secrets and project-specific identifiers
redacted.

## Release Candidate

- Environment:
- Cloud URL:
- Gateway URL:
- Image tags:
- Helm/Compose/Terraform revision:
- Target profile: `private-beta` or `public-beta`
- Report owner:
- Date:

## Go/No-Go

- Decision: `go`, `conditional-go`, or `no-go`
- Decision owner:
- Reviewers:
- Conditions or blockers:
- Follow-up issues:

## Load Test Report

Attach the JSON and Markdown output from:

```bash
OPEN_COWORK_LOAD_PROFILE=private-beta \
OPEN_COWORK_LOAD_BYOK_PROVIDER=anthropic \
OPEN_COWORK_LOAD_INCLUDE_MUTATIONS=true \
OPEN_COWORK_LOAD_INCLUDE_SSE=true \
OPEN_COWORK_LOAD_OPERATOR_CHECKS=true \
OPEN_COWORK_LOAD_STRICT=true \
pnpm deploy:load
```

Summarize:

| Area | Target | Actual | Result | Notes |
| --- | --- | --- | --- | --- |
| Cloud Web reads | | | | |
| session list/search/filter | | | | |
| session create/prompt throughput | | | | |
| worker lease renewal/failover | | | | |
| SSE fanout/reconnects | | | | |
| projection/event lag | | | | |
| workflow scheduler claims | | | | |
| gateway inbound/outbound delivery | | | | |
| artifact metadata/object-store access | | | | |
| admin dashboard reads | | | | |
| BYOK runtime injection path | | | | |

## Soak Test Report

Attach the JSON and Markdown output from:

```bash
OPEN_COWORK_LOAD_PROFILE=private-beta \
OPEN_COWORK_LOAD_BYOK_PROVIDER=anthropic \
OPEN_COWORK_LOAD_INCLUDE_MUTATIONS=true \
OPEN_COWORK_LOAD_INCLUDE_SSE=true \
OPEN_COWORK_LOAD_OPERATOR_CHECKS=true \
OPEN_COWORK_LOAD_STRICT=true \
pnpm deploy:soak
```

Record:

- Duration:
- Max error rate:
- p95 read latency:
- p95 mutation latency:
- p95 gateway latency:
- max command queue depth:
- max oldest command age:
- max projection lag:
- SSE reconnect count:
- gateway retry/dead-letter count:
- worker heartbeat gaps:
- scheduler heartbeat gaps:
- memory/CPU trend:
- connection pool trend:

## Final Smoke

- [ ] `pnpm deploy:smoke`
- [ ] `pnpm deploy:desktop:smoke`
- [ ] `pnpm deploy:gateway:smoke`
- [ ] `pnpm deploy:continuation:smoke`
- [ ] provider-specific smoke such as `pnpm deploy:gcp:smoke` where applicable

## Cost And Scaling Notes

- cloud web replica count and observed CPU/memory:
- worker replica count and observed CPU/memory:
- scheduler replica count and observed CPU/memory:
- gateway replica count and observed CPU/memory:
- Postgres tier, connection count, and slow-query notes:
- object-store request/egress notes:
- BYOK provider quota notes:
- estimated hourly/day cost at observed load:
- autoscaling or manual scaling guidance:

## Known Limits

- user/session/thread count limit before next retest:
- worker/session concurrency limit before next retest:
- gateway/channel delivery limit before next retest:
- artifact size/rate limit before next retest:
- unavailable provider/channel features:
- operational caveats:

## Rollback And Support

- rollback image/tag:
- rollback owner:
- support escalation owner:
- incident channel:
- diagnostics bundle location:
- redaction confirmed:
