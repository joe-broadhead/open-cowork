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
| 4 | `normalizer-utils.ts` | (via below) | SHARED-PURE (zero deps) | ✅ **DONE** → `@open-cowork/shared` |
| 5 | `runtime-event-normalizers.ts` | 1 | SHARED-PURE (only normalizer-utils) | ✅ **DONE** → `@open-cowork/shared` |
| 6 | `opencode-adapter.ts` | 2 | SHARED-PURE (SDK *types* + shared types + normalizer-utils) | → `@open-cowork/shared` (needs `@opencode-ai/sdk` as shared type dep) — normalizer-utils dep now in shared |
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

## ⚠️ Discovered architectural constraint (2026-06-17) — the easy moves are done

The first four increments moved genuinely **browser-safe, SDK-free** modules into
`@open-cowork/shared`. The remaining boundary deps cannot follow them, for two hard reasons:

1. **`@opencode-ai/sdk` is restricted to "runtime authority" packages.**
   `tests/opencode-sdk-boundary.test.ts` enforces (via strict `deepEqual`) that **only**
   `apps/desktop` and `apps/standalone-gateway` may *declare* the opencode SDK, and keeps a
   per-file allowlist of SDK importers cross-checked against `docs/opencode-sdk-v2-boundary.md`.
   So `opencode-adapter`, `runtime-managed-server-core`, `runtime-node-managed-server`, and
   `runtime-config-builder` (all SDK importers) **cannot** move into `@open-cowork/shared` —
   that's a deliberate, test-enforced boundary, not an oversight.
2. **Node-only modules can't live in the browser-bundled shared barrel.**
   `knowledge-store.ts` (`node:sqlite`), the runtime managed-server cluster
   (`node:child_process`), and `workflow-webhook-server` (`node:http`) would break the
   website bundle if re-exported from `@open-cowork/shared`'s main entry.

## 🔭 True scope (2026-06-23) — the cloud transitively reaches the desktop core

A direct-import count understates the boundary. The **transitive value-closure** from
`main/cloud/**` reaches **128** `main/` modules — including `config-loader.ts` and
`settings.ts` (both value-import `electron`), `workspace-gateway.ts`, `session-engine.ts`,
and the whole runtime/config/session substrate. Verified shortest paths:
- `cloud/byok-runtime-config.ts` → `logger` → `config-loader` (electron+config core)
- `cloud/byok-runtime-config.ts` → `runtime-config-builder` → `settings` (electron); and
  → `runtime-mcp` → `knowledge-tool-bridge` → `workspace-gateway`
- `cloud/http-routes/launchpad.ts` → `launchpad-service` → `session-engine`

So the final `main/cloud → packages/cloud-server` lift is gated on decoupling the desktop
config/settings/runtime/session core from Electron — a large, behavior-sensitive sub-project,
not a few module moves. The cloud "works" today only because `build-cloud`'s Electron shim
binds those electron exports to `undefined` at runtime.

**Decision (user, 2026-06-23): full extraction, accepting the costs** — new Docker-shipped
packages the local gate can't fully verify, and extending the SDK-boundary test allowlist.
Executed **risk-sequenced**: fully-verifiable shared moves first, Docker-shipped packages last.

## Two homes for the extracted substrate

- **`@open-cowork/shared/node`** (NO Docker change — ships inside the already-shipped shared
  package): node-only, **non-SDK** modules. Built via a single `tsc` with `"types": []` in
  `packages/shared/tsconfig.json` (browser-safety preserved) + a per-file
  `/// <reference types="node" />` opt-in. Export `"./node"` → `dist/node/index.js`. Fully
  locally verifiable (tsc + node suite + `pnpm cloud:build`).
- **`@open-cowork/runtime-host`** (NEW Docker-shipped package): node + **SDK** runtime substrate
  (declares `@opencode-ai/sdk` + `@types/node`). Needs the Dockerfile build step + lockfile +
  the SDK-boundary test allowlist + boundary doc. Docker image itself not locally verifiable.

## Sequenced increments (each its own green commit + push)

1. ✅ config-types → shared.
2. ~~workflow-schedule~~ — dropped (false positive; not a cloud dep).
3. ✅ log-sanitizer → shared.
4. ✅ knowledge interfaces (contract + input) → shared.
5. ✅ pure normalizers (normalizer-utils + runtime-event-normalizers) → shared.
6. ✅ **`@open-cowork/shared/node` subpath infra** + first residents `fs-atomic` + `fs-read`
   (pure `node:fs` utils, in the cloud's broader closure). Proves the node lane end-to-end:
   tsc 0, node 2,099/0, website 101/101, renderer 475/475, lint 1,684, `pnpm cloud:build` green;
   the shared export-surface boundary test now documents `./node`.
7. **Knowledge helpers → shared/node:** extract the storage-agnostic helpers (incl.
   `knowledgeRevisionFor`'s `createHash`) from `knowledge-store.ts`; both stores consume them
   from `@open-cowork/shared/node`. Cuts the `postgres-store → knowledge-store` edge.
   (Safety net: the pglite contract test exercises both stores.)
8. **Decouple `logger` from `config-loader`** (inject log dir + file prefix; config-loader stays
   a desktop-side fallback) → move `logger` to shared/node → then `workflow-webhook-server`.
9. **`packages/runtime-host`** (Docker): opencode-adapter, runtime-managed-server cluster,
   runtime-environment, knowledge SQLite store. + SDK-boundary allowlist + boundary doc + Docker.
10. **Decouple the desktop config/runtime/session core from Electron** (config-loader/settings
    cores, runtime-config-builder, capability-catalog, coordination, launchpad). The long tail.
11. **`main/cloud/** → packages/cloud-server`** once the boundary is empty; wire package +
    Dockerfile + build-cloud. `postgres-knowledge-store` (cloud-only) lands here.

Gate every step: main/renderer/website tsc 0, node suite 0-fail, website 101/101,
renderer 475/475, lint clean, `pnpm cloud:build` green. Commit + push each green step.
