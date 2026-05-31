# Managed Worker Restore Drill Template

Use this template for a non-production restore drill of the managed worker
service plane. Store completed reports in a private operations repo. Keep this
public template free of real project ids, domains, account ids, customer
details, emails, tokens, provider keys, signed URLs, local paths, and prices.
Do not attach raw backups, live logs, or unredacted diagnostics to a public
issue or pull request.

## Drill Scope

| Area | Included | Evidence |
| --- | --- | --- |
| Postgres control-plane restore | yes | table counts and migration version |
| Object-store artifacts/checkpoints | yes | prefix counts and checksum sample |
| BYOK secret references | yes | secret names/versions only, no plaintext |
| Session projections | yes | restored sequence and replay/repair result |
| Workflow runs | yes | active/running/failed/final states consistent |
| Worker recovery | yes | replacement worker claim and checkpoint restore |
| Scheduler recovery | yes | due workflow claim without double-fire |
| Gateway delivery lag | optional | delivery cursors and retry/dead-letter status |

## Required Procedure

1. Freeze writes or route traffic to maintenance mode.
2. Scale workers, scheduler, and Gateway to zero.
3. Restore Postgres to the selected timestamp.
4. Restore object storage to the same timestamp or version boundary.
5. Start Cloud web only.
6. Verify health, workspace bootstrap, diagnostics, metrics, session lists,
   BYOK metadata, workflow definitions, channel bindings, and audit rows.
7. Start one worker with the restored object-store/checkpoint configuration.
8. Run one bounded smoke prompt and verify checkpoint save.
9. Start scheduler and verify a due workflow claim.
10. Start Gateway and verify delivery cursors resume without duplicate sends.

## Pass/Fail Evidence

| Check | Pass condition | Result |
| --- | --- | --- |
| Postgres restore | sessions, commands, events, projections, workflows, workers, BYOK metadata, usage, audit present | pending |
| Object-store restore | artifact metadata points at existing blobs; checkpoint manifests exist | pending |
| BYOK refs | secret refs resolve to metadata; plaintext is not exported | pending |
| Web-only boot | health, workspace, diagnostics, metrics succeed with operator auth | pending |
| Projection replay/repair | sampled session projection reaches restored event sequence | pending |
| Worker recovery | one replacement worker claims, runs, checkpoints, and finalizes | pending |
| Workflow consistency | due workflow starts once; stale running run is recovered or marked failed | pending |
| Gateway delivery | cursor resumes; retries/dead letters are visible | pending |
| Redaction | diagnostics/log sample has no tokens, provider keys, cookies, signed URLs, private paths, or emails | pending |

## Follow-Ups

| Finding | Severity | Owner | Due date | Status |
| --- | --- | --- | --- | --- |
| Example: checkpoint prefix missing lifecycle policy | high | platform | YYYY-MM-DD | open |

High-severity restore findings block managed production launch until resolved
or explicitly accepted by the operator.
