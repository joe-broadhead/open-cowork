# Private-beta launch / ops evidence package

**Date:** 2026-07-21
**Linear epic:** JOE-922
**Children:** JOE-958 (load/soak), JOE-960 (restore), JOE-961 (BYOK), JOE-968 (support), JOE-971 (go/no-go)
**HEAD:** `0f28fb8836230907cfee7e9028bcaf648da8a5e3` (`fix/milestone-post-958-quality-signal`)
**Profile:** `private-beta` (design-partner managed BYOK)
**Public claim tier:** remains **`local-self-host-beta` only**
**Hosted private-beta decision:** **`no-go`** until private ops records pass (see `deploy/private-beta/private-beta-go-no-go.public.md`)

This package is the **public-repo** side of JOE-922. Real customer logs, domains, digests from a live target, support rosters, and metrics exports stay outside this repository per `docs/runbooks/managed-byok-saas-boundary.md`.

---

## 1. Public package readiness (verified this date)

| Command | Result | Notes |
| --- | --- | --- |
| `pnpm deploy:private-beta:validate` | **pass** | Package files, boundary phrases, evidence defaults |
| `pnpm deploy:launch:validate` | **pass** | Targets, matrix, report templates, private-beta gates |
| `pnpm deploy:launch:evidence:validate` | **pass** | Manifest template shape |
| `pnpm ops:validate` | **pass** | Ops readiness + release gates + OpenCode pin 1.18.1 |
| `node --test tests/launch-readiness.test.ts` | **6/6 pass** | Harness, matrix, failover dry-run, plan default |
| `OPEN_COWORK_LOAD_PROFILE=private-beta pnpm deploy:load:plan` | **pass** | Plan written (local default URLs; no tokens) |

### Private-beta load plan snapshot (public-safe)

Generated at package date for profile `private-beta`:

| Field | Value |
| --- | --- |
| Mode | `plan` only (not strict load/soak) |
| Capacity | 25 cloud users, 10 Desktop, 5 gateway channels, 50 SSE streams |
| Thresholds | max overall error 1%, p95 read 750ms, p95 mutation 1500ms, max command age 30s |
| Cloud/Gateway URLs | plan defaults `127.0.0.1` (no deployed target attached) |
| Tokens / digests | not provided (expected for public dry-run) |
| Mutations / SSE / operator | planned `true` |
| BYOK provider | `anthropic` (planned validation route only) |

Full generated plan (ephemeral local path when operators re-run):
`.open-cowork-test/launch-readiness/private-beta-launch-readiness-plan.md`

---

## 2. Evidence register (public status + gaps with owners)

Status vocabulary:

- **public-ready** — contract/tests/validators green in this monorepo
- **pending-private-evidence** — blocking for hosted private-beta `go`
- **Owner** — interim public ownership (fill private roster offline)

| Evidence item | Public status | Owner (interim) | Linear | Gap / next action |
| --- | --- | --- | --- | --- |
| Public package + validators | **public-ready** | Product ops | JOE-922 | Keep validators green on PR |
| `deployedLoadTest` | pending-private-evidence | Product ops | JOE-958 | Strict load against production-like env with tokens + digests |
| `deployedSoakTest` | pending-private-evidence | Product ops | JOE-958 | Soak ≥ profile soakDuration (4h private-beta) |
| `postgresBackupRestore` | pending-private-evidence | Platform | JOE-960 | Live non-prod restore per `backup-restore.md` |
| `objectStoreArtifactRoundTrip` | pending-private-evidence | Platform | JOE-960 | With restore drill |
| `byokRedactionNoPlaintext` | **public-ready (unit/integration)** / pending-private-evidence (deployed) | Worker/BYOK | JOE-961 | Live provider validation on target; unit coverage already green |
| `supportIncidentOwnershipEscalation` | **public-ready (roles named)** / pending-private-evidence (signed roster) | Support primary | JOE-968 | Private roster + on-call channel offline |
| `deployedDesktopWebGatewayContinuation` | pending-private-evidence | Cloud + Desktop + Gateway | JOE-971 | Deployed continuation smoke on target |
| `workerFailover` / `schedulerReplicaFailover` | pending-private-evidence | Platform | JOE-971 | Failover drill on target |
| `gatewayDeliveryReplayDeadLetter` | pending-private-evidence | Gateway | JOE-971 | Replay/DLQ drill on target |
| `quotaRateLimitBehavior` / `billingEntitlementGating` | pending-private-evidence | SaaS ops | JOE-971 | Deployed entitlement probes |
| `secretAdapterResolution` | pending-private-evidence | Platform | JOE-971 | KMS/secret adapter on target |
| `costSloNotes` | pending-private-evidence | Product ops | JOE-971 | Cost/SLO sheet (private) |
| `releaseRollback` | pending-private-evidence | Release owner | JOE-971 | Rollback rehearsal (private) |

**No secrets, customer names, live URLs, or prices are stored in this package.**

---

## 3. Child issue close-out notes

### JOE-958 — Load/soak

**Done in-repo:** private-beta profile targets present; plan harness green; explicit gap for live strict load/soak with owner Product ops.

**Blocked for hosted go:** `pnpm deploy:load:strict` + `pnpm deploy:soak:strict` with:

```bash
export OPEN_COWORK_LOAD_PROFILE=private-beta
export OPEN_COWORK_LOAD_CLOUD_URL=...
export OPEN_COWORK_LOAD_GATEWAY_URL=...
export OPEN_COWORK_LOAD_CLOUD_TOKEN=...
export OPEN_COWORK_LOAD_GATEWAY_ADMIN_TOKEN=...
export OPEN_COWORK_LOAD_BYOK_PROVIDER=anthropic
export OPEN_COWORK_LOAD_INCLUDE_MUTATIONS=true
export OPEN_COWORK_LOAD_INCLUDE_SSE=true
export OPEN_COWORK_LOAD_OPERATOR_CHECKS=true
export OPEN_COWORK_LOAD_STRICT=true
export OPEN_COWORK_EVIDENCE_COMMIT_SHA="$(git rev-parse HEAD)"
export OPEN_COWORK_EVIDENCE_CLOUD_IMAGE_DIGEST=sha256:...
export OPEN_COWORK_EVIDENCE_GATEWAY_IMAGE_DIGEST=sha256:...
```

Attach JSON/MD reports to private ops only; copy redacted summaries + checksums into private `launch-evidence-record`.

### JOE-960 — Restore drill

**Done in-repo:** restore drill contract revalidated via `pnpm ops:validate`; report template current (`docs/runbooks/restore-drill-report.md`); baseline remains dry-run, not live customer restore.

**Gap:** environment-specific drill on non-production restore target (owner: Platform). High-severity open restore findings block managed production launch.

### JOE-961 — BYOK validation

**Done in-repo:** public tests cover encryption, metadata-only readback, validation audit redaction, runtime injection without process-env plaintext (`tests/byok-secret-store.test.ts`, cloud runtime adapter tests, private-beta package contract).

**Gap:** one production-like provider validation end-to-end on target env (owner: Worker/BYOK). Record provider id + status only — never plaintext keys.

### JOE-968 — Support ownership

**Done in-repo:** named interim public ownership and escalation roles in `docs/runbooks/private-beta-support.md` (this package date). Private phone tree / chat channel remain offline-only.

| Role | Interim public assignee | Escalation |
| --- | --- | --- |
| Support primary | Joseph Broadhead | Linear project `open-cowork` / team Joe |
| Support secondary | TBD (private roster) | Same |
| Cloud auth owner | Cloud surface owner (interim: Joseph Broadhead) | Sev1 ≤ 30m |
| Worker/BYOK owner | Worker surface owner (interim: Joseph Broadhead) | Sev1 ≤ 30m |
| Gateway owner | Gateway surface owner (interim: Joseph Broadhead) | Sev1 ≤ 30m |
| Platform (Postgres/object-store/KMS) | Platform owner (interim: Joseph Broadhead) | Sev1 ≤ 30m |
| Release / go-no-go owner | Joseph Broadhead | Milestone Post-#958 |

### JOE-971 — Go/no-go

**Decision (public):** **`no-go`** for managed hosted private-beta product claims.
**Decision (public package):** **ready for operators to run private evidence campaign** against a target env using templates in `deploy/private-beta/`.
**Accepted public tier:** `local-self-host-beta` only.

Linked artifacts:

- This package
- `deploy/private-beta/private-beta-go-no-go.public.md`
- `docs/runbooks/launch-readiness.md`
- `docs/runbooks/launch-readiness-report.md`
- `deploy/load/launch-evidence-matrix.json`

---

## 4. Cost / SLO notes (placeholder — private fill)

| Item | Public target (from profile) | Private actual |
| --- | --- | --- |
| Postgres RPO | ≤ 15 min | `{private}` |
| Object store RPO | ≤ 15 min | `{private}` |
| Target RTO | ≤ 60 min | `{private}` |
| Sev1 response | ≤ 30 min | `{private}` |
| Monthly infra cost band | n/a in public repo | `{private}` |

---

## 5. Promotion checklist (when private evidence lands)

1. Fill private `launch-evidence-record` from template; all blocking items `pass`.
2. `pnpm deploy:launch:evidence:validate -- --manifest <private-record> --require-private-pass`
3. `pnpm deploy:promotion:validate -- --tier private-hosted-beta --manifest <private-record>`
4. Update `private-beta-go-no-go.public.md` decision only after sign-off from release, support, and security/redaction reviewers.
5. Do **not** expand `acceptedPublicTier` in the matrix without a deliberate product decision.

---

## 6. Explicit non-claims

- Not claiming multi-AZ HA (blocked on HA epic JOE-931 residual).
- Not claiming public-beta, GA, or enterprise-scale.
- Not claiming managed private-beta is production-ready from public templates alone.
- OSS/local self-host beta evaluation remains the only accepted public product claim.
