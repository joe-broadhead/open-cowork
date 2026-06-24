# Open Cowork — Deep Repository Audit (2026-06-24)

Whole-repo audit across **security, scalability/performance, code quality, dead code, dead docs, and production readiness**, run as five parallel specialist passes over `checkpoint/studio-production-audit`. Every finding was confirmed by reading the code; `file:line` cited throughout.

## Verdict

This is a **mature, security-conscious, high-quality codebase** (~200K LOC; ~43 `any`-casts, 0 `@ts-ignore`, 5 stale-free TODOs, strict tsc+eslint+knip gate, dual-backend contract tests, SLSA/SBOM/Cosign release supply chain). **No CRITICAL security vulnerabilities.** Tenant isolation, API-token verification, cookie/CORS/webhook-signature auth, command/SQL/path-injection defense, Electron hardening, and BYOK envelope encryption are all sound.

The material gaps are operational and performance-related, not correctness/security holes. One item is **P0 because it blocks CI today**.

---

## P0 — Do now (blocks CI / release)

- **Dependency-audit gate is RED.** `pnpm audit --prod` exits 1: **1 high + 8 moderate + 3 low**. CI (`.github/workflows/ci.yml:57-61`), release, and monthly-maintenance all run it fail-closed, so every PR/release is blocked. The `hono@<4.12.21` override (`package.json:122`) is stale (advisories now need `>=4.12.25`); no `dompurify`/`js-yaml` overrides exist.
  - **hono HIGH (CORS reflect-any-origin) + 4 moderate — NOT reachable.** hono enters only transitively via `apps/desktop → @modelcontextprotocol/sdk → hono`; there is **no `hono`/`serveStatic` import anywhere** and the cloud server is raw `node:http`. Bump for the gate, not for exposure.
  - **dompurify ≤3.4.6 (moderate) — REACHABLE.** Real use in `apps/desktop/src/renderer/components/chat/MarkdownContent.tsx:2` + `MermaidChart.tsx:2` sanitizing untrusted LLM/agent HTML before `dangerouslySetInnerHTML`. The IN_PLACE bypass applies; the `addHook` variants don't (no `addHook`). **Bump dompurify ≥3.4.11.** (Mitigated by sandboxed renderer + `script-src 'self'` CSP, but DOM-clobbering remains.)
  - **js-yaml (moderate, quadratic) — low reachability** (`electron-updater`, parses trusted update feed).
  - **Fix:** bump the `hono` override to `>=4.12.25`, add `dompurify >=3.4.11` + `js-yaml` overrides, re-run `pnpm audit --prod` to confirm exit 0.

---

## P1 — High (production blockers / real risk)

### Resilience
- **Cloud-managed OpenCode subprocess has no crash recovery.** `createDefaultCloudRuntimeFactory` never wires `onUnexpectedExit` (`packages/cloud-server/src/app.ts:380-389`; undefined at `opencode-runtime-adapter.ts:501`); the worker-scoped adapter keeps the dead cache entry (no liveness check) until idle-TTL, so `promptSession`/`subscribeEvents` hit a dead server with no respawn. SSE also doesn't re-subscribe on stream drop (`opencode-runtime-adapter.ts:389-420`). **Fix:** pass `onUnexpectedExit` that evicts/closes the runtime entry; surface the crash to in-flight callers.
- **Desktop runtime reconnect loop has no max-attempt cap** (`apps/desktop/src/main/index.ts:356-382`) — a persistently-crashing OpenCode reconnect-loops forever (60s backoff, no circuit breaker). **Fix:** terminal error after N failures in a window.
- **Gateway HTTP server has no socket timeouts (slowloris/DoS).** `createServer` (`apps/gateway/src/daemon.ts:134`) sets no `requestTimeout`/`headersTimeout`/`keepAliveTimeout`/`maxConnections`; the body reader (`:559-566`) caps bytes but not time. Internet-facing webhook endpoint. **Fix:** set request/headers/keepAlive timeouts + max connections.

### Secret hygiene (log-sanitizer)
- **Sanitizer misses Google `AIza…` and Slack `xox[baprs]-…` keys** (`packages/shared/src/log-sanitizer.ts:8-49`) — both are first-class BYOK/gateway providers, so realistic in logs. **Fix:** add both patterns.
- **The redactor is copy-pasted 8× with structural drift** (`postgres-store-normalizers.ts:27`, `in-memory-control-plane-store.ts:243`, `in-memory-domains/channel-deliveries.ts:175` + `channel-provider-events.ts:167` + `workers.ts:488`, and the three `postgres-store-domains/{channel-deliveries,channel-provider-events,workers}.ts`). The `workers.ts` pair has already diverged in form. Plus 3 *different* sanitizers (`log-sanitizer.ts`, `observability.ts:126-146`, `byok-secret-store.ts`) with inconsistent `sk-`/AWS/high-entropy rules — the unexpected-error path logs raw `error.message` to telemetry through the weaker one (`http-server.ts:1732-1745`). **Fix:** unify on ONE shared sanitizer (complete pattern set), delete the 7+ copies, route observability through it.

### Performance (criticals)
- **Cloud SSE fan-out is O(all connected clients) per event, cross-tenant.** `InMemoryCloudEventFanoutAdapter.publish` (`packages/cloud-server/src/session-event-bus.ts:39-44`) loops the entire global subscriber Set on every projected event; one busy tenant taxes all. **Fix:** index subscriptions by routing key (`Map<tenant:session, Set>` / `Map<tenant:user, Set>`) — the keyed `sse-replay.ts` hub is the model.
- **Synchronous `readFileSync`+`JSON.parse` on every streamed runtime event in the Electron main thread** (`apps/desktop/src/main/desktop-pairing/service.ts:329` → `store.ts:262`, registered at `ipc-handlers.ts:343`, fires per `message.part.delta`). UI jank scaling with token throughput. **Fix:** cache parsed pairings in memory; early-return when no online pairing.
- **Data retention: no TTL/pruning on any append-only table** — `cloud_session_events`, `cloud_workspace_events`, `cloud_usage_events`, `cloud_audit_events`, `cloud_workflow_runs`, `cloud_channel_deliveries`, expired `cloud_channel_interactions` (all `postgres-schema.ts`) grow forever; the in-memory variants too. Inflates backups (vs the 5-min RPO target) and slows boot-time `COUNT(*)` backfills. **Fix:** batched retention job in `CloudScheduler` per the runbook retention matrix; partition the hot event tables.

### Database hot-path queries (unindexed / unbounded)
- **`findSession`** — cross-tenant scan + sort, PK can't be used, `opencode_session_id` unindexed (`postgres-control-plane-store.ts:1034-1042`). Add indexes on `(session_id)` and `(opencode_session_id)`.
- **`listSessions`** — no LIMIT, grows per-user forever (`:1045-1057`); `listSessionsPage` exists — route callers to it.
- **`findApiTokenByPlaintext` legacy fallback** — unbounded cross-org scan + per-row hash on the auth hot path (`postgres-store-domains/api-tokens.ts`). Derive `token_id` and drop the scanning fallback.
- **`listSessionEvents`/`listWorkspaceEvents`** — optional LIMIT; projection-rebuild loads an entire session's event log into memory (`session-projection-service.ts:147`). Enforce a hard server-side max page; paginate rebuild by keyset.

---

## P2 — Medium

### Performance / memory
- **Renderer:** session-view derived per-patch over ALL messages + timeline mints fresh `Message` objects defeating `MessageBubble` memo (`packages/shared/src/session-view-messages.ts:303`, `chat-view-timeline.ts:64-88`); SessionInspector re-serializes all tool payloads + unvirtualized MessageList (`SessionInspector.tsx:267-282,467`); `ChatTimelineItem`/`ToolTrace` unmemoized. Derive once per batch; stable message identity; memoize.
- **Unbounded in-memory growth:** `viewCacheById` never pruned (`runtime-host/session-engine.ts:92`), `runtimeToolCache` TTL-but-no-size (`runtime-tool-cache.ts:13`), desktop `session-task-state-store` `sessionLineage`/`taskRuns` + O(N) scans never swept (`:111-120,345-378`), gateway per-stream render-state maps never evicted (`render/state.ts:20`). Add LRU caps / sweep eviction.
- **Gateway:** unbounded per-stream promise-chain queue (no backpressure) (`session-stream-manager.ts:170`), streams never torn down on session end (only 30-min TTL / 2000 LRU) (`:197-257`), unbounded outbound delivery concurrency + no per-provider rate limiting (`gateway-runtime.ts:54,72-87`), fixed 250ms reconnect (no backoff/jitter → thundering herd) (`:65,188`). Bound + backpressure + token-bucket.
- **Cloud writes:** `appendProjectedEvent` does ~6 sequential round-trips/event (`session-projection-service.ts:100-141`); reapers hold locks across ≤1000 round-trips in one tx (`postgres-control-plane-store.ts:1623-1730`, `workflows.ts:371-477`) with default `statement_timeout=0`. Batch + smaller tx batches + non-zero statement_timeout.
- **`MAX_DIRECTORY_CLIENTS=10_000`** (`runtime-host/runtime-state.ts:5`) — 10k live SSE connections before LRU eviction; lower to a realistic working set.

### Ops / deployment
- **Dockerfile healthcheck probes liveness, not readiness** — both hit `/healthz` (unconditional 200) instead of `/readyz` (real DB/object-store/secret round-trip). `docker/open-cowork-cloud/Dockerfile:46`, gateway `:44`. Point Docker healthcheck at `/readyz` (Helm already does it right).
- **Gateway `/ready` doesn't verify cloud control-plane connectivity** (`gateway-runtime.ts:101-104`) — can report ready while its core dependency is down. Fold cloud reachability into `ready()`.
- **Migrations re-execute fully on every boot** (no applied-guard on the transactional path; `postgres-migrations.ts:31-34`) — safe (idempotent DDL) but re-runs full-table `COUNT(*)` backfills, tying boot time to table size. Skip migrations already in `cloud_schema_migrations`.
- **`cloud:migrate` has no first-class deploy artifact** (no Helm Job/initContainer; only embedded migrate-on-boot). Add a pre-upgrade migration Job; document `RUN_MIGRATIONS=false` split-role flow.
- **`cloud:build` has no standalone CI gate** (only transitively via the Docker build). Add `pnpm cloud:build` + cloud typecheck to the validate job.
- **CodeQL uses `security-and-quality`, not `security-extended`** (`codeql.yml:47`).

### Code quality
- **Control-plane policy duplicated** between `postgres-control-plane-store.ts` and `in-memory-control-plane-store.ts` (lease-reaper tree, idempotency rules, monotonicity, lease-token format) — with one real behavioral inconsistency (Postgres compares `tenantId`/`sessionId` on idempotency reuse, in-memory omits them: `postgres…:1755` vs `in-memory…:1319`). Extract as pure rule functions.
- **Gateway signature/replay primitives diverge across providers** — `constantTimeStringEqual` reimplemented 4× with different null-handling (`webhook:872`, `slack:566`, `telegram:611`, `email:654`); replay-cache cloned webhook↔slack. A security primitive behaving differently per provider. Extract into `@open-cowork/gateway-channel`.
- **`getAdminPolicyOverview` returns org policy/feature/BYOK-policy config to any active member, not admin-gated** (`services/overview-service.ts:134-141`) — information exposure (no secrets/cross-tenant). Gate with `assertOrgAdmin` if intended admin-only.
- **Silently-swallowed errors degrade cloud features** — `workspace-gateway.ts:650` (`cloudPolicy` `catch {}` → can't distinguish network failure from policy denial), `session-handlers.ts:73` (active-workspace check → drops events), abort handlers swallow into return-null (renderer thinks abort succeeded). Add logging; distinguish error from negative result for abort.
- **God objects:** `WorkspaceGateway` 1801 lines / 6 concerns (`apps/desktop/src/main/workspace-gateway.ts`, two ~95%-identical subscribe methods), `projectSessionHistory` one 727-line function (`runtime-host/session-history-projector.ts:171`), `dispatchCloudWorkspaceSessionEvent` 216-line 13-branch translator (`ipc/session-handlers.ts:225`). `CloudSessionService` 15-positional-param constructor (`session-service.ts:458`). Extract sub-modules / options objects.

### Dead code
- **Broken import:** `apps/desktop/tests/smoke-helpers.ts:17` imports from `../src/main/e2e-remote-debugging.ts` **which no longer exists** (knip's lone unresolved import). Remove/fix.
- **Production command-palette leaks a DEV-only view:** `command-palette-items.ts:272-281` adds "UI Primitives (QA)" unconditionally, but the view is `import.meta.env.DEV`-gated (`App.tsx:53`) → selecting it in prod navigates to an empty view. Gate the palette item behind the same flag.
- **Unused files (knip-confirmed, no dynamic consumers):** `apps/desktop/src/main/file-session.ts`, `permission-inheritance.ts`, `renderer/components/agents/AgentAttributeBar.tsx` (or wire it into agent cards), `renderer/loading.ts`, `renderer/components/ui/utils.ts` (zero-importer re-export shim). Remove.
- **15 of 25 `StudioPrimitives.tsx` components are gallery-only** (CoworkerCard, ComposerShell, DeliverableCard, ArtifactCard, ChannelStatusCard/Row, PersonRow, WizardSteps/StepPane, WorkingStyleBars, StudioShell, ConversationLaneCard, KanbanBoard, PermissionEditorRow, TraitSlider) — only referenced by the gallery + barrels + tests. Decide: intentional design-system reserve, or prune / stop barrel-exporting.

---

## P3 — Low

- `webhook_replay_claims` trim sorts on unindexed `seen_at_ms`; `telemetry.trackEvent` uses sync `appendFileSync` per event; gateway shutdown drain can leak `ackDelivery` after timeout; `session-engine.removeSession` clones the whole map per removal; `unknownEventLastLoggedAt` map never cleared; MCP status poll fixed at 10s. (See scalability pass L1-L7.)
- Plaintext/weak-key secret adapter allowed outside `public_production` tier (`app.ts:803,810`) — extend envelope + strong-key assertions (or a loud warning) to `private_beta`.
- Bridge providers (Discord/WhatsApp/Signal) don't do native platform signature verification (trust an upstream relay; fail-closed) — surface the relay requirement in operator docs.
- Worker loop uses non-locking `listRunnableSessions` then races per-session lease (correct but wasteful; atomic `claimRunnableSessions` exists unused). Single explicit `: any` (`tool-trace-utils.ts:30`). `deriveKey` uses bare SHA-256 (fine for high-entropy key; HKDF would be cleaner). SECURITY.md has no PGP contact.

---

## Dead docs (stale after the cloud-server extraction + Studio pass)

- **Stale moved-path references** (cloud `apps/desktop/src/main/cloud/**` → `packages/cloud-server/src/`; substrate → `packages/runtime-host/src/`): `docs/architecture.md` (~14 paths), `AGENTS.md` (~14 paths **+ a broken markdown link at :23** to a removed file), `docs/downstream.md`, `docs/downstream-contract.md`, `docs/oss-packaging-migration.md`, `docs/security-model.md:158`, `docs/coordination-model.md:180`, `docs/claw-like-agents.md` (also references removed `automation.md`/`automation.ts`). Repoint.
- **Superseded-behavior docs** (Studio: single Mercury theme + glow removed): `docs/design-refinement-and-cloud-react-proposal.md` (argues to KEEP all presets + the glow), `docs/prototypes/mercury-polish-showcase.html` (Nord/Gruvbox/Dracula swatches), `docs/design-tokens.md`/`design-system.md` (ambient `--glow-*`). Archive / add superseded banners.
- **Completed design docs to archive:** `docs/design/cloud-server-extraction.md` (Milestone C ✅ COMPLETE), `docs/design/studio-production-audit.md` (mostly ✅; **dead link to `handoff/BRIEF.md`**), and the prior `docs/design/production-readiness-audit.md`.
- **Duplicate/overlapping:** `docs/production-readiness-audit.md` (2026-06-02, in `mkdocs.yml` nav) vs `docs/design/production-readiness-audit.md` (2026-06-16, broader, NOT in nav). Disambiguate; promote the newer or mark the older superseded.
- **Stale error string:** `scripts/validate-deployment-configs.mjs:1368` checks the new path but the failure message still names `apps/desktop/src/main/cloud/http-server.ts`.

---

## Verified strong (do not regress)

Tenant/workspace isolation (every session-scoped read/write funnels through `getSessionView(principal,…)` + tenant-scoped store; cross-tenant id → 404); API-token verification (scrypt + per-token salt + `timingSafeEqual` + revoked/expiry + active-membership); cookie auth (HMAC-signed, HttpOnly+Secure+SameSite, double-submit CSRF); CORS (exact allowlist, `*`+credentials blocked at boot); webhook signatures (Slack/generic/Telegram/Stripe/workflow — timing-safe, mandatory, replay-protected); **injection-clean** (all `child_process` use argv arrays, zero `shell:true`; all SQL parameterized; path traversal blocked by `assertSafeObjectKey`); Electron hardening (contextIsolation+sandbox, triple IPC channel allowlists + `assertTrustedIpcSender`, deny-all window-open, nav allowlist); BYOK envelope AES-256-GCM with tenant-bound AAD + strong-key validator; deployment-tier guardrails (fail-closed `public_production`); lease-based concurrency (`FOR UPDATE [SKIP LOCKED]`, monotonic tokens — horizontally scalable, exactly-once scheduler); graceful shutdown + orphan process cleanup (PID ledger, SIGTERM→SIGKILL, Windows `taskkill /T`); observability (structured JSON logs, correlation IDs, Prometheus/OTLP, real `/readyz`); release supply chain (signed tags, SHA256SUMS+GPG, SLSA provenance, CycloneDX+SPDX SBOMs, Cosign, Grype gate, SHA-pinned actions). Type discipline: 1 explicit `: any` in src, 0 `@ts-ignore`, narrow justified eslint-disables, no silently-empty catch blocks.
