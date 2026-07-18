# Work-Store Safety Harness

`src/work-store.ts` is the current durable-state hub for Gateway. It owns schema creation, roadmap state, task state, run leases, workflow events, channel bindings, project bindings, human gates, promotion state, delegation receipts, supervisor wakeup receipts, alert rows, and the append-only local audit ledger foundation.

`src/work-store/schema.ts` owns schema inspection, while `src/work-store/repositories.ts` names backend-neutral repository domains, operation groups, and transaction ownership. These modules are contracts around the current monolith, not a backend split and not a hosted/team storage claim. `src/work-store/run-lease-port.ts` deepens the first mutation cluster as a scheduler-facing run/lease/dispatch port backed by local SQLite, and `src/work-store/bindings-port.ts` deepens the next cluster as a channel/HTTP-facing project binding and mirrored channel binding port backed by local SQLite.

Every repository domain also carries an explicit ownership contract that names the mutation entry
point and the tables it owns. `validateCurrentWorkStoreMutationContracts()` fails if a table has no
owner, a table has multiple owners, or a selected port domain stops using a port entry point. This
is local SQLite single-operator evidence only; it prevents unsafe future splits from losing table
ownership.

Gateway remains a single-operator, local-first tool, but `gateway.db` now has a durable SQLite
`user_version`. `openWorkDb` adopts legacy version-0 files, applies ordered migrations and the
version update in one `BEGIN IMMEDIATE` transaction, and rejects a database created by a newer
binary before publishing a connection. Migrations must preserve existing rows and include a
focused rollback test; destructive downgrade or automatic database recreation is not supported.

Backup restore uses a state-directory journal plus staged old/new generations. If restore stops
after replacing only some files, the next storage open rolls the journal forward when all staged
digests remain valid, or restores every rollback copy when roll-forward is no longer possible.

The file is intentionally still monolithic. The next split should be mechanical and guarded by characterization tests, not a broad rewrite.

`local_sqlite` is the only supported public-local-beta backend; the config layer rejects any other `storage.backend` value. Postgres-compatible, self-hosted team, hosted control-plane, and multi-tenant storage remain future implementation work (the original milestone-era backend strategy documents live in Git history; see the [Decision Log](../history/decision-log.md)).

## Current Responsibility Map

| Domain | Current responsibilities | Suggested module boundary |
| --- | --- | --- |
| Schema | `openWorkDb`, transactional version checks/migrations, schema inspection, and table/index creation. | `work-store/schema.ts` owns schema versions, migrations, and inspection. |
| Core work graph | Roadmaps, tasks, dependencies, readiness, stage transitions, current run pointers, and roadmap recomputation. | `work-store/work-items.ts` plus shared transaction helpers. |
| Runs and leases | Run creation, dispatch receipts, lease renewal, expired lease recovery, orphan recovery, attribution, environments, and active-run ownership. | `work-store/run-lease-port.ts` owns the scheduler-facing port; deeper table extraction can still move SQLite row code behind that port later. |
| Supervisors | Roadmap supervisors, wakeup acquisition, wakeup receipts, completion, cursor advancement, and wake reason normalization. | `work-store/supervisors.ts`. |
| Delegation | Delegated work creation, idempotency receipts, progress receipts, and callback links. | `work-store/delegation.ts`. |
| Project and channel bindings | Project aliases, channel-scoped bindings, mirrored `channel_bindings` rows, and context resolution. | `work-store/bindings-port.ts` owns the edge-facing port; future table extraction can move SQLite row code behind that port later. |
| Human gates | Gate creation, decisions, timeouts, audit events, and task mutation side effects. | `work-store/gates.ts`. |
| Promotions and agent quality | Scorecards, promotion decisions, rollback checks, and config revision updates. | `work-store/promotions.ts`. |
| Alerts and observability rows | Alert upsert/listing, dedupe counts, workflow events, and retention pruning. | `work-store/events.ts` and `work-store/alerts.ts`. |
| Audit ledger | Normalized redacted audit rows derived from high-value work events, source event backfill, and hash-chain evidence for local incident bundles. Retention maintenance (`runWorkStoreRetentionMaintenance`, invoked at daemon startup and daily) prunes the oldest rows past the policy window/row cap and records the last pruned entry hash as a meta anchor so hash-chain verification of the retained suffix still passes. | `audit-ledger.ts` for mapping/redaction; future storage extraction can move table IO into `work-store/audit-ledger.ts`. |
| Run and receipt retention | The same daily `runWorkStoreRetentionMaintenance` pass also bounds the other unbounded tables. Runs: prunes only terminal runs older than `storage.retention.runsMaxAgeDays` (default 90) that are neither a task's most-recent run (preserving `getWorkQueueSnapshot`/`listWorkTaskViews` `lastRun` regardless of age) nor its `current_run_id`; the analytics/governance read windows are always shorter than the 60-day floor. Receipt tables (`task_dispatch_receipts`, `supervisor_wakeup_receipts`, `delegation_progress_receipts`, `delegation_progress_route_receipts`) are idempotency/lease/delivery ledgers with no full-history consumer, so idle rows past `storage.retention.receiptsMaxAgeDays` (default 90) are pruned while active leases/pending deliveries are kept. Both prunes are chunked (one bounded transaction per batch) off the hot path. | `work-store.ts` (`enforceRunRetention`, `enforceReceiptRetention`). |
| Serialization | Row-to-record normalization, JSON parsing, validation helpers, and stable projections. | A future `work-store/rows.ts` (not yet created); keep domain-specific validators close to each module once split. |

## Invariant Harness

`src/__tests__/work-store-invariants.test.ts` is the split safety harness. It protects behavior that future module extractions must preserve:

- schema table/column/index signature drift;
- one active run per task through the public start API;
- delegation receipt durability;
- supervisor wakeup receipt acquisition and completion;
- project binding to channel binding mirroring;
- audit ledger table/schema ownership and hash-chain rows;
- backup metadata compatibility for the combined state graph.

Any schema change should update the expected schema signature and storage/release evidence in the same PR, and recreate the local database rather than migrate an old one. If a future split only moves code, the signature should not change.

Backup metadata includes a schema summary with the backend mode, release status, schema signature, tables, and repository domains. This is a descriptive receipt for the current backup; it does not make Postgres-compatible, self-hosted, or hosted storage available.

The run/lease port is the first domain port used by a production caller. `scheduler.ts` consumes `createSqliteWorkStoreRunLeasePort()` for dispatch receipts, run start, lease renewal, and recovery so the scheduler no longer knows which individual work-store functions own those mutations. Contract coverage lives in `src/__tests__/work-store-run-lease-port.test.ts` for the `runs_leases` operation groups.

The bindings port is the second selected mutation port. `channel-commands.ts` and `daemon-routes/work.ts` consume `createSqliteWorkStoreBindingsPort()` for project binding listing, context resolution, upsert/update/delete, and mirrored channel binding lookups. Contract coverage lives in `src/__tests__/work-store-bindings-port.test.ts` and verifies local SQLite behavior, fail-closed conflict/malformed-input handling, channel row mirroring, and channel row cleanup for the same `bindings` operation groups.

## Split Rules

1. Keep public API behavior stable before moving call sites.
2. Move one domain at a time behind existing exports.
3. Keep `mutateWorkState` or its replacement as the only transaction boundary for multi-table work mutations.
4. Do not let a domain module write related rows without also preserving its receipts/events.
5. Keep storage backup counts and recovery drills green after each split.
6. Keep `validateCurrentWorkStoreMutationContracts()` green whenever schema tables, domain owners,
   operation groups, or ports change.
7. Run the invariant harness, `npm run verify`, and strict docs before opening a PR.

## Production-Agent Follow-Ups

Completed: schema inspection already lives in `src/work-store/schema.ts`.

Pending (in order):

1. Extract row mappers and normalization helpers into a new `src/work-store/rows.ts` without changing table writes (this module does not exist yet).
2. Move the run/lease port implementation from wrapper calls to an internal SQLite adapter once callers are stable behind the port.
3. Move the bindings port implementation from wrapper calls to an internal SQLite adapter once channel/HTTP callers are stable behind the port.
4. Extract delegation receipt operations after binding extraction, preserving delegation receipts.
