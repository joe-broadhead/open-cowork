# Codebase Boundaries

Gateway is intentionally local-first and OpenCode-native. The codebase should stay easy to reason about by keeping domain ownership narrow and pushing shared contracts into small modules.

## Boundary Map

| Area | Owns | Should not own |
| --- | --- | --- |
| `work-store.ts` and `storage.ts` | Durable state, backups, recovery drills, record-level mutation APIs. | UI formatting, channel copy, OpenCode session orchestration policy. |
| `scheduler.ts`, `workers.ts`, `capacity.ts` | Dispatch decisions, leases, backpressure, recovery, worker/environment lifecycle. | Channel rendering, dashboard HTML, public docs. |
| `channels/`, `channel-commands.ts`, `channel-sync.ts` | Provider adapters, trusted-channel commands, rendering capability fallbacks, inbound/outbound channel receipts. | Scheduler internals or direct storage mutation rules. |
| `mission-data.ts` and `dashboard.ts` | Mission Control data composition and rendering from prepared view models. | Direct mutation of durable work state or provider SDK calls. |
| `observability-contract.ts` and `observability-snapshot.ts` | Trace IDs, local SLO budgets, channel-failure classification, and one shared snapshot assembly path. | Route-specific formatting, incident markdown, evidence file writing. |
| `evidence-export.ts` and `incident-bundle.ts` | Redacted operator evidence and incident artifacts. | Alert evaluation rules, scheduler policy, or provider transport. |
| `operational-redaction.ts` | Shared text pattern boundaries for provider targets, session IDs, private transcript/prompt/message text, and phone-like targets. | Config-specific secret discovery or bundle-specific output labels. |
| `daemon-routes/` | HTTP route wiring, capability-gated request handling, audit events. | Reimplementing domain rules already owned by contracts/services. |
| `cli.ts` | Local operator command UX and command dispatch. | Durable state mutation logic beyond calling domain APIs. |

## Hardening Notes

The maintainability pass intentionally avoided a broad rewrite. It removed or isolated three high-risk coupling points:

- Observability snapshot assembly now goes through `buildObservabilitySnapshot()` instead of being reassembled independently in HTTP routes, Mission Control, and incident bundles.
- Channel delivery failure classification now goes through `countChannelFailureEvents()` / `isChannelFailureEvent()` in `observability-contract.ts`.
- Evidence and incident redaction pattern matching now goes through `operational-redaction.ts`, while each caller keeps control of its own output labels.

Static boundary tests in `src/__tests__/domain-boundaries.test.ts` protect these decisions. If a future feature genuinely needs to cross a boundary, add a small domain contract first and update this page with the reason.

Before starting broad refactors, use the [Architecture Handoff Map](../development/architecture-handoff-map.md) to find the owner module, action/calculation/data boundary, tests, and release-claim guardrails for common changes.

## Current Owner Map

The active owner map is the executable budget in
[`docs/development/module-boundary-budget.json`](../development/module-boundary-budget.json),
documented in [Module Boundary And Dependency Budget](../development/module-boundary-budget.md).
It records the scheduler/replay, work-store/durable-state, channels, Mission Control, security
policy, runtime isolation, evidence/redaction, CLI/daemon-route, release-operations, and
support-operations owner domains with source modules, edge adapters, primary tests, and forbidden
import rules. `npm run boundaries:check` fails when a guarded boundary drifts.

If a future feature needs to cross one of those boundaries, add a small owner module or typed input
contract first, then update the budget with a reviewed exception. Earlier owner-map documents that
preceded this budget were removed in the v1.3.0 consolidation and live in Git history; see the
[Decision Log](../history/decision-log.md).

## Agent Guidance

When adding a feature:

1. Put durable state reads/writes behind `work-store.ts` or a small domain service.
2. Keep route handlers thin: parse request, call a domain function, audit, return a response.
3. Keep Mission Control render code consuming prepared data; do not make it a second source of business rules.
4. Put shared classification, redaction, trace, and readiness rules in small contract modules with focused tests.
5. Prefer characterization tests before refactors, especially around scheduler, storage, channel, and evidence behavior.

The goal is not fewer files. The goal is fewer surprising dependencies.
