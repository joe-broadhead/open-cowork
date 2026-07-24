---
title: Enterprise readiness claim matrix
description: Feature claims vs evidence status for enterprise-ready marketing (JOE-1068).
---

# Enterprise readiness claim matrix

**Linear:** JOE-1068
**Rule:** Do not market `enterprise-ready` until every **required** row is
`proven` with linked evidence. Partial rows stay out of release notes.

| Claim | Surface | Required for enterprise-ready? | Status | Evidence / owner |
| --- | --- | --- | --- | --- |
| Local Desktop workbench | Desktop | yes (baseline) | proven | CI + Desktop release |
| Self-host Cloud BYOK | Cloud | yes | partial | self-host docs; private-beta ops evidence private |
| Cloud Web Studio sync | Cloud Web | yes | proven (code) | same control plane; dogfood runbook |
| Channel Gateway Tier-1 | Channel GW | optional | partial | readiness matrix; live smoke per env |
| Standalone Gateway appliance | Standalone | optional | partial | appliance docs; Desktop session API deferred |
| Desktop↔Standalone full chat | Desktop | no until API | deferred | JOE-1042 |
| Paired Desktop full remote Studio | Desktop | no until complete | deferred | connector-only (JOE-1083) |
| SSO / OIDC | Cloud auth | yes | partial | config supported; env-specific proof |
| Admin RBAC | Cloud Admin | yes | proven (code) | Admin surfaces + API authz |
| Audit log browse | Cloud Admin | yes | partial | list yes; cursor export deferred |
| Backup / restore RPO/RTO | Ops | yes | partial | runbooks; live drills private |
| Tenant isolation | Cloud | yes | partial | product contract; load evidence private |
| BYOK (no provider key resale) | Cloud | yes | proven (design) | BYOK APIs write-only keys |
| Durable Gateway multi-tenant GA | products/gateway | no | blocked | local-operator claims only (JOE-1072) |
| Wiki hosted multi-tenant GA | products/wiki | no | blocked | optional installable |
| Mobile client | — | no | absent | reserved name |

**Status values:** `proven` · `partial` · `deferred` · `blocked` · `absent`

Update this table when evidence lands. Link private evidence outside the public
repo without pasting secrets.

## Related

- [Product purity register](product-purity-register.md)
- [Release checklist](release-checklist.md)
- [Packaging and product modes](packaging-and-product-modes.md)
