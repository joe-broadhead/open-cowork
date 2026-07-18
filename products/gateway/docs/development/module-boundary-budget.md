# Module Boundary And Dependency Budget

Release-claim effect: **maintainability only; no release-claim expansion**.

## Purpose

The boundary budget turns the [Architecture Handoff Map](architecture-handoff-map.md) and the
[Codebase Boundaries](../concepts/codebase-boundaries.md) owner map into an executable import
budget. The budget is intentionally narrow: it guards owner boundaries that are already clear,
records known legacy cycles, and avoids broad rewrites under a quality label.

Earlier design documents that motivated individual rules live in Git history (see the
[Decision Log](../history/decision-log.md)). This page describes only what the current budget JSON
enforces.

Run:

```bash
npm run boundaries:check
```

The same check runs in the standard test suite through
`src/__tests__/module-boundaries.test.ts`, so `npm test` and `npm run verify` fail when a selected
boundary drifts.

## Budget Source

The canonical budget lives in [`module-boundary-budget.json`](module-boundary-budget.json).
It records:

- owner domains for scheduler/replay, work-store, channels, security policy, runtime isolation,
  evidence/redaction, Mission Control, CLI/daemon routes, release operations, and support operations;
- primary tests and edge adapters for each domain;
- source-only dependency thresholds;
- the four currently registered dependency cycle components;
- forbidden import rules for provider-neutral contracts, work-store ports, pure orchestration
  calculations, Mission Control view models, evidence/redaction helpers, release-ops tooling, and
  security policy.

## Owner And Growth Policy

Every owner domain in the budget JSON has a `category`, and every category is registered in
`growthPolicy.ownerCategories`. The checker reports `ownerSummary` and `growthPolicy` sections so a
reviewer can tell whether a budget change is runtime risk, evidence-only growth, documentation, or
validation infrastructure before accepting it.

Evidence-only growth is allowed only when the change has an owner category, a budget-increase entry,
a rationale, and a consolidation path:

- record the module or edge increase in `growthPolicy.budgetIncreases` with `previous`, `current`,
  `delta`, `ownerCategory`, `growthKind`, `rationale`, and `consolidationPath`;
- use `directionalImportPilots` to tie a forbidden-import rule to the owner category it protects;
- prefer a narrow redacted receipt or owner-approved helper before importing from runtime surfaces.

Acceptable boundary changes:

- a validation helper grows the graph after it adds focused selector coverage, a rationale, and a
  future consolidation path;
- a runtime module grows the graph only when its owning runtime issue needs executable behavior and
  records the increase as runtime risk rather than evidence-only churn.

Unacceptable boundary changes:

- increasing `maxModuleCount` or `maxEdgeCount` without a matching `growthPolicy.budgetIncreases`
  entry;
- adding a budget entry without a non-empty rationale or owner classification;
- importing from storage, scheduler, channel, daemon, dashboard, MCP, package execution, CI, or
  release-artifact side-effect surfaces from an evidence/release module without an owner-approved
  port or forbidden-import pilot.

## Current Dependency Budget

| Metric | Budget | Current check behavior |
| --- | --- | --- |
| Source module count | <= 228 | Fails if the source graph exceeds the budget without an intentional, rationale-backed `growthPolicy.budgetIncreases` entry. |
| Source edge count | <= 970 | Fails if relative source imports grow beyond the budget without a matching budget-increase entry. |
| Cycle components | <= 4 | Fails on any unregistered new cycle, even if total count stays under budget. |
| Max cycle size | <= 4 | Fails if a known or new cycle grows larger than the recorded ceiling. |
| Unresolved relative imports | 0 | Fails because unresolved imports hide real dependency shape. |

The v1.3.0 consolidation removed most of the older evidence-report modules, so the current graph sits
well under the module and edge ceilings; the ceilings remain as drift alarms rather than tight
budgets. The rationale prose that used to accompany each historical budget increase is preserved in
Git history with the deleted modules.

The four known cycle components (`security-policy`/`security`, `alpha-health`/`mission-data`,
`audit-ledger`/`work-store`, and `opencode-requests`/`operator-decisions`) remain tolerated only
because they already exist and have named follow-up owners. Do not use their registration as
permission to add new edges.

## Enforced Boundary Rules

These are the forbidden-import rules currently enforced by the budget JSON — one row per `id` in
`forbiddenImports`. If a rule is not in this table, it is not enforced.

| Rule | Protects | Safe next action |
| --- | --- | --- |
| `shared_channel_contracts_do_not_import_provider_adapters` | Provider-neutral command, capability, and rendering contracts. | Express provider behavior in shared capabilities/renderer first, then translate in the adapter. |
| `provider_adapters_do_not_import_runtime_edges` | Provider adapters as translation edges. | Route behavior through channel commands, channel sync, queue events, or a narrow port. |
| `work_store_ports_do_not_import_edges` | Durable-state ports and future backend portability. | Add a work-store operation or port method, then call it from the edge. |
| `orchestration_kernel_stays_io_free` | Pure retry/capacity timeline calculations. | Return an explicit plan from the kernel and execute side effects in scheduler. |
| `mission_view_model_stays_adapter_free` | Deterministic Mission Control source-state policy. | Feed typed input data into the view model rather than importing live adapters. |
| `channel_sessions_stay_storage_port_only` | Provider-neutral channel/session binding facade over the work-store bindings port. | Add a channel-session method or bindings-port operation first, then call it from command, dashboard, MCP, or provider edges. |
| `dashboard_reads_mission_control_not_mutable_owners` | Dashboard as a Mission Control/read-model renderer rather than a mutable runtime owner. | Add a typed Mission Control input or read-model field first, then render it in the dashboard. |
| `mcp_edges_use_daemon_and_view_models_not_mutable_owners` | MCP tools as authorized local edge surfaces over daemon endpoints and typed view models. | Expose behavior through a daemon route, security policy, or Mission Control view model before wiring a new MCP tool. |
| `evidence_redaction_stays_provider_free` | Stable evidence, incident, redaction, and review-gate contracts. | Record provider evidence through typed inputs and redact through shared helpers. |
| `validation_gate_selector_stays_release_ops_only` | The validation gate selector as deterministic release-operations guidance over repo-relative paths, focused commands, full-verify escalation, and warning-only budgets. | Route runtime/provider proof, live execution, mutable storage, scheduler, daemon, channel, dashboard, MCP, CI, or package behavior to the owning runtime surface before changing selector guidance. |
| `security_policy_stays_provider_free` | Reason-coded security and authorization decisions. | Add a policy input or capability boundary entry before provider-specific rendering. |

## Exception Policy

Exceptions are allowed only in `module-boundary-budget.json`, and each exception must name an
owner, reason, and review condition. Prefer adding a narrow owner module or port before adding an
exception. Remove exceptions when the owning follow-up issue closes.

## Agent Checklist

1. Read this page and the budget JSON before moving code across owner domains.
2. Use the owner domain table to decide where a behavior belongs.
3. Run `npm run boundaries:check` after changing imports.
4. Run focused tests for the touched owner and adapter.
5. Run `npm run verify` when shared source behavior changes.
6. Update the budget only with a clear reason, review condition, and no release-claim expansion.
