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

**As of 2026-07-23:** registry `status=partial`, `openMigrateHazards: ["H1","H3","H4","H8","H13"]`.
Experimental multi-replica **still fails** these open migrate hazards — do not market as HA.
Doctor / readiness surface a non-blocking `multi_writer_ownership` check that reports this posture.

## Disposition legend

| Disposition | Meaning |
| --- | --- |
| **migrate** | Must move to fenced durable store before multi-replica |
| **fence** | OK if single writer holds leadership fence only |
| **accept** | Safe as single-daemon process memory; must not be multi-writer |

## Hazard inventory

| ID | Hazard | Location (code) | Disposition | Rationale / owner |
| --- | --- | --- | --- | --- |
| H1 | Channel-sync JSON sidecar (checkpoints, pendingInbound, deliveries) | `products/gateway/src/channel-sync.ts` (`channel-sync.json`, `save` via pid tmp) | **migrate** (not migrated) | Last-writer-wins under two daemons; dual-write to SQLite outbox partially exists but JSON remains coordination. **Single-daemon production shape; multi-replica experimental only.** Proving registry `status=partial` (`docs/development/distributed-ownership-proving-registry.json`). Do not claim migrated until code + suite close the hazard. |
| H2 | channel-sync process-local `syncInFlight` promise | `channel-sync.ts` ~173–175 | **accept** | Single-process debounce only |
| H3 | events.json operational sidecar | `products/gateway/src/wakeup.ts` (`events.json`) | **migrate** (not migrated) | Not append-only cluster log; concurrent writers corrupt. **Single-daemon production shape; multi-replica experimental only.** Proving registry `status=partial`. Do not claim migrated until code exists. |
| H4 | sessions.json worker/session projection | `products/gateway/src/workers.ts` | **migrate** (not migrated) | Multi-daemon session ownership diverges. **Single-daemon production shape; multi-replica experimental only.** Proving registry `status=partial`. Do not claim migrated until code exists. |
| H5 | Scheduler cycle promise (in-process) | `products/gateway/src/scheduler.ts` ~131–133 | **fence** | Two processes both enter schedule; SQLite may serialize tasks but not sidecars |
| H6 | `inFlightSupervisorPrompts` Set | `scheduler.ts` ~251–299 | **accept** | Process-local duplicate prompt guard |
| H7 | SCHEDULER_INSTANCE_ID from pid | `scheduler.ts` ~74 | **fence** | Must bind to durable leadership fencing token |
| H8 | Telegram polling state file | `channels/telegram.ts` → `telegram-polling.json` | **migrate** (not migrated) | Two pollers → duplicate updates. **Single-daemon production shape; multi-replica experimental only.** Proving registry `status=partial`. Do not claim migrated until code exists. |
| H9 | Channel Gateway delivery lanes + inFlight Set | `apps/channel-gateway/src/gateway-runtime.ts` ~178–256 | **accept** | Single appliance process model; not Durable multi-daemon |
| H10 | Warm pools / env maps | `products/gateway/src/environments.ts` (warm pool maps) | **accept** / **fence** | Single-daemon warm pools; multi-daemon needs durable env ownership |
| H11 | Unredacted export rate-limit buckets | `products/gateway/src/unredacted-export-guard.ts` | **accept** | Per-process; multi-daemon weakens limit (documented) |
| H12 | Exposed HTTP rate-limit maps | `products/gateway/src/security.ts` exposedRateBuckets | **accept** | Same as H11 for exposed mode |
| H13 | Notification / send in-flight paths | channel command + sync notification paths (process-local) | **migrate** (not migrated) | Multi-daemon can double-notify without durable send leases. **Single-daemon production shape; multi-replica experimental only.** Proving registry `status=partial`. Do not claim migrated until code exists. |
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
- Open migrate hazards **H1, H3, H4, H8, H13** remain **not migrated** under
  production shape; multi-replica is **experimental only** (Helm fail-closed
  without experimental flag). Proving registry:
  `docs/development/distributed-ownership-proving-registry.json` with
  **`status=partial`** and `openMigrateHazards: ["H1","H3","H4","H8","H13"]`.
- Marketing must not claim multi-AZ / multi-replica HA until those hazards
  migrate in code **and** proving suite reaches `status=ready` (JOE-949).
  Do **not** claim migrated from docs alone.

## Owner

Gateway durability / JOE-931 epic. Update this inventory when sidecars move or new process-local maps are added.
