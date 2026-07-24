---
title: Progressive disclosure
description: When secondary Studio features are default-off and which deploy profiles enable them.
---

# Progressive disclosure

Open Cowork keeps the default Desktop experience on the **hero workbench**:

**Home · Chat · Projects · Team · Playbooks · Tools & Skills · Settings**

Secondary Studio surfaces stay **hidden until explicitly enabled** so solo users
are not flooded with incomplete or ops-heavy pages.

## Feature flags

Configured under `features` in `open-cowork.config.json` (or overlays).

| Key | Default when omitted | Enable when |
| --- | --- | --- |
| `projects` | **on** | Always for thesis (set `false` only to hide) |
| `team` | **on** | Always for thesis |
| `playbooks` | **on** | Always for thesis |
| `tools` | **on** | Always for thesis |
| `knowledge` | **off** | Teams use propose/review knowledge spaces |
| `approvals` | **off** | Multi-thread operators need a cross-chat queue |
| `channels` | **off** | Cloud + Channel Gateway deployments |
| `artifacts` | **off** | Heavy cross-session deliverable browse |

Implementation: `DESKTOP_PRIMARY_FEATURE_KEYS` / `DESKTOP_SECONDARY_FEATURE_KEYS`
and `isDesktopFeatureEnabled` in `packages/shared/src/app-config.ts`.

## Deploy profiles (recommended)

| Profile | Enable secondaries | Notes |
| --- | --- | --- |
| Solo desktop | none | Public default |
| Team cloud | optional `approvals`, `artifacts` | After Always-allow / library readiness |
| Channel ops | `channels` (+ Cloud) | Requires Cloud Channel Gateway |
| Knowledge-heavy | `knowledge` | Not a substitute for Wiki product |

## Prerequisites before enabling

| Flag | Prerequisite |
| --- | --- |
| `channels` | Cloud workspace + Channel Gateway; empty local-only is confusing |
| `approvals` | Prefer Always-allow story complete for local; queue still useful for allow/deny/questions |
| `knowledge` | Users understand Knowledge ≠ Wiki |
| `artifacts` | Artifact index paths work for the authority in use |

Public `open-cowork.config.json` must **not** enable secondary keys by default
and must **not** auto-register Wiki or durable Gateway MCP entries.

## Related

- [Product purity register](product-purity-register.md)
- [Desktop app guide](desktop-app.md)
