---
title: Product purity dogfood script
description: 30-minute Local Desktop hero-path validation for JOE-1029 / JOE-1079.
---

# Product purity dogfood script

**Linear:** JOE-1079
**Goal:** Prove the hero loop is pure and useful on Local Desktop.

## Preconditions

- Fresh or clean profile optional
- Provider key available (e.g. OpenRouter)
- Build from monorepo: `pnpm --filter @open-cowork/desktop dev` (or installed app)

## Script (~30 minutes)

1. **First run** — choose Local (advanced paths stay collapsed). Complete provider setup with **Test connection** / Save.
2. **Home** — composer-first; start a blank chat with a short prompt.
3. **Chat** — confirm stream, tool visibility, optional `@coworker` mention.
4. **Team** — open a coworker card; Start chat works. New coworker available on Local.
5. **Tools & Skills** — list tools/skills; no Relationships “coming soon” teaser.
6. **Playbooks** — empty state offers setup chat; create or open a playbook if available.
7. **Projects** — board (not history search); create project or open existing; open linked work when present.
8. **Approvals** — if a permission appears, Allow once / Deny work; **no Always allow** teaser on queue.
9. **Settings** — Notifications has no Coming soon voice/digest; models Save exercises credentials.
10. **Health Center** — opens from sidebar (not labeled Diagnostics); workspaces show honest status.
11. **Workspace switcher** — Standalone connect labeled health-only if tried.

## Capture

- Redacted notes: pass/fail per step
- Attach to JOE-1029 / JOE-1079 (no secrets, no API keys)
- File bugs for any P0 incomplete traps

## Cloud optional extension

Desktop Cloud + Cloud Web: same cloud thread continues; Cloud Web shows capability banner once; Team hire disabled on Cloud.

## Related

- [Product purity register](../product-purity-register.md)
- [Product purity checklist](../product-purity-checklist.md)
