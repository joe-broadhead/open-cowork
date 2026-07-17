# CI test rebalance: product-critical vs architecture meta

**Issue:** JOE-895

## Inventory

| Bucket | Examples | Keep? | CI priority |
| --- | --- | --- | --- |
| Product-critical behavioral | workspace-node (gateway/MCP), MCP handler contracts, durable events, session engine, directory grants, cloud continuation | Yes | **High** — run early, block merges |
| Security trust boundary | MCP URL/stdio policy, pairing fencing, IPC security errors | Yes | **High** |
| Coverage ratchets | `scripts/coverage-summary.mjs` floors for Workspace Node / MCP / cloud-client | Yes | **High** after suites |
| Architecture meta | modularity/line budgets, design tokens, import cycles, source maps, i18n keys | Yes | **Medium** — keep gates, can parallelize |
| Docs/static | docs build, mermaid vendor check | Yes | **Medium** |

## Policy

1. Do **not** drop architecture guardrails — they prevent decay.
2. Prefer adding behavioral tests under JOE-874 / JOE-871 / JOE-867 over new
   meta-only assertions.
3. When CI time is tight, split jobs: `product-critical` first, `architecture-meta`
   in parallel — both required for green.
4. Flaky timing tests (JOE-882) must use event-driven waits; quarantine only
   with a tracking issue.

## Workspace Node / MCP floors

Raise floors only after real tests land. Track ratchets in
`scripts/coverage-summary.mjs` (`WORKSPACE_NODE_COVERAGE_INPUT`,
`MCP_HANDLER_COVERAGE_INPUT`, cloud-client function thresholds).
