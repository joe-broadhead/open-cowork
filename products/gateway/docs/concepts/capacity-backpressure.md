# Capacity And Backpressure

Gateway is a local control plane around OpenCode. It must not dispatch more work than the local operator, OpenCode server, configured agent profiles, channels, or execution environments can safely absorb.

Capacity policy is deliberately conservative by default. Small local use keeps the existing behavior: `scheduler.maxConcurrent` limits total running stages, and advanced per-dimension limits are empty unless configured. Operators can add narrower quotas when they are running larger agent fleets or proving release readiness.

## Capacity Dimensions

| Dimension | Config | What It Protects |
| --- | --- | --- |
| Global scheduler | `scheduler.maxConcurrent` | Total running and starting OpenCode stage sessions. |
| Stage lane | `scheduler.stageConcurrency.<stage>` | Review, verify, audit, or other stage lanes. |
| Profile | `scheduler.profileConcurrency.<profile>` | Agent profile/model/tool budgets. |
| Agent team | `scheduler.capacity.teamConcurrency.<team>` | Deterministic team fan-out. |
| Roadmap/project | `scheduler.capacity.roadmapConcurrency.<roadmapId>` | One initiative/project from starving the queue. |
| Channel provider | `scheduler.capacity.channelConcurrency.<provider>` | Channel-bound work that can generate notifications. |
| Environment backend | `environments.maxConcurrent`, `environments.backendMaxConcurrent`, and environment `resources.maxConcurrent` | Local process, container, or remote execution capacity. |

When a runnable task cannot start because capacity is full, Gateway keeps it pending, preserves existing task notes such as `Workdir: ...`, appends a `Capacity wait:` note line, and writes a workflow event with redacted details. Global scheduler overflow is recorded as `capacity.admission.queued` without a retry timer so work can start as soon as a slot frees. Narrow capacity holds such as team, roadmap, channel, or environment limits use a short `earliestStartAt` retry window and `capacity.admission.delayed`.

## Operator Visibility

Capacity state appears in:

- `opencode-gateway operator status`
- Mission Control's Operator Cockpit
- Workflow events for delayed admissions
- Channel sync outbox summaries for provider backoff and dead letters

The compact operator view shows available scheduler slots, pending pressure, full or pressured dimensions, provider retry-after windows, and dead-lettered channel deliveries.

## Channel Backoff

Channel sync uses a durable SQLite outbox. A send attempt only advances the delivery checkpoint after the provider send succeeds. Rate-limit failures keep the message pending and set `retry_after`; Gateway pauses delivery for that provider until the retry window expires. Terminal delivery failures or repeated failures move the row to `dead_letter` and require operator action. Dead-lettered messages are not checkpointed as delivered. Settled rows are receipts, not queue entries: periodic outbox maintenance deletes `delivered` rows after 7 days and `dead_letter` rows after 30 days so the outbox does not grow with all-time chat volume.

Channel sync polling also applies idle backpressure. The OpenCode session API has no since-cursor, so each poll refetches the bound session's transcript; sessions with no unseen messages back off exponentially (up to 60 seconds between polls) and snap back to the base interval when inbound channel traffic or an OpenCode session event signals fresh activity.

The default channel policy is:

- `channelSync.providerBackoffMs`: `60000`
- `channelSync.maxDeliveryAttempts`: `10`

Provider responses with `429`, `rate limit`, `too many requests`, `retry_after`, or `retry after` are treated as rate limits. Provider responses such as `401`, `403`, invalid token, bad request, or chat not found are treated as terminal delivery failures.

## Release Boundary

These controls are local-first backpressure. They are not cloud autoscaling, paid provider quota management, or hosted multi-tenant scheduling. Multi-host queue leases, worker heartbeats, split-brain prevention, and recovery rules remain future work. Remote filesystem, network, secret, cleanup, and evidence boundaries are documented in [Runtime Isolation](../configuration/runtime-isolation.md). Tenant quotas, cost accounting, budget admission, and hosted storm suppression remain future work. None of these are public execution claims until implementation and fault evidence land. Public release claims must stay bounded to the evidence captured by scheduler stress tests, channel retry tests, and Mission Control rendering tests.
