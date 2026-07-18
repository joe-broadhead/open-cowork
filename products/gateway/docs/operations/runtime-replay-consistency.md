# Runtime Replay Consistency

The M59 runtime replay consistency harness is a local operator report for
durable work state. The operator command and the in-process builder read the
SQLite work-store tables, durable work events, route receipts, Mission Control
summary data, and redacted evidence export metadata, then emit an owner-mapped
report from `src/runtime-replay-consistency.ts`.

This is local public-beta evidence only. It does not expand the release claim,
does not replace backup/restore, and does not promise unattended recovery.

## Covered Surfaces

- Tasks, runs, worker leases, and task dispatch receipts.
- Delegation accepted/mapped/progress events and progress route receipts.
- Project bindings, channel bindings, and active session links.
- Mission Control dashboard summaries.
- Redacted evidence export manifests.

## Diagnostics

Every finding includes:

- `owner`: the owning runtime surface such as `work-store/run-lease-port`,
  `delegation-progress`, `channel-sync`, or `mission-control`.
- `surface`: the affected read-model or durable table family.
- `entityKind` and `entityId`: safe identifiers; session/channel/delegation
  targets are hashed.
- `severity`: `warning` or `critical` for fail-closed runtime issues.
- `safeRepairAction`: the operator-safe next step.
- `repairMode`: `automatic`, `operator_confirmed`, or `blocked`.

Unsafe repairs are never marked automatic. Critical findings require
operator-confirmed repair or are blocked until evidence is restored.

## Generate A Report

Generate JSON from the current Gateway state directory:

```bash
opencode-gateway evidence replay-consistency --json
```

Write the report to a file:

```bash
opencode-gateway evidence replay-consistency ./runtime-replay-consistency-report.json
```

When checking live session ownership, pass every currently linked OpenCode
session ID. If `--active-session` is omitted, the harness still checks durable
state, events, delegation, channel/project bindings, dashboard summary, and
evidence export safety, but it does not claim a session is currently linked.

```bash
opencode-gateway evidence replay-consistency --active-session ses_abc --active-session ses_def --json
```

Report statuses:

- `pass`: no findings; the report can be recorded as local-beta replay evidence.
- `warn`: diagnostics require repair or regeneration before relying on that
  surface as evidence.
- `fail`: at least one critical finding blocks runtime promotion until an
  operator-confirmed or blocked repair path is completed.

## Recovery Boundary

The harness classifies repair scope instead of mutating state directly:

- `rebuildable`: durable rows/events can regenerate the read-model.
- `best_effort`: state can be replayed, but a live channel or callback may need
  external confirmation.
- `operator_intervention_required`: active leases and session links require an
  operator-visible recovery command before new runtime claims are accepted.

Typical safe actions:

- Missing recent task/run events: compare backup or audit evidence before
  synthesizing a replacement event.
- Duplicate delegated progress: dedupe exact duplicates automatically; require
  operator confirmation for conflicting payloads.
- Expired leases or orphaned sessions: run the existing work-run recovery port
  before accepting result packets.
- Stale or orphaned route receipts: repair the parent session or trusted channel
  target, then rerun delegated progress delivery.
- Unsafe evidence export: regenerate in redacted mode before sharing.

## Required Gates

Run the focused replay test before using the report as evidence:

```bash
npx vitest run src/__tests__/runtime-replay-consistency.test.ts
```

For a release-bound change, also run:

```bash
npm run typecheck
npm run evidence:safety
npm run build
npm run release:check
npm run verify
uv run --with-requirements docs/requirements.txt mkdocs build --strict
```
