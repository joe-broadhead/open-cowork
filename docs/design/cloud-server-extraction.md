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
7. ✅ **Knowledge helpers → shared/node.** Extracted the storage-agnostic core (~28 pure
   functions incl. `knowledgeRevisionFor`'s `createHash`, validation, row→domain mappers, the
   deterministic seed, diff/graph derivation) from `knowledge-store.ts` (914→594 lines) into
   `shared/src/node/knowledge-store-helpers.ts`. Confirmed a clean split — every private helper
   (`parseJson`/`byteLength`/`stringValue`/…) is used only by moved functions. Both stores now
   consume them from `@open-cowork/shared/node`; the `postgres-store → knowledge-store` edge is
   cut. Safety net: the pglite contract test (both stores, same contract) stayed green.
8. ✅ **Logger core → shared/node (destination injected).** Moved the dual-channel
   rotating-file logger into `shared/src/node/logger.ts`; the log destination (data dir +
   brand prefix) is now **injected** via `setLogStorage` instead of imported, so the core
   carries no config-loader/Electron dependency. `apps/desktop/src/main/logger.ts` is a thin
   shim that wires the resolver from config-loader at module load (before any `log()` call —
   zero behavior change, the resolver fires lazily on first write). All 30 importers unchanged;
   `logger.test.ts` green through the shim. **Caveat (honest):** because the cloud reaches the
   same shim via `../logger`, the cloud → config-loader edge **persists** — it can't be cut
   until the config core is Electron-decoupled (the file prefix needs `getDataDirName()` from
   branding config). So this is infra-positioning, not a closure reduction yet.
9. ✅ **`workflow-webhook-server` → shared/node.** The HMAC-authenticated workflow webhook
   HTTP server (the cloud's **highest** direct edge — 9 cloud importers) had only one non-builtin
   dependency: the logger. With the logger core now in shared/node, moved the webhook server
   verbatim (`node:http` + `node:crypto` + the config-free `./logger.js` core), repointing all
   13 importers to `@open-cowork/shared/node`. This **cuts** the `cloud → webhook-server →
   logger → config-loader` path (the server now reaches only the config-free logger core);
   config-loader stays in the closure via other chains, but one more path to it is gone and the
   webhook server is fully shared. No signature-auth / replay-window logic changed.
10. 🟡 **`packages/runtime-host`** (Docker-shipped node + SDK substrate) — **created**, first
    resident landed. The package declares `@opencode-ai/sdk` + `@types/node`, is wired into
    `tsconfig.base` paths + the Dockerfile build + the `apps/desktop`/root devDeps + knip, and is
    added to **both** SDK-boundary test assertions (the per-file allowlist and the
    declaring-manifest `deepEqual`) + the boundary doc. First resident: **`opencode-adapter`**
    (SDK-type-only event/session normalizer; built dist has **zero** runtime SDK refs — types
    erased — so it needs no runtime `@opencode-ai/sdk`), 18 importers repointed to
    `@open-cowork/runtime-host`. In the cloud bundle it inlines like `shared/node` (no runtime
    resolution gap); the Docker build line is belt-and-suspenders for future externalized
    residents. **Second resident batch ✅:** `runtime-managed-server-protocol` + `-output` (pure
    support modules) + `runtime-managed-server-core` (the SDK-value managed-server lifecycle) moved
    in, exercising the runtime SDK-value path. `core`'s allowlist+doc entries repointed to
    `packages/runtime-host/`. **`runtime-node-managed-server` deliberately stayed in desktop:** it
    resolves the forked **supervisor** file path relative to its own module dir, and the supervisor
    is build-wired in three places (`vite.config.ts` desktop entry, `build-cloud` entry, two
    `resolveSupervisorPath` fns) — keeping node-managed-server co-located with the supervisor in
    `dist/main` (desktop) / `dist/cloud` (cloud) preserves that resolution. Both bundles inline
    protocol/output (self-contained, verified by `pnpm cloud:build` **and** the full desktop
    `vite build`). Remaining: `runtime-node-managed-server` + the supervisor (move together, later),
    `runtime-environment` (config-coupled via `runtime-paths`), the knowledge SQLite store (config).
11. 🟡 **Decouple the desktop config/runtime/session core from Electron** (the long tail; the real
    gate on the final lift). **First increment ✅ — `config-loader` Electron-decoupled via core+shim**
    (the logger pattern): `config-loader.ts` → `config-loader-core.ts` which no longer imports
    `electron`; its only Electron use was the `app` object for path resolution
    (`isPackaged`/`getAppPath`/`getPath`), now an **injected** `ConfigAppPathHost`
    (`setConfigAppPathHost`). The new tiny `config-loader.ts` shim imports `electron` and wires the
    host at module load (before any of the 109 importers call a config fn — no bootstrap risk, host
    read lazily), so desktop behavior is byte-identical and the cloud (Electron shimmed → host null)
    falls back exactly as before. Preparatory like the logger move: the cloud still reaches the shim,
    so the edge isn't cut until the cloud imports the core + injects its own host and the core moves
    to a package. **Remaining:** `settings` (harder — `safeStorage` **credential encryption**, deferred
    as security-critical), `runtime-config-builder`, `capability-catalog`, `coordination` (electron
    BrowserWindow), `launchpad`, `runtime-paths`, the knowledge SQLite store.
12. **`main/cloud/** → packages/cloud-server`** once the boundary is empty; wire package +
    Dockerfile + build-cloud. `postgres-knowledge-store` (cloud-only) lands here.

Gate every step: main/renderer/website tsc 0, node suite 0-fail, website 101/101,
renderer 475/475, lint clean, `pnpm cloud:build` green. Commit + push each green step.

---

## Remaining-work milestone plan (measured 2026-06-24)

**Current state (measured, not estimated):**
- Cloud→`main/` **value-closure: 126 modules** (was 128 — the 12 leaf-extraction commits cut the
  *easy* edges; the closure barely shrank because the config/runtime core is the bulk).
- **Direct frontier: 10 modules** the cloud imports first-hop: `logger`(shim), `runtime-config-builder`,
  `capability-catalog`, `launchpad-service`, `coordination-service`, `knowledge-store`(SQLite),
  `runtime-environment`, `runtime-node-managed-server`(deferred), `postgres-knowledge-store`(cloud-only),
  `workflow-schedule`(trivial shared re-export).
- The blocker is a **~47-module config/runtime/session substrate**: **15 Electron-value importers**
  (`config-loader`shim, `settings`, `config-schema`, `auth`, `branding-assets`, `cloud-workspace-auth`
  /`-cache`/`-credentials`, `gateway-workspace-credentials`, `runtime-component-manifest`,
  `runtime-content`, `runtime-managed-server`, `runtime-mcp`, `runtime-opencode-cli`, `workflow-store`)
  + **32 config-loader/settings importers** (agent-config, runtime-config-builder, capability-catalog,
  runtime.ts, session-registry, permission-config, …).

**Gating insight — no inversion shortcut.** The cloud is a *standalone* server (runs in Docker without
the desktop) that runs opencode sessions through the **same** config/runtime/session engine as desktop.
So that substrate must become **package-resolvable**, not injected-away. The *only* thing blocking a
wholesale move is the **15 Electron value-imports** inside it. Critical path: decouple those 15 →
batch-move the (now Electron-free) substrate into a package → lift `main/cloud`.

### Milestone A — Electron-decouple the substrate ✅ COMPLETE (2026-06-24)
All 15 Electron-value substrate modules are Electron-free via four injected hosts in
`@open-cowork/shared/node` (`AppPathHost`, `SafeStorageHost`, `DesktopShellHost`) + a
per-module forker (`runtime-managed-server`), all wired by `desktop-electron-hosts.ts`
(+ the desktop entry for `utilityProcess`). The closure analysis now reports **0 Electron
value-importers** directly reached; the only residual Electron reach is the `config-loader`
**shim**'s side-effect import of `desktop-electron-hosts` — cut in B when the cloud stops
importing the shim. Commits: A1 (AppPathHost, 5 modules), A2 (SafeStorageHost, 6 credential
modules), A3a (DesktopShellHost: settings + cloud-workspace-auth), A3b (branding-assets split,
auth, runtime-managed-server forker). **Refined B insight:** the substrate splits by SDK —
non-SDK modules (config core, settings, workspace stores, capability-catalog) go to
**`@open-cowork/shared/node`** (no Docker change); only SDK modules (runtime-config-builder,
agent-config, runtime.ts, permission-config, session-history-loader, runtime-state) go to
**`@open-cowork/runtime-host`**. Cut the config-loader shim's electron side-effect by moving
host wiring to the desktop entries once the substrate imports the relocated cores.

### Milestone A (original plan) — Electron-decouple the substrate
Apply the proven core+shim / inject-host pattern (per `config-loader`, `logger`) to each Electron-value
module so the substrate stops importing `electron`:
- **A1** `config-loader` step 2: cloud imports `config-loader-core` + injects a cloud host (cuts the
  cloud's config-loader edge). `[1]`
- **A2** `settings` — `safeStorage` **BYOK credential encryption**. *Security-critical; dedicated careful
  pass; no secret-handling behavior change.* `[2–3]`
- **A3** runtime electron modules: `runtime-content`, `runtime-mcp`, `runtime-opencode-cli`,
  `runtime-component-manifest`, `runtime-managed-server`. `[3–5]`
- **A4** workspace/auth electron modules: `auth`, `branding-assets`, `cloud-workspace-auth`/`-cache`/
  `-credentials`, `gateway-workspace-credentials`, `config-schema`, `workflow-store`. `[4–6]`
  *(several may prove cloud-unreached on inspection → prunable, lowering the count)*
- **A5** `runtime-paths` config-decouple → unblocks `runtime-environment` + `runtime-process-cleanup`. `[1–2]`

### Milestone B — ✅ COMPLETE (2026-06-24)
**Final move landed:** the full **~100-module substrate** (config cluster, `runtime.ts`,
`session-engine`, `agent-config`/`agent-prompts`, `runtime-config-builder`, `permission-config`,
the managed/node managed servers + supervisor, knowledge store, coordination, workflow store,
session loaders, etc.) now lives in `@open-cowork/runtime-host` and is consumed by both the
desktop main process and the cloud server via the **wildcard `./*` subpath export** (plus the
`.` barrel and `/config` subpath). The remaining `apps/desktop/src/main` modules import the
substrate through `@open-cowork/runtime-host/*` package specifiers; relative `.ts`/dynamic-import
edges were repointed, and two substrate→desktop dynamic edges were inverted to dependency
injection (`semantic-ui-bridge` ← `diagnosticsBundleBuilder`; `agent-tool-bridge` ←
`scheduleRuntimeRefresh = rebootRuntime`). The **managed-server supervisor** was consolidated into
runtime-host (built by tsc → `dist`, forked next to the desktop main bundle via a repointed vite
entry, and resolved from `node_modules/@open-cowork/runtime-host/dist` in the cloud — the separate
build-cloud esbuild of it is gone). runtime-host now also pins `opencode-ai` (it resolves the
bundled OpenCode CLI). The SDK-boundary allowlist + `docs/opencode-sdk-v2-boundary.md`, the
brand-naming allowlist, and the `knip` runtime-host config were updated for the new locations.
**Gate green:** runtime-host build 0 · node 2099/0 · renderer 475/475 · lint clean · knip ≤ baseline
(unlisted binaries improved 6→4) · `cloud:build` green · desktop `vite build` green (supervisor
emitted next to main). (`build:electron`'s raw main-tsc keeps a pre-existing 54 jsx errors from the
cloud-SSR → `@open-cowork/website` → `@open-cowork/ui` source chain — byte-identical to HEAD, 0
delta, out of scope here.)

**Done:** all Electron decoupling (A) + injection infra + substrate Electron-free (value+type);
logger entry-injection; config cluster (11) relocated into `@open-cowork/runtime-host` (proven
pattern: `/config` subpath + main barrel + export-collision curation + ajv/resourcesPath);
the 6+2 type-only `BrowserWindow`/`IpcMainInvokeEvent` edges decoupled to minimal structural
types. **Breakthrough:** a bulk-move dry run showed the substrate's *only* tie to the
desktop+cloud bridge layer (`workspace-gateway → cloud/transport-adapter`, a would-be circular
`runtime-host → cloud-server` edge) was a single constant — `knowledge-tool-bridge` importing
`LOCAL_WORKSPACE_ID` (already in `@open-cowork/shared/node`). Repointing it dropped
`workspace-gateway` + the `cloud-workspace-*` bridge modules out of the substrate closure
(**115 → 102 modules, zero Electron, zero cloud/ edges**) — the substrate is now a clean, acyclic
relocation target. **Remaining (mechanical, proven):**
1. **lib cluster → `@open-cowork/shared`**: `lib/session-view-*` (browser-safe pure calc, used by
   renderer + `session-engine`) — must land in shared before the substrate move.
2. **102-module substrate → `@open-cowork/runtime-host`** via a **wildcard `./*` subpath export**
   (each module by path — no flat-barrel collision management) + a runtime-host self-path in
   tsconfig (for the config-cluster names already imported via the barrel). Script:
   `git mv` (preserve subdirs) → rewire (`.ts`→`.js`, `config-loader`→`/config`, `logger`→
   shared/node, builtins→`node:`) → repoint external (desktop-only) importers to the subpaths.
   The dry run already validated the move + surfaced (and now fixed) the only blockers.
3. **Milestone C** below.

### Milestone B (original plan) — Relocate the Electron-free substrate into a package
Batch-move the substrate (config-loader-core, settings-core, runtime-config-builder, capability-catalog,
runtime.ts, session-engine, agent-config, the 32 config modules) into a shared package (expand
`@open-cowork/runtime-host`, or new `@open-cowork/app-core`). Desktop + cloud both import it. Batched by
subsystem: config · runtime · session · agents · workflow · coordination · launchpad · knowledge-store
(~8 batches).

### Milestone C — ✅ COMPLETE (2026-06-24)
- **C1** ✅ `runtime-node-managed-server` + supervisor consolidated into runtime-host (done as part of B).
- **C2** ✅ created `packages/cloud-server`; moved all ~201 `main/cloud/**` modules in. The cloud layer was
  remarkably clean — zero Electron (even type-only), and the only escapes were `logger` (→
  `@open-cowork/shared/node`) and the deep `cloud-client` path (→ `@open-cowork/cloud-client`).
  `postgres-knowledge-store` already lived in runtime-host (moved in B). The package is **esbuild-bundled**
  (it SSRs React via `@open-cowork/website`, which is jsx-coupled and never tsc-built standalone), so its
  `exports`/entry resolve to source: the desktop's local control plane imports modules through the
  `@open-cowork/cloud-server/*` subpath, and the cloud `build-cloud` entry scripts bundle it from a relative
  source path. Type-checked transitively via the desktop main tsc + `cloud:build` esbuild.
- **C3** ✅ no Dockerfile build line needed (cloud-server is esbuild-bundled, not tsc-built; the image copies
  `packages/`, full-installs, then `cloud:build` bundles it). `build-cloud` entry scripts repointed; the 6
  desktop importers + the smoke/proof scripts repointed to the package.
- **C4** ✅ the electron-boundary test is structural and now walks the `packages/cloud-server/**` graph (zero
  Electron). The build-cloud Electron shim is still consumed (the esbuild-bundled runtime-host substrate
  reaches guarded `app`/`safeStorage`), so no shim names were dead.

**Bonus:** extracting the cloud removed the desktop-main → `@open-cowork/website` → `@open-cowork/ui` jsx
import chain (the desktop imports only cloud *control-plane* modules, not the SSR app), so `build:electron`'s
raw main-tsc dropped from a long-standing **54 pre-existing jsx errors to 0**.

**Gate green:** node 2099/0 · desktop typecheck 0 · `build:electron` 0 (was 54) · renderer 475/475 · lint clean ·
knip improved vs baseline (unused files 13→5, unused exports 288→156, unused deps 1→0, unlisted binaries 6→4) ·
`cloud:build` green · desktop `vite build` green. The original audit finding (cloud graph silently
value-imports Electron) remains test-enforced by `cloud-server-electron-boundary.test.ts`, now scoped to the
extracted package.
