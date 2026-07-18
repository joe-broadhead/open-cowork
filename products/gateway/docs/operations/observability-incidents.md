# Observability And Incidents

Gateway includes local observability and alerting without requiring external SaaS.

The code-level contract for trace ids, local SLO budgets, source freshness, incident bundles, support exports, audit rows, and release-claim boundaries is `src/observability-contract.ts`, assembled through `buildObservabilitySnapshot()` in `src/observability-snapshot.ts`.

## Metrics

The observability snapshot includes:

- Scheduler configuration and queue counts.
- Run totals, running runs, recent failures, and average runtime.
- Execution environment totals: active, retained, and cleanup failed.
- Cost and token totals recorded on Gateway runs.
- Pending human gates, OpenCode questions, and OpenCode permissions.
- Channel binding count and recent channel failure count.
- OpenCode reachability when checked by HTTP routes.
- Active alert count by severity.
- Roadmap supervisor health, due/leased/stale counts, pending completion proposals, and recent supervisor audit events.
- Trace correlation root plus task, run, channel, evidence, alert, and audit-ledger trace IDs.
- SLO-style local budgets for scheduler latency, run dispatch, channel delivery, progress freshness, Mission Control render time, and recovery time.
- Support operations contract with release boundary, source health, operator actions, incident bundle posture, and unsupported claims.

HTTP:

```text
GET /observability
```

The route returns `trace`, `slo`, and `support` objects alongside metrics, alerts, supervisors, and environments. Trace IDs are deterministic correlation IDs such as `trace_task_*` and `trace_run_*`; raw channel targets, session IDs, local private paths, and token-like evidence refs are hashed or redacted.

MCP:

```text
observability
roadmap_supervisor_observability
```

CLI:

```text
opencode-gateway status
opencode-gateway evidence incident [output-dir] [--alert id] [--task id] [--run id] [--session id] [--roadmap id] [--project id] [--json]
```

`status` prints the current trace root and SLO rollup when the daemon is reachable. `evidence incident` writes a local redacted bundle with `incident.json`, `incident.md`, and a nested redacted evidence bundle.

## Local SLO Budgets

These budgets are local public-release readiness thresholds, not hosted telemetry SLAs:

| Budget | Warn | Fail | Meaning |
| --- | ---: | ---: | --- |
| Scheduler latency | 2m | 5m | Oldest runnable pending work should dispatch or become explicitly blocked. |
| Run dispatch | 1m | 2m | Time from task creation to first run start should remain bounded. |
| Channel delivery | 2m | 5m | Channel failures should settle as sent, retry/backoff, or dead-letter. |
| Progress freshness | 10m | 15m | Running work should have recent progress, lifecycle, or recovery evidence. |
| Mission Control render | 1s | 2s | Dashboard rendering should stay within a local operator budget. |
| Recovery time | 2m | 5m | Expired leases and orphan recovery should be visible and bounded. |

The current implementation evaluates these from local Gateway state. It does not send telemetry to an external service and does not retain long-term metrics beyond local state/evidence artifacts.

## Service-Level Boundary

Gateway uses service-level language to make operator expectations precise without making hosted or compliance claims ahead of evidence.

| Mode | Release Status | SLO Claim | Support Access Boundary | Incident Boundary |
| --- | --- | --- | --- | --- |
| Local public beta | Supported | Local operator SLO budgets are best-effort readiness checks, not an external SLA. | Operator owns local access; share redacted bundles only. | Local incident bundles and operator actions are supported. |
| Local release candidate | Preview | RC SLO claims require elapsed soak evidence and the final readiness decision. | Support remains operator-mediated through redacted artifacts. | Incident workflow is local and evidence-backed. |
| Self-hosted preview | Preview | Self-hosted SLOs require topology, backup, worker, and incident proof per deployment. | Support access requires a separate support principal and customer approval. | Preview incident response uses exported redacted bundles. |
| Team preview | Preview | Team SLOs are bounded to tested team-preview surfaces only. | Support access needs audited role grants and tenant scope. | Team incidents require tenant-scoped redacted bundles. |
| Hosted | Deferred | Hosted SLO/SLA claims are unsupported until hosted telemetry, support, tenancy, and compliance work lands. | No hosted support access path is implemented. | Hosted incident response is deferred. |
| Unsupported modes | Unsupported | No support-grade claim is made. | Support cannot inspect unsupported mode state. | Operators fall back to local redacted evidence only. |

The current support posture (`releaseClaim` in the observability contract) is `local_preview_support_observability_only`. It can prove local/preview observability surfaces; it does not prove hosted SLOs, managed support readiness, compliance monitoring certification, raw transcript telemetry, or provider payload retention.

## Support Operations Contract

`GET /observability` includes a `support` object that keeps Mission Control, readiness, evidence, and incident bundles aligned.

The contract includes:

- `status`: `ready`, `degraded`, or `blocked` based on local SLO failures, critical alerts, and source health.
- `sourceHealth`: trace correlation, SLO budgets, audit ledger, channels, and alerts with source-specific evidence refs.
- `traceCoverage`: counts for scheduler tasks, worker runs, channel targets, evidence refs, audit ledger rows, and alerts.
- `operatorActions`: supported actions, commands, HTTP surfaces, audit operations, and whether the action is safe by default.
- `incidentBundle`: command, manifest shape, and content that must never appear in share-safe output.
- `unsupportedClaims`: explicit claims that this release does not make.

Audited operator actions:

| Action | Command / Surface | Audit Operation | Safe By Default | Purpose |
| --- | --- | --- | --- | --- |
| Pause dispatch | `opencode-gateway operator pause` / `POST /operator/actions action=pause` | `operator.pause` | Yes | Stop new scheduler dispatch while current OpenCode sessions finish. |
| Resume dispatch | `opencode-gateway operator resume` / `POST /operator/actions action=resume` | `operator.resume` | Yes | Resume dispatch after degraded state is understood. |
| Recover and retry | `opencode-gateway operator recover` / `POST /operator/actions action=recover` | `operator.recover` | Yes | Recover expired leases and missing OpenCode runs using bounded retry policy. |
| Rollback state | `opencode-gateway restore --from <backup-path> --maintenance` / `POST /storage/restore` | `storage.restore` | No | Restore a verified backup behind an audited destructive-action gate. |
| Export evidence | `opencode-gateway evidence export <output-dir>` / `GET /evidence/export` | `evidence.export.redacted` | Yes | Write a redacted local evidence bundle for support review. |
| Create incident bundle | `opencode-gateway evidence incident <output-dir>` / `GET /incident-bundle` | `incident.bundle.redacted` | Yes | Write a redacted incident bundle with trace, SLO, alert, audit, and evidence context. |

## Supervisor Observability

Supervisor observability is derived from durable supervisor records and workflow events. It does not inspect or own OpenCode session history beyond the session IDs already stored on supervisors.

The supervisor report includes:

- One row per non-archived supervisor with roadmap title, alias, session, profile, default/watch status, next review time, wake lease state, last result status, and last result summary.
- Health states: `ok`, `due`, `leased`, `stale`, `paused`, `blocked`, and `completed`.
- Rollups for total, active, due, leased, stale, paused, blocked, completed, pending completion proposals, and open human gates.
- Recent audit events for `roadmap.supervisor.*`, `roadmap.completion.*`, `project.binding.*`, and `audit.human_decision`.

Mission Control shows the same report in the Roadmap Supervisors card with recent supervisor audit events. Expired wake leases are treated as stale so operators see stalled supervisor turns before normal queued reviews.

## Alert Lifecycle

Alerts are durable records in `gateway.db`.

States:

- `active`
- `acknowledged`
- `resolved`
- `suppressed`

Each alert includes severity, source, target, summary, evidence, next action, first/last seen timestamps, notification timestamp, and dedupe count.

Gateway dedupes alerts by key and rate-limits notifications through the existing event queue. Alerts never include raw transcripts or unredacted config.

## Durable Outbound Alert Delivery

Outbound delivery is opt-in and disabled by default. Configure one or more already-allowlisted channel targets:

```json
{
  "alerts": {
    "delivery": {
      "enabled": true,
      "maxAttempts": 10,
      "targets": [
        {
          "provider": "telegram",
          "chatId": "operator-chat-id",
          "threadId": "incident-topic-id",
          "minimumSeverity": "warning"
        }
      ]
    }
  }
}
```

Each target must also exist in `security.channelAllowlists` and its provider must have working credentials. `minimumSeverity` is `warning` or `critical`; omit `threadId` for an unthreaded target. Gateway sends active alert campaigns only, uses a stable idempotency key per campaign/target, and records redacted durable events:

- `alert.notification.claimed`
- `alert.notification.sent`
- `alert.notification.failed`
- `alert.notification.ambiguous`
- `alert.notification.dead_lettered`

A claim is committed before the provider call. If Gateway restarts with a claim that has no matching sent or failed outcome, it records the delivery as ambiguous and dead-letters that campaign/target instead of blindly sending a possible duplicate. Confirm provider receipt before creating or renotifying a new campaign.

An ordinary failed campaign is retried on later alert cycles. After `alerts.delivery.maxAttempts` failures for one campaign/target, Gateway records a dead letter and stops retrying that campaign. Repair the target, credentials, allowlist, or provider availability, then create/renotify a new alert campaign; do not treat an in-process failure event as proof that an operator received it. Missing or disabled adapter credentials are delivery failures, never successful no-ops.

## External Dead-Man Requirement

In-process alerts cannot detect total process exit, host loss, power/network isolation, or failure of the alert-delivery loop itself. Any unattended deployment therefore requires an **independent off-host monitor**. At least every 60 seconds, it must make an authenticated request to `GET /readiness`, require HTTP success and JSON `state: "ready"`, and alert through a separate provider after no more than two missed intervals. Reach Gateway through a private VPN or tightly scoped authenticated proxy; do not expose `/readiness` unauthenticated merely to simplify monitoring.

Compose includes an opt-in outbound dead-man profile. It checks authenticated `/readiness` locally and sends a heartbeat only while state is `ready`; an off-host receiver alerts when heartbeats stop:

```bash
install -d -m 700 "$HOME/.config/opencode-gateway/compose-secrets"
printf '%s\n' 'https://deadman.example.invalid/your-secret-heartbeat' > "$HOME/.config/opencode-gateway/compose-secrets/deadman-url"
chmod 600 "$HOME/.config/opencode-gateway/compose-secrets/deadman-url"
docker compose -f docker/docker-compose.yml --profile deadman up -d --build
```

Replace the example with the receiver's private HTTPS heartbeat URL and set its expiry to slightly more than twice `OPENCODE_GATEWAY_DEADMAN_INTERVAL_SECONDS` (default `60`). The URL is a credential and is mounted only into the dead-man service. Because the receiver is off-host, it detects both Gateway/readiness failure (heartbeat withheld) and complete host/Compose failure (heartbeat absent). Test the path by stopping Gateway and confirming the external receiver alerts, then start Gateway and confirm recovery.

## Built-In Rules

Rules cover:

- Heartbeat error or stale heartbeat.
- Stale running scheduler runs.
- Repeated failed, blocked, or errored runs, grouped by stable failure cause and stage when possible.
- Profile health (`profile-health:<profile>`): a scheduler profile whose **genuine** failure rate over the window (default `7d`) exceeds `alerts.profileHealth.maxGenuineFailureRate` (default `0.5`), for profiles with at least `alerts.profileHealth.minRuns` terminal runs. Genuine failure rate uses the run-analytics error-class breakdown, so it excludes operational errored runs (session recovery, force-done, lease expiry), external ones (provider balance, transport, provider error), and unknown ones (errored with no durable result — a crash/abort before the result was written) — it never fires on Gateway run-lifecycle churn or an indeterminate crash. The next action points at `gateway analytics --scorecard --by profile` and names the profile and its genuine failure rate. Configurable and enabled by default via `alerts.profileHealth`.
- Preflight missing-tool failures before OpenCode sessions are created.
- Environment cleanup failures that require operator inspection or cleanup retry.
- Governance budget warning or exhaustion.
- Missing or stale backups.
- Repeated channel send/sync/trust failures.
- Denied sensitive security operations.
- OpenCode unreachable when checked by the daemon route.

## Operator Surfaces

HTTP:

```text
GET /alerts
POST /alerts/{alertId}/action
GET /incident-report?alertId={alertId}
GET /incident-bundle?alertId={alertId}
```

MCP:

```text
gateway_alerts
gateway_alert_action
gateway_incident_report
```

Channels:

```text
/alerts
/alert ack <alertId> [note]
/alert resolve <alertId> [note]
/alert suppress <alertId> [note]
/incident [alertId]
```

Dashboard:

- Alert KPI.
- Active alert card with severity and next action.
- Readiness check fails when critical alerts are active.

## Incident Reports

Incident reports summarize:

- Selected alert state.
- Active, retained, and cleanup-failed execution environment state.
- Recent workflow timeline.
- Root cause hints.
- Follow-up checklist.

Repeated provider failures such as balance, authentication, and quota errors are treated as terminal until configuration or credentials change. Transient OpenCode transport failures retry with bounded backoff and produce grouped warning alerts if they repeat. Alert evidence is redacted before display so token-like or key-like strings are not surfaced in incident summaries.

Use reports as a local starting point for post-incident review, then create durable follow-up tasks for unresolved actions.

## Incident Bundles

Incident bundles are redacted local artifacts intended for debugging and review. They include:

- Bundle manifest with status, trace root, selected alert summaries, counts, SLO results, and redaction note.
- Source freshness rows for trace correlation, SLO budgets, audit ledger, channels, alerts, progress freshness, and evidence refs. Sources render as `green`, `degraded`, `stale`, `blocked`, or `unknown`; unknown and stale sources must be resolved or explicitly accepted before using the bundle as release evidence.
- Failure classification rows for selected alerts, non-passing SLO budgets, degraded/unavailable sources, and missing evidence refs. Each row carries a severity, safe summary, next action, optional trace ID, and redacted evidence refs.
- Output windows for trace task samples, trace run samples, and audit-ledger rows so high-volume incidents are bounded instead of silently truncated.
- Markdown summary with SLO status, alert next actions, trace samples, and a redacted incident report.
- Nested redacted evidence bundle with correlated tasks, runs, sessions, channel bindings, events, and artifacts.

Safe sharing boundary:

- Safe to share: `incident.md`, `incident.json`, and the nested redacted evidence bundle after reviewing them.
- Not safe to share: unredacted evidence exports, raw provider console screenshots, private transcripts, raw channel targets, webhook URLs, bearer tokens, model/provider keys, or local private paths.
- Use `--unredacted --local-admin` only for intentional local debugging; it is not part of public evidence sharing.

Mission Control shows trace/SLO state in Health And Governance and reports degraded observability sources instead of presenting an empty success state.

Current incident bundles are suitable for local redacted evidence; they are not an immutable hosted audit ledger, legal-hold store, or compliance certification. Compliance-grade audit and retention remain future work.

For support handoff, use the [Troubleshooting](troubleshooting.md#operator-and-developer-triage-matrix) triage matrix. It names the safe collection order and what must never be shared before an incident bundle leaves the operator machine.
