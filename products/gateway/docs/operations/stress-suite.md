# Deterministic Stress Suite

The deterministic stress suite is the quick operator and CI check for scheduler, channel sync, and recovery invariants. It uses fake OpenCode sessions and channel adapters so it can run without live Telegram, WhatsApp, Discord, or provider credentials.

Run the quick suite:

```bash
npm run test:stress
```

Run the extended local suite:

```bash
npm run test:stress:extended
```

The extended mode increases fixture volume only. It is intended for local/nightly evidence, not for claiming production certification.

## Covered Invariants

The suite checks:

- repeated scheduler ticks and overlapping tick requests never create more than one active run for the same task,
- completed waves advance through the queue without duplicate run IDs,
- channel sync checkpoints survive bridge restarts and noisy replay without duplicate outbound sends,
- expired scheduler leases recover idempotently,
- orphaned OpenCode runs recover idempotently,
- transient prompt dispatch failures fail the current run, abort the new session, and leave the task eligible for retry,
- a completion race cannot overwrite a manual task action.

## Diagnostics

Failures include compact diagnostics with task counts, run counts, active run counts by task, delivered channel keys, and recovery event counts. These diagnostics are designed to point to the invariant that failed without using wall-clock performance thresholds.

## When To Run

| Mode | Command | Use |
| --- | --- | --- |
| Quick | `npm run test:stress` | PR and local regression check. Runs in normal `npm test`. |
| Extended | `npm run test:stress:extended` | Manual/nightly confidence check with larger deterministic fixture counts. |

If the stress suite fails, do not treat it as flaky by default. Inspect the diagnostic output first, then check recent changes in scheduler leases, channel checkpoints, work-store recovery, and OpenCode prompt dispatch paths.
