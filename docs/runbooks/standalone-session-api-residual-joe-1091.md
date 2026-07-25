---
title: Standalone Desktop session API residual (JOE-1091)
description: Honest deferred residual for Desktop-safe Standalone session/projection API (R-1042).
---

# Standalone Desktop session API residual (JOE-1091)

**Linear:** [JOE-1091](https://linear.app/joe-broadhead/issue/JOE-1091) (parent [JOE-1089](https://linear.app/joe-broadhead/issue/JOE-1089); original [JOE-1042](https://linear.app/joe-broadhead/issue/JOE-1042))  
**ADR:** [standalone-desktop-session-api.md](../adr/standalone-desktop-session-api.md)  
**Residual:** **R-1042** (P1)  
**Date (UTC):** 2026-07-25

## Decision for this wave

**Full Desktop-safe Standalone Gateway session/list/create/prompt/abort + event
projection API is not implemented in JOE-1089 W5.** Implementing it is a
multi-surface stack (Gateway HTTP contract, Desktop adapter, support matrix
flip, redaction defaults, contract tests) beyond the honest residual outcome
accepted for this wave.

Shipped promise remains:

1. Desktop can register Standalone Gateway URL + token for **connection / health / doctor**.
2. Session list, prompt, artifacts, and full workspace chat against Standalone stay **`deferred`**.
3. UI and docs must not claim “Gateway workspace ready for chat.”

## Support matrix honesty (must stay true)

| API / capability | Status | Claim language |
| --- | --- | --- |
| Connection / health / support registration | **supported** (shipped) | “Register Standalone for health” |
| `sessions.list` / create / prompt / abort | **deferred** | Not marketed |
| Event projection to Desktop Studio | **deferred** | Not marketed |
| Path redaction defaults for remote | **required when API ships** | ADR requirement |

Automated honesty already covers:

- App does not call `session.list` when support entry is `deferred` (see `App.test.tsx`).
- Health Center copy notes connection-only until session APIs ship.
- Workspace switcher surfaces deferred reasons for list/create/prompt.

## Forbidden UI / marketing claims (fail closed)

- “Standalone full chat ready”
- “Gateway workspace ready” (unqualified)
- Flipping support matrix cells to `supported` without contract tests on the real path
- Presenting empty session lists as if the API succeeded when status is deferred

## Implementation checklist (future; outside this residual close)

When implementing (reopen or successor of JOE-1042 / JOE-1091):

1. Gateway token auth only (no public OpenCode port).
2. Session list / create / prompt / abort + event projection.
3. Redact local host paths by default.
4. Contract tests exercise the **real** Desktop → Standalone path (not mocks of the unit under test).
5. Flip matrix `deferred` → `supported` **only after** those tests pass.
6. Update ADR status, residual R-1042, enterprise matrix Standalone row, and claim freeze sample.

## Verdict for JOE-1091

| Outcome | Detail |
| --- | --- |
| API shipped? | **No** |
| Honesty preserved? | **Yes** — deferred + connection-only + R-1042 |
| Marketing allowed? | Connection/health only; no full chat claim |

## Related

- [Product purity residual risks](../product-purity-residual-risks.md)
- [Enterprise readiness matrix](../enterprise-readiness-matrix.md)
- [Pure release notes claim freeze](../samples/pure-release-notes-claim-freeze.md)
