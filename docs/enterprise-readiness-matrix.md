---
title: Enterprise readiness claim matrix
description: Feature claims vs evidence status for enterprise-ready marketing (JOE-1068 / JOE-1093).
---

# Enterprise readiness claim matrix

- **Linear:** JOE-1068, [JOE-1093](https://linear.app/joe-broadhead/issue/JOE-1093)
- **Rule:** Do not market `enterprise-ready` until every **required** row is
  `proven` with linked evidence. Partial rows stay out of release notes.
- **Fail-closed wording:** If status ≠ `proven`, public copy must not imply the
  claim. Prefer “self-host beta”, “private design-partner beta”, or omit.

| Claim | Surface | Required for enterprise-ready? | Status | Owner | Next evidence artifact | Fail-closed claim wording | Evidence / notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Local Desktop workbench | Desktop | yes (baseline) | proven | Desktop maintainers | Keep CI + Desktop release smoke green | Allowed: “Local OpenCode workbench (self-host beta)” | CI + Desktop release; [purity dogfood evidence](runbooks/product-purity-dogfood-evidence-joe-1092.md) |
| Self-host Cloud BYOK | Cloud | yes | partial | Cloud platform | Redacted private-beta ops pack (deploy smoke, BYOK key write-only proof) | Allowed: “Self-host Cloud BYOK”; **not** “managed enterprise Cloud GA” | Self-host docs; private-beta ops evidence private |
| Cloud Web Studio sync | Cloud Web | yes | partial | Cloud platform | Live Desktop↔Web marker run per [cloud-sync dogfood](runbooks/cloud-sync-dogfood.md); until then [R-1094 residual](runbooks/cloud-sync-dogfood-residual-joe-1094.md) | Allowed: “Cloud Web continues Cloud sessions (code path)”; **not** “sync proven in production” without live notes | Code-proven control plane; live env residual R-1094 |
| Channel Gateway Tier-1 | Channel GW | optional | partial | Gateway / channels | Per-env Tier-1 live smoke (Telegram/Slack/email lab) | Allowed: “Tier-1 adapters”; **not** “all channels production-ready” | Readiness matrix; live smoke per env |
| Standalone Gateway appliance | Standalone | optional | partial | Gateway appliance | Appliance pack smoke + doctor; session chat stays deferred | Allowed: “Private appliance + Desktop health registration”; **not** “Desktop full chat” | Appliance docs; Desktop session API deferred (R-1042) |
| Desktop↔Standalone full chat | Desktop | no until API | deferred | Desktop + Gateway | Contract tests on real session/projection path; then matrix flip | **Forbidden** until supported: “Standalone chat ready” | [JOE-1091 residual](runbooks/standalone-session-api-residual-joe-1091.md); ADR |
| Paired Desktop full remote Studio | Desktop | no until complete | deferred | Desktop pairing | Complete remote ops + support matrix | **Forbidden**: “full remote Studio” — say “connector / remote access preview” | Connector-only (JOE-1083) |
| SSO / OIDC | Cloud auth | yes | partial | Cloud auth | Env-specific IdP login proof (redacted) | Allowed: “OIDC config supported”; **not** “SSO proven for all customers” | Config supported; env-specific proof |
| Admin RBAC | Cloud Admin | yes | proven (code) | Cloud Admin | Keep Admin API authz tests green; optional live RBAC script | Allowed: “Admin RBAC in Cloud Admin” with code evidence caveat for GA | Admin surfaces + API authz |
| Audit log browse | Cloud Admin | yes | partial | Cloud Admin | Cursor export + retention evidence | Allowed: “Audit list”; **not** “full audit export GA” | List yes; cursor export deferred |
| Backup / restore RPO/RTO | Ops | yes | partial | Cloud ops | Dated restore drill report with RPO/RTO numbers (may stay private) | Allowed: “Backup runbooks”; **not** “enterprise RPO/RTO met” without drill | Runbooks; live drills private |
| Tenant isolation | Cloud | yes | partial | Cloud platform | Load/isolation evidence pack (private OK) | Allowed: “Tenant isolation by design”; **not** “isolation proven at enterprise load” | Product contract; load evidence private |
| BYOK (no provider key resale) | Cloud | yes | proven (design) | Cloud platform | Keep write-only key APIs + redaction tests green | Allowed: “BYOK — keys not resold”; design-level until private-beta pack | BYOK APIs write-only keys |
| Durable Gateway multi-tenant GA | products/gateway | no | blocked | Gateway product | Unpark production multi-tenant track only with explicit program | **Forbidden**: multi-tenant GA — local-operator / claim-gated only | Local-operator claims only (JOE-1072) |
| Wiki hosted multi-tenant GA | products/wiki | no | blocked | Wiki product | N/A for enterprise-ready gate | **Forbidden**: hosted Wiki multi-tenant GA | Optional installable |
| Mobile client | — | no | absent | — | N/A | **Forbidden**: shipping mobile product | Reserved name |

**Status values:** `proven` · `proven (code)` · `proven (design)` · `partial` · `deferred` · `blocked` · `absent`

### Promote rules

1. A required row may move to `proven` only with a **linked** evidence artifact
   (public path or private ticket id — never paste secrets).
2. `proven (code)` / `proven (design)` is **not** sufficient alone for the
   umbrella `enterprise-ready` claim level in [release-checklist.md](release-checklist.md).
3. Optional rows never unblock enterprise-ready by themselves.
4. Update this table when evidence lands; keep [claim freeze sample](samples/pure-release-notes-claim-freeze.md) aligned.

## Related

- [Product purity register](product-purity-register.md)
- [Release checklist](release-checklist.md)
- [Packaging and product modes](packaging-and-product-modes.md)
- [Cloud sync residual JOE-1094](runbooks/cloud-sync-dogfood-residual-joe-1094.md)
- [Standalone session residual JOE-1091](runbooks/standalone-session-api-residual-joe-1091.md)
