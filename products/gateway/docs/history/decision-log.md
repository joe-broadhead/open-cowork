# Release Decision Log

OpenCode Gateway was built through a sequence of milestone tranches, each
closing with an explicit release decision. The full per-milestone evidence
documents lived in the repository until mid-2026; they were replaced by the
machine-checked claim registry (`src/claim-registry.ts`, surfaced by
`opencode-gateway release claims`) and this distilled log. The complete
originals remain available in Git history.

## Current decision

**Public local beta for one trusted local operator.** Broader claims stay
blocked until their evidence exists: release candidate remains blocked,
production remains blocked, hosted/team and SaaS and multi-tenant remain
blocked, universal-channel remains blocked, arbitrary scale remains blocked,
unattended operation remains blocked, managed support remains blocked, and
formal compliance remains blocked. The registry
enforces this wording in CI (`npm run release:check`).

## Milestone history (distilled)

| Tranche | Focus | Outcome |
| --- | --- | --- |
| M20–M26 | Private alpha: durable SQLite work state, scheduler, Telegram ingress, dashboard, backup/restore, audit retention | Private alpha accepted for the maintainer |
| M27–M29 | Local release-candidate machinery, redacted release review, codebase/runtime reliability | Public local beta opened; production/hosted claims blocked |
| M30–M32 | Fresh local evidence, Telegram delegated-work proof, release-operations certification, soak and channel-continuity proof | Continue beta; no claim expansion |
| M33–M34 | Work-store locality, Mission Control source-state truth, delegation receipts, daemon fencing, durable-state lifecycle audit | Control-plane hardening complete with bounded local evidence |
| M35 | Release-evidence closeout: Telegram/Web/TUI proof, WhatsApp waiver, service lifecycle smoke; seven-day elapsed soak deferred | Continue public local beta |
| M36–M37 | Deepen-and-simplify hardening; scale/trust: capability authorization matrix, capacity/backpressure, orchestration invariants | Continue beta; scale/trust hardening complete |
| M38 | Public-release architecture closure: operator journey map, stale-session recovery, permission-owner routing, channel truth, fleet lifecycle, support handoff — each certified supported-bounded | Architecture closure complete; claims unchanged |
| M39 | Release-candidate proof mapping; WhatsApp/Discord waiver renewal; local fleet scale/kill-switch proof | Claims unchanged |
| M40–M52 | Module boundary budget, domain ownership, durable-backend contracts, worker isolation contracts, deployment/ops proofs, extension-package trust, multi-operator authorization preview, compliance/audit support models | Foundations recorded as deterministic contracts; claims unchanged |
| M53–M55 | Codebase quality scope gates, typed contract hardening, Mission Control decomposition, product polish, security posture and capability policy | Maintainability work; claims unchanged |
| M56–M57 | Product-mode taxonomy, identity/RBAC capability model, quota/budget/emergency-stop guardrails, signed-provenance distribution trust, guarded remote-worker executor previews, self-hosted team pilot topology, beyond-local dogfood soak | Beyond-local foundations recorded; claims unchanged |
| M58–M59 | Evidence-sprawl inventory, validation gate selection, runtime kernel scope gate with ownership map | Set up the consolidation that produced this registry |

## What replaced the milestone machinery

- **Claim boundary**: `src/claim-registry.ts` — one table of allowed,
  blocked, and deferred claims with exact wording and safe next actions.
- **Release gate**: `scripts/check-release.mjs` — version alignment, claim
  registry invariants, an overclaim scan across public copy, and build
  artifact verification.
- **Safety gate**: `scripts/check-evidence-safety.mjs` — redaction and
  claim-safety scanning across all shipped documents.
- **Operator surface**: `opencode-gateway release claims` and the Mission
  Control "Release Claims" view.
