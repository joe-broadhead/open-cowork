# Cloud-server extraction — working plan

Goal: lift `apps/desktop/src/main/cloud/**` out of the desktop app into its own
workspace package (`packages/cloud-server`). A package **cannot** import from
`apps/desktop/src/main/**`, so every module the cloud code reaches outside
`main/cloud/` must first be resolved: moved to `@open-cowork/shared` (genuinely
shared + decoupled), moved *into* `main/cloud/` (cloud-only), or deleted (a
re-export shim). The final `main/cloud → packages/cloud-server` move is a single
step once the boundary is empty; until then each pre-move lands as its own green,
releasable commit.

The original audit finding (cloud graph silently value-imports Electron via a
hardcoded shim list) is **already test-enforced** by
`tests/cloud-server-electron-boundary.test.ts` (guard b). This extraction is
guard (a) — the structural follow-through.

## Boundary map (modules in `main/` proper that `main/cloud/**` imports)

Counts = number of cloud files importing the module.

| # | module | cloud imports | classification | action |
|---|--------|--------------|----------------|--------|
| 1 | `config-types.ts` | — | SHARED-PURE | ✅ **DONE** → `@open-cowork/shared` (commit 7cf8162c) |
| 2 | ~~`workflow/workflow-schedule.ts`~~ | 0 | **FALSE POSITIVE** — no cloud file imports it (the analyzer mis-counted the string `workflow-scheduled`) | none |
| 3 | `log-sanitizer.ts` | 2 | SHARED-PURE (zero deps) | ✅ **DONE** → `@open-cowork/shared` (process.env read via `globalThis` to stay node-types-free) |
| 4 | `normalizer-utils.ts` | (via below) | SHARED-PURE (zero deps) | → `@open-cowork/shared` |
| 5 | `runtime-event-normalizers.ts` | 1 | SHARED-PURE (only normalizer-utils) | → `@open-cowork/shared` |
| 6 | `opencode-adapter.ts` | 2 | SHARED-PURE (SDK *types* + shared types + normalizer-utils) | → `@open-cowork/shared` (needs `@opencode-ai/sdk` as shared type dep) |
| 7 | `knowledge/knowledge-store-contract.ts` | 4 | SHARED-PURE (type-only shared) | ✅ **DONE** → `@open-cowork/shared` |
| 8 | `knowledge/knowledge-input.ts` | 2 | SHARED-PURE (type-only shared) | ✅ **DONE** → `@open-cowork/shared` |
| 9 | `knowledge/knowledge-store.ts` | 1 | NODE-PURE (sqlite, no electron) — desktop SQLite store | extract shared constants/helpers → shared; store stays desktop |
| 10 | `knowledge/postgres-knowledge-store.ts` | 1 | CLOUD-ONLY (Postgres store) | move *into* `main/cloud/` |
| 11 | `runtime-environment.ts` | 1 | NODE-PURE-ish (path + runtime constants/types) | → shared (with runtime siblings) |
| 12 | `runtime-managed-server-core.ts` | 1 | NODE-PURE-ish (SDK + crypto + protocol/output siblings) | → shared (runtime cluster) |
| 13 | `runtime-node-managed-server.ts` | 1 | NODE-PURE (forks child opencode server) | → shared (runtime cluster) |
| 14 | `runtime-config-builder.ts` | 1 | DESKTOP-COUPLED (config-loader, settings, logger, agent-config) | decouple |
| 15 | `capability-catalog.ts` | 1 | DESKTOP-COUPLED (config-loader, settings, effective-skills) | decouple |
| 16 | `workflow/workflow-webhook-server.ts` | 9 | DESKTOP-COUPLED (logger) | follows logger decoupling |
| 17 | `logger.ts` | 2 | DESKTOP-COUPLED (config-loader → app data dir) | decouple from config-loader |
| 18 | `coordination/coordination-service.ts` | 1 | DESKTOP-COUPLED (electron BrowserWindow type; renderer events) | decouple |
| (—) | `launchpad/launchpad-service.ts` | 1 | DESKTOP-COUPLED (artifact-index, coordination) | follows coordination |
| (—) | `@open-cowork/cloud-client` | 1 | already a package | no action |

(`logger` couples the cloud to desktop via `config-loader`'s app-data-dir; the
cloud only "works" today because `build-cloud`'s Electron shim + config-loader
fallbacks paper over it. Real decoupling = a config-loader CORE in shared that is
Electron-free, OR the cloud server gets its own log destination.)

## Sequenced increments (each its own green commit + push)

1. ✅ config-types → shared.
2. ~~workflow-schedule~~ — dropped (false positive; not a cloud dep).
3. ✅ log-sanitizer → shared.
4. ✅ knowledge interfaces (contract + input) → shared.
5. pure normalizers (normalizer-utils + runtime-event-normalizers [+ opencode-adapter]) → shared. ← **next**
6. knowledge constants → shared; postgres-knowledge-store → cloud.
7. runtime cluster (environment + managed-server-core + node-managed-server + siblings) → shared.
8. **Decoupling tier** (the hard part): config-loader core → shared (Electron-free), then logger → shared, then workflow-webhook-server, runtime-config-builder, capability-catalog, coordination + launchpad.
9. Final: `main/cloud/**` → `packages/cloud-server/src/**` + package.json/tsconfig/exports + Docker packaging + build-cloud + update the ~2-3 non-cloud importers.

Gate every step: main/renderer/website tsc 0, node suite 0-fail, website 101/101,
renderer 475/475, lint clean. Commit + push each green step.
