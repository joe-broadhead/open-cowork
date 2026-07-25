---
title: ADR — Standalone Gateway Desktop session API (deferred)
description: Product purity freeze — connection-only Desktop UX until a Desktop-safe session/projection API ships (JOE-1042).
---

# ADR: Standalone Gateway Desktop session API

| Field | Value |
| --- | --- |
| Status | **Accepted (deferred implementation)** |
| Date | 2026-07-24 |
| Linear | JOE-1042, JOE-1044, JOE-1091 |
| Post-purity residual | [standalone-session-api-residual-joe-1091.md](../runbooks/standalone-session-api-residual-joe-1091.md) (R-1042) |

## Context

Desktop can register a Standalone Gateway URL + token for health and support
verdicts. Session list, prompt, artifacts, and workflows remain **deferred** in
the workspace support matrix. Product purity forbids presenting a full
workspace when those APIs do not exist.

## Decision

1. **Shipped promise (now):** Standalone Gateway connection/health only.
2. **Not shipped:** Desktop chat against Standalone sessions.
3. **Future API (when implemented)** must:
   - Authenticate with Gateway token (no public OpenCode port)
   - Provide session list/create/prompt/abort + event projection
   - Redact local host paths by default
   - Flip support matrix from `deferred` → `supported` for session ops only after contract tests pass

## Implementation residual

Full API work is **out of purity epic scope** and remains deferred after
post-purity wave JOE-1091. Tracked residual **R-1042**.
Until implemented, UI must keep connection-only copy (JOE-1044) and must not
flip the support matrix to `supported` without contract tests on the real path.

## Consequences

- Operators can register Standalone for doctor/health.
- Users cannot be misled into “Gateway chat ready” without the API.
