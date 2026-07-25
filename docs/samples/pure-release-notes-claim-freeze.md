---
title: Pure release notes / marketing claim freeze sample
description: Allowed vs forbidden release-note language aligned with the product purity register (JOE-1090).
---

# Pure release notes / marketing claim freeze sample (JOE-1090)

- **Linear:** [JOE-1090](https://linear.app/joe-broadhead/issue/JOE-1090)
- **Source of truth:** [Product purity register](../product-purity-register.md)
- **Claim levels:** [Release checklist](../release-checklist.md)
- **Enterprise gate:** [Enterprise readiness matrix](../enterprise-readiness-matrix.md)

Use this sample as a **freeze template** before publishing GitHub Release notes,
blog posts, or partner one-pagers. Prefer under-claiming. Fail closed on any
row still `partial` / `deferred` / `blocked` in the enterprise matrix.

## Claim level for this sample

| Field | Value |
| --- | --- |
| Recommended public level | `local-self-host-beta` |
| Hosted language | Private design-partner beta only (if applicable); **not** public GA |
| Enterprise language | **Do not** say enterprise-ready |

---

## Sample release notes (allowed)

```markdown
## Open Cowork — Desktop Local workbench (self-host beta)

Open Cowork Desktop is a private **local** OpenCode workbench:

- **Home → Chat → Team | Tools & Skills | Playbooks | Projects** as the hero path
- Your provider keys stay on your machine for Local workspaces
- Progressive Studio surfaces (Knowledge, Approvals, Channels, Artifacts, Voice)
  stay **off by default** until you enable them

### Cloud (self-host / private hosted beta)

When you connect a **Cloud** workspace to a control plane you operate (or a
private BYOK design-partner environment):

- Desktop Cloud and Cloud Web can continue the **same Cloud sessions**
- Channel Gateway provides headless access to **Cloud** sessions (Tier-1 adapters)
- Local Desktop threads remain local unless you take an explicit cloud-safe action

### Gateways (named distinctly)

- **Channel Gateway** — channel adapters into Cloud sessions
- **Standalone Gateway appliance** — private appliance with its own OpenCode +
  Postgres; Desktop can register connection/health today
- **Durable Gateway (`cowork-gateway`)** — optional local-operator / claim-gated
  installable (not multi-tenant production GA)

### Knowledge vs Wiki

- **Knowledge** is the in-app Studio surface (spaces/pages/proposals)
- **Wiki (`cowork-wiki`)** is an optional git-backed sibling product — not the
  default Desktop Knowledge store

### Private realtime voice (opt-in)

- Available on **Desktop Local** when `features.voice` is enabled
- On-device STT (Aurum) + OS TTS; push-to-talk / conversation modes
- Not available as Cloud Web microphone capture
```

---

## Forbidden claims (must not appear)

Copy-paste blockers — reject the draft if any appear without linked evidence:

| Forbidden phrase / implication | Why |
| --- | --- |
| “Enterprise-ready” / “enterprise GA” | Required matrix rows still partial (JOE-1068 / JOE-1093) |
| Unqualified “the gateway” | Must name Channel / Standalone / durable Gateway |
| “Standalone workspace ready for chat” / “full Gateway Studio” | Session/list/prompt API deferred (R-1042 / JOE-1091) |
| “Pairing = full remote Studio” | Connector-only / preview until ops complete |
| “Knowledge = Wiki” / “OpenWiki” as in-app Knowledge | Separate products |
| “Always allow” as working policy | Control removed / not shipped as policy |
| Settings “Coming soon” faux toggles (voice replies, daily digest) | Removed for purity |
| “Private voice ships fully offline in every package” | Requires Aurum CLI + model weights present |
| Cloud Web mic / always-on listen without consent | Forbidden by register |
| Mobile / Microsoft Teams as shipping products | Names reserved only |
| Durable Gateway multi-tenant production GA | Blocked / local-operator claims only |
| Hosted multi-tenant Wiki GA | Optional installable only |

---

## OSS self-host vs private hosted beta (must distinguish)

| Audience | Allowed | Not allowed |
| --- | --- | --- |
| OSS / self-host | Local Desktop beta; self-host Cloud BYOK docs; bring your own keys | Implicit managed multi-tenant SaaS |
| Private hosted beta | Design-partner BYOK; ops evidence private | “Public hosted GA” without public-beta claim level evidence |
| Enterprise buyers | Per-row status from enterprise matrix only | Blanket enterprise-ready |

---

## Freeze checklist (release actor)

- [ ] Draft uses a claim level ≤ evidence in [release-checklist.md](../release-checklist.md)
- [ ] Grep draft against **Forbidden claims** table above
- [ ] Cross-check [product-purity-register.md](../product-purity-register.md) public claim matrix
- [ ] Enterprise wording matches [enterprise-readiness-matrix.md](../enterprise-readiness-matrix.md) (`proven` only with evidence)
- [ ] Voice claims match [voice-private-dogfood.md](../runbooks/voice-private-dogfood.md) claim freeze if voice mentioned
- [ ] No secrets, customer names, or private URLs in public notes

## Related

- [Product purity dogfood evidence (JOE-1092)](../runbooks/product-purity-dogfood-evidence-joe-1092.md)
- [Cloud sync residual (JOE-1094)](../runbooks/cloud-sync-dogfood-residual-joe-1094.md)
- [Standalone session API residual (JOE-1091)](../runbooks/standalone-session-api-residual-joe-1091.md)
