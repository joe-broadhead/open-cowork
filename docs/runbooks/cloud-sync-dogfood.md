---
title: Cloud continuity smoke (Desktop ↔ Web ↔ Channel)
description: Release validation for the cross-surface Cloud continuity promise.
---

# Cloud continuity smoke

**Promise:** Cloud workspaces sync across Desktop Cloud, Cloud Web, and Channel Gateway.

## Preconditions

- Self-host or lab Cloud stack with Postgres + workers + object store
- Channel Gateway (or fake provider in lab) wired to the same tenant
- Desktop signed into the Cloud workspace

## Script

1. **Desktop Cloud** — create a chat, send a unique marker prompt, note session id.
2. **Cloud Web** — open same org; continue the same session; confirm transcript continuity.
3. **Capability banner** — Cloud Web shows Cloud workspace limits once (dismissible).
4. **Channel** — send the marker via Tier-1 or lab fake provider; confirm delivery/session binding.
5. **Approvals** — if a permission fires, resolve from Web or Desktop; both clear.
6. **Local stays local** — confirm Desktop Local thread is not in Cloud session list.

## Capture

- Store redacted evidence in the release ticket or private operations system
- Gaps → severity + owner (no secrets)

## Related

- [Product contract](../product-contract.md)
- [Release checklist](../release-checklist.md)
