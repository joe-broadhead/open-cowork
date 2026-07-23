# Process-local multi-writer hazards inventory (JOE-948)

**Date:** 2026-07-21 (reaffirmed 2026-07-23 post-#961 hardening)
**Scope:** Durable Gateway (`products/gateway`) + Channel Gateway process-local maps
**Related:** JOE-931, JOE-954, `products/gateway/docs/concepts/multi-daemon-scaling.md`
**Proving registry:** `docs/development/distributed-ownership-proving-registry.json`

## Current claim posture (fail-closed)

| Claim | Status |
| --- | --- |
| Single daemon per state directory | **Supported** production shape |
| Experimental multi-replica (`experimentalDistributedOwnership=true`) | **Lab-only** — Helm can set `replicaCount > 1`, but migrate hazards remain open |
| Multi-AZ / production multi-replica HA | **Forbidden** until registry `status=ready` **and** `openMigrateHazards` is empty |

**As of 2026-07-23 (JOE-996 complete):** registry `status=ready`,
`openMigrateHazards: []`. H1/H3/H4/H8/H13 closed in code (channel-sync
coordination SQLite, operational sidecar, notification send leases). Experimental
multi-replica is **lab-only** and still **not multi-AZ HA** — marketing claims
remain fail-closed (`marketingForbiddenClaims`). Doctor / readiness report
`multi_writer_ownership` as ready when the registry is.

## Disposition legend

| Disposition | Meaning |
| --- | --- |
| **migrate** | Must move to fenced durable store before multi-replica |
| **fence** | OK if single writer holds leadership fence only |
| **accept** | Safe as single-daemon process memory; must not be multi-writer |

## Hazard inventory

| ID | Hazard | Location (code) | Disposition | Rationale / owner |
| --- | --- | --- | --- | --- |
| H1 | Channel-sync coordination (checkpoints, pendingInbound, receipts) | `channel-sync-state-store.ts` → `channel-sync.json.sqlite` | **migrated** (JOE-996) | Deliveries / pending inbound / inbound receipts in SQLite with BEGIN IMMEDIATE. Legacy `channel-sync.json` imported once. Outbox already SQLite. |
| H2 | channel-sync process-local `syncInFlight` promise | `channel-sync.ts` ~173–175 | **accept** | Single-process debounce only |
| H3 | events.json operational sidecar | `products/gateway/src/wakeup.ts` → `operational-sidecar.sqlite` | **migrated** (JOE-996) | Bounded operational telemetry now in SQLite (`operational_events`). Legacy `events.json` imported once. Not a cluster log; multi-replica still experimental. |
| H4 | sessions.json worker/session projection | `products/gateway/src/workers.ts` → `operational-sidecar.sqlite` | **migrated** (JOE-996) | Worker projection in SQLite (`worker_sessions`). Legacy `sessions.json` imported once. Multi-replica still experimental. |
| H5 | Scheduler cycle promise (in-process) | `products/gateway/src/scheduler.ts` ~131–133 | **fence** | Two processes both enter schedule; SQLite may serialize tasks but not sidecars |
| H6 | `inFlightSupervisorPrompts` Set | `scheduler.ts` ~251–299 | **accept** | Process-local duplicate prompt guard |
| H7 | SCHEDULER_INSTANCE_ID from pid | `scheduler.ts` ~74 | **fence** | Must bind to durable leadership fencing token |
| H8 | Telegram polling state file | `channels/telegram.ts` → `operational-sidecar.sqlite` | **migrated** (JOE-996) | Cursor in SQLite `channel_poll_cursors` (provider=`telegram`). Legacy `telegram-polling.json` imported once. Two active pollers still need leadership fence for exclusive polling (H1-class coordination residual). |
| H9 | Channel Gateway delivery lanes + inFlight Set | `apps/channel-gateway/src/gateway-runtime.ts` ~178–256 | **accept** | Single appliance process model; not Durable multi-daemon |
| H10 | Warm pools / env maps | `products/gateway/src/environments.ts` (warm pool maps) | **accept** / **fence** | Single-daemon warm pools; multi-daemon needs durable env ownership |
| H11 | Unredacted export rate-limit buckets | `products/gateway/src/unredacted-export-guard.ts` | **accept** | Per-process; multi-daemon weakens limit (documented) |
| H12 | Exposed HTTP rate-limit maps | `products/gateway/src/security.ts` exposedRateBuckets | **accept** | Same as H11 for exposed mode |
| H13 | Notification / send in-flight paths | `operational-sidecar.sqlite` `notification_send_leases` | **migrated** (JOE-996) | OpenCode request notify path acquires exclusive SQLite send leases (multi-process safe). Project/delegation paths already use durable work-event attempting/sent markers. |
| H14 | JSON sidecar backup bundle | `products/gateway/src/storage/internal.ts` `SIDECAR_FILES` | **fence** | Backups capture sidecars; not multi-writer coord |

## Already fenced (partial)

| Mechanism | Location | Status |
| --- | --- | --- |
| SQLite task dispatch transitions | work-store | Single-writer safe for tasks/runs under one DB |
| Daemon leadership lease + fencing token | `daemon-leadership.ts`, work-store db epoch checks | Present for writer/standby experiments |
| Multi-process store contention tests | `__tests__/multi-process-store.test.ts` | Proves DB locking + leadership across processes |
| Helm replicaCount fail-closed | `helm/open-cowork-gateway/templates/deployment.yaml` | Blocks replicaCount>1 unless experimental flag |

## Explicit acceptances (local beta)

- **Single daemon per state directory is the supported production shape.**
- Process-local maps (H2, H6, H9–H12) are acceptable under that shape.
- Open migrate hazards are **empty** after JOE-996 (H1–H13 closed as applicable).
  Multi-replica remains **experimental only** (Helm fail-closed without
  experimental flag). Proving registry:
  `docs/development/distributed-ownership-proving-registry.json` with
  **`status=ready`** and `openMigrateHazards: []`.
- Marketing must **still** not claim multi-AZ / production multi-replica HA —
  that is a product decision beyond migrate-hazard closure (`marketingForbiddenClaims`).

## Owner

Gateway durability / JOE-931 epic. Update this inventory when sidecars move or new process-local maps are added.
