---
title: Paired Desktop connector scope
description: Product decision — pairing remains connector-only until remote session ops ship end-to-end.
---

# Paired Desktop connector scope

**Decision (JOE-1083):** Paired Desktop is a **connector / preview**, not full
remote Studio, until session list/prompt/projection and approval policy for
remote use are complete.

## What ships now

- Settings → Outbound pairing (create, connect, disconnect, revoke, audit)
- Outbound broker credentials; Desktop-initiated connection only
- Redaction defaults for local paths, MCP details, artifact bodies

## What is deferred

- Remote browse of the full Desktop session list as a first-class workspace
- Remote prompt parity with local Chat
- Remote Always-allow / approval policy elevation without local confirmation

## UI rules

- Settings copy must say **preview** / connector
- Workspace switcher must not imply full chat when support matrix is deferred
- No marketing claim of “mobile gateway ready” without completing JOE-1083 full path

## Related

- [Desktop outbound pairing](desktop-outbound-pairing.md)
- [Product contract](product-contract.md)
- [Product purity register](product-purity-register.md)
