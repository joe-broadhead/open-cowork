# Private campaign evidence checklist (JOE-993)

**Status:** Public monorepo path for collecting private campaign evidence  
**Does not unlock hosted go by itself** — public package COMPLETE ≠ go  
**Linear:** [JOE-993](https://linear.app/joe-broadhead/issue/JOE-993/launch-private-beta-campaign-evidence-path-unlock-hosted-go)  
**Related:** `ops-evidence-package.md`, `private-beta-go-no-go.public.md`, `launch-evidence-record.template.json`

This checklist is the **operator run path** for the private campaign items that
still block hosted private-beta `go`. Attach real records to a **private**
operations store (not this repo). Publish only redacted summaries + checksums.

## Rules

1. Do **not** commit secrets, customer names, live URLs, tokens, digests of
   customer data, or raw logs into this monorepo.
2. Keep `private-beta-go-no-go.public.md` at **`Decision: no-go`** until every
   blocking row has private evidence + redacted public summary + sign-off.
3. Prefer `pnpm deploy:launch:evidence:validate -- --manifest <private-record> --require-private-pass`
   against a **private** copy of the launch evidence record.
4. After private pass: update public redacted rows, flip go/no-go only with
   release + support + security/redaction sign-off.

## Blocking evidence rows

Copy each row into a private launch evidence record. Public status remains
`pending-private-evidence` until the private record is complete.

| Evidence id | Campaign action (private) | Public redacted summary template | Commands / docs |
| --- | --- | --- | --- |
| `deployedLoadTest` | Strict load against production-like env | Pass/fail, profile name, max error %, p95 bands (no URLs/tokens) | `OPEN_COWORK_LOAD_PROFILE=private-beta pnpm deploy:load:strict` + digests |
| `deployedSoakTest` | Soak ≥ private-beta soak duration | Duration, overall error %, SLO hold | `OPEN_COWORK_LOAD_PROFILE=private-beta pnpm deploy:soak:strict` |
| `postgresBackupRestore` | Live non-prod restore drill | Pass/fail, restore window class | `docs/runbooks` backup/restore; `pnpm ops:validate` public only |
| `objectStoreArtifactRoundTrip` | Artifact PUT/GET on target store | Pass/fail, store class only | Same restore package |
| `byokRedactionNoPlaintext` | Live provider validation on target | Provider id + status only | Never plaintext keys; unit coverage already public-ready |
| `supportIncidentOwnershipEscalation` | Signed roster + on-call channel | Role names + coverage hours (no personal emails in public) | `docs/runbooks/private-beta-support.md` |
| `deployedDesktopWebGatewayContinuation` | Deployed continuation smoke | Pass/fail surfaces | `pnpm deploy:continuation:smoke` against target |
| `workerFailover` | Crash/restart drill | Failover class + recovery time band | Managed workers runbooks |
| `schedulerReplicaFailover` | Scheduler failover drill | Same | Lab experimental only; not multi-AZ HA claim |
| `gatewayDeliveryReplayDeadLetter` | Replay / DLQ drill | Pass/fail | Gateway ops docs |
| `quotaRateLimitBehavior` | Deployed quota probes | Pass/fail | SaaS ops |
| `billingEntitlementGating` | Entitlement probes | Pass/fail; `cloud.billing.provider=none` boundary | Billing boundary runbook |
| `secretAdapterResolution` | KMS/secret adapter on target | Adapter class only | Managed workers / secrets |
| `costSloNotes` | Cost/SLO sheet (private) | Aggregate bands only | Product ops |
| `releaseRollback` | Rollback rehearsal | Pass/fail + communication class | Release checklist |

## Redacted public summary shape

For each completed private item, fill
`deploy/private-beta/redacted-evidence-summary.template.md` (one file or one
section per evidence id) and link the private checksum in the private record.

Required fields:

- Evidence id
- Decision: `pass` | `fail` | `blocked`
- Date (UTC)
- Redacted notes (no secrets/customers/URLs)
- Private evidence checksum or immutable ref
- Follow-up issue id (if any)
- Sign-off roles (release / support / security-redaction)

## Validation (public monorepo)

```bash
pnpm deploy:private-beta:validate
pnpm deploy:launch:validate
pnpm deploy:launch:evidence:validate
pnpm ops:validate
```

Private-only (outside monorepo CI):

```bash
pnpm deploy:launch:evidence:validate -- --manifest <private-record> --require-private-pass
pnpm deploy:promotion:validate -- --tier private-hosted-beta --manifest <private-record>
```

## Exit criteria for JOE-993

- [ ] Every blocking row above has private evidence attached offline
- [ ] Redacted public summaries published (or rows still honestly `pending-private-evidence`)
- [ ] `private-beta-go-no-go.public.md` only becomes `go` after private pass + triple sign-off
- [ ] Public claim tier remains honest (`local-self-host-beta` until go)
