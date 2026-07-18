# Changelog

## Unreleased

### First-class working-directory binding

- `opencode-gateway project new <alias> --directory <repo-path>` binds a project to
  a real local repository (an inline `local-process` environment with that workdir)
  so agents do — and reviewers verify — actual file work there.
- An unbound `local-process` task no longer inherits the daemon's ambient working
  directory (which silently leaked agent file edits into wherever the daemon runs,
  e.g. the Gateway repo). It now defaults to a Gateway-owned, per-project workspace
  under the state dir (`<state-dir>/workspaces/<roadmap-or-task-id>`), created on
  demand, so file work stays real and contained.
- Docs: documented `--directory`, the workspace fallback, and model-tier guidance
  (under-powered models block at the quality/evidence gate).

### Removed channel proof-of-delivery feature

- **Removed the `channel prove` proof-of-delivery evidence harness end to end.**
  Deleted the correlation/fixture engine (`src/channel-proof.ts`), the persisted
  proof-index sidecar (`src/channel-proof-index.ts`) plus its backup/restore
  wiring, the `channel prove` CLI command and setup-guide "Prove" section, and the
  `channelProofs` surface of the redacted evidence bundle.
- **Simplified the channel connector onboarding/readiness model.** A connector is
  now fully ready once trusted **and** bound (`connect → verify → trust → bind →
  monitor`); the `prove` step, `live_proof_pending` state, `live_proof_missing`
  diagnostic, `prove` onboarding action, and all `proofEvidence`/`proofState`
  connector fields and guidance strings are gone. No user-facing surface references
  a removed proof command.
- **Removed the `web`/`tui` local pseudo-channels** (`WEB_ALPHA_CAPABILITIES`,
  `TUI_ALPHA_CAPABILITIES`, their registry entries, `isLocalPlaceholder`, and the
  synthetic `['web','tui']` sessions) that only existed to feed the proof harness.
- The `channel_proof_index` backup sidecar was fully removed; backup/restore
  migration invariants now track the remaining derived sidecars.

### Claw roadmap audit hardening (world-class pass)

- Peer **Basic auth is wired** via `createGatewayOpenCodeClient` (headers + fetch)
  for `opencodePeers`; missing credentials fail closed when `basicAuth` is set.
- `session_admissions` is a real schema table (not mid-flight DDL).
- AgentPresence create always validates OpenCode agent existence on HTTP/MCP/CLI;
  tests use `createAgentPresenceForTest` only.
- Scheduler + channel/project session create/prompt/abort prefer
  `opencode-session-runtime` port; channel free-text likewise.
- Product contract + HTTP route table document AgentPresence, session admit, peers.
- AgentPresence wake field documented as reserved (sticky chat model, not supervisor wake loop).
- **`session_admit` is now genuinely capacity-bounded**: `load` counts the live
  sessions it has itself admitted (intersecting recorded admissions with
  OpenCode's live session list), so repeated admits are refused — closing the
  de-facto free-spawn hole where the gate only ever saw scheduler/channel load.
- **`session_admit`, `agent_presence_create`, and `agent_presence_update` are
  admin-tier** (MCP `GATEWAY_MCP_TOOLS=admin`; HTTP `/sessions/admit` and
  `/agent-presences` mutations require `admin`): session creation and
  trusted-free-text rebinding are operator setup, not default-agent actions.
- **`POST /personas` requires `asset_write`** (it writes an OpenCode primary
  agent to disk, the same asset class as `/opencode/agents/:name`).
- Task-stage dispatch pins **blocking prompt (`async:false`)** so the SDK 1.17.16
  `promptAsync` capability cannot silently turn dispatch fire-and-forget and drop
  the scheduler's turn-failure path; a `promptAsync` test fake guards it.
- `opencodePeers` hosts are screened against link-local/cloud-metadata/unspecified
  ranges (`169.254.0.0/16`, `0.0.0.0`, `metadata.*`); a caller-supplied admit
  `directory` must be an absolute path.

### Claw roadmap Phase 4 (#217)

- ADR: OpenCode workspaces deferred in favor of existing Gateway environments;
  experimental workspace APIs stay inventory-only until a future ADR.

### Claw roadmap Phase 3 (#216)

- Trusted **OpenCode peers**: config `opencodePeers` allowlists non-local
  hostnames for daemon-side fetches (default remains local-only SSRF posture);
  credentials stay env/file based (never in URL).

### Claw roadmap Phase 2 (#215)

- Add `opencode-session-runtime` port (separate from `gateway-runtime` client holder)
  with capacity-gated `session.admit` (HTTP `POST /sessions/admit`, MCP
  `session_admit`). Channel free-text session create uses the port. No free-spawn API.

### Claw roadmap Phase 1 (#214)

- Add **AgentPresence** durable SQLite bindings (`agent_presences`) plus
  CLI/MCP/HTTP for always-on OpenCode assistants (sticky channel free-text
  routing). Named distinctly from channel typing/presence.
- Persona factory creates OpenCode **primary** agents (`persona` CLI / MCP /
  `POST /personas`) on top of existing asset CRUD — no second persona runtime.

### Claw roadmap Phase 0 (#213)

- Bump `@opencode-ai/sdk` to **1.17.16** (latest stable at implement time).
- Add `docs/development/opencode-sdk-surface.md`: inventory of classic client
  usage, unused v2 APIs (`promptAsync`, `switchAgent`, background subagents,
  experimental workspaces), escape-hatch prompt fields, and phase guidance for
  the claw-style roadmap (#212).

### Security & honesty hardening (first-principles audit pass)

- **CORS no longer reflects a non-local origin.** The daemon and the live SSE
  stream now echo back only a *local* `Origin` (the same-origin dashboard); an
  arbitrary remote origin gets the canonical loopback value (`null` for SSE), so
  a remote browser page cannot read local daemon responses cross-origin even for
  an authenticated non-local actor. Non-browser API clients are unaffected
  (they do not enforce CORS). If you serve a cross-origin browser dashboard in
  exposed mode, that is now closed by default (gate-on-need allowlist, not a
  default).
- **Human gates that authorize an external effect are non-MCP-approvable.**
  `security.requireNonMcpDestructiveApproval` (default on) now rejects MCP-tier
  approval of every external-authority gate type — `destructive_action`,
  `external_side_effect`, `budget_exception`, `credential_use` — not only
  `destructive_action`. Procedural gates (`task_start`, `stage_transition`,
  `manual`) remain MCP-approvable. Closes the confused-deputy path where a
  delegated agent rubber-stamps its own external authority.
- HTTP bearer-token comparison now compares fixed-length SHA-256 digests, so the
  compare time no longer depends on token length (removes a token-length timing
  side channel).
- The overclaim scan (`release:check`) now covers **all** of `README` +
  `docs/**/*.md`, not just the entry pages, so a claim beyond the boundary cannot
  hide in a deeper reference/ADR/history page; `evidence:safety` is now a phase
  of `npm run verify`.
- The MCP server version now tracks `package.json` (was hardcoded `0.1.0`) via a
  shared `readPackageVersion()`.
- Public threat model now states the MCP trust-tier reality bluntly (an
  `operate`-tier MCP client driven by trusted free-text is a full durable
  operator) and recommends `GATEWAY_MCP_TOOLS=read` for lower-trust profiles.
- Naming honesty: gateway-self-facing "production readiness" → "local operating
  readiness"; dashboard "Private Alpha Health" → "Local Beta Health"; single
  canonical `CONTRIBUTING.md`.

### Breaking / migration

- Exposed-mode token-entropy floor (`security.exposedHttp.requireStrongToken`,
  default `true`) is now enforced at startup: an existing exposed deployment
  (`allowNonLocalHttp`) whose HTTP token is shorter than `minTokenLength` or
  below `minTokenEntropyBits` will **fail to start** after upgrading. Rotate to
  a strong random token, or set `security.exposedHttp.requireStrongToken=false`
  to acknowledge the weaker token. Localhost default and public-webhook/unsafe
  modes are unaffected.

### Performance (world-class gap pass)

- The whole-state hot path no longer scales with cumulative run history.
  Mutations, the scheduler's per-tick reads, and governance budget
  evaluation were all O(all runs ever recorded), JSON-parsing every run
  on every cycle; they now materialize only live runs (running,
  current-run-referenced, and a bounded recent-terminal slice) and price
  budgets with SQL aggregates. Mutation latency is flat ~2.4ms and a full
  scheduler cycle read is ~18x faster at 30k runs — steady-state cost is
  now independent of deployment age. All run history stays durable and
  queryable. A long-lived per-path SQLite connection with a prepared-
  statement cache removes per-op open/PRAGMA/recompile overhead, and idle
  scheduler wakeups coarsen from a 1s poll to a self-rescheduling timer.

### Added (world-class gap pass)

- Structured, leveled logging (timestamps, correlation ids, secret
  redaction; JSON opt-in), a Prometheus `/metrics` endpoint with retained
  SLO histograms and process self-metrics, and proactive
  leadership-lease-stuck and disk-space alerts.
- A `gateway_catalog` MCP discovery tool covering the full tool surface,
  tiered CLI help with `--version` / exit-2 unknown-command handling, and
  a generated MCP + OpenAPI reference from the tool/route registry.
- Exposed-mode hardening (rate limiting, auth-failure lockout, token-
  entropy floor), dry-run blast-radius previews for destructive tools,
  a non-MCP destructive-approval option, and an opt-in capability-scoped
  loopback — all default-off so the single-operator flow is unchanged.
- Idempotent task creation via a source/idempotency key; CHECK
  constraints on status/priority/dependency enums.
- Test engineering: a coverage ratchet, property-based tests (state
  machine, idempotency, serialization, config), parser fuzzing, golden
  data-bearing migration fixtures, and a typed OpenCode SDK fake.
- Supply-chain and quality gates in CI: Dependabot, npm audit, CycloneDX
  SBOM, Trivy image scan, cosign signing + provenance, a Biome lint/
  format gate, a weekly Stryker mutation run, and a safe-by-default HTML
  tagged template for the dashboard.

### Changed (world-class gap pass)

- Enabled four stricter TypeScript flags (`noFallthroughCasesInSwitch`,
  `noImplicitOverride`, `noPropertyAccessFromIndexSignature`,
  `noUncheckedIndexedAccess`), fixing ~2,177 resulting type issues with
  real guards.
- Config gains a zod validation layer over the normalizer; a canonical
  `GatewayError` transient/permanent/fatal hierarchy and a typed env
  accessor were introduced.
- The design-only worker-fleet surface (~2.8k lines) was removed, along
  with its CLI subcommands, config knob, event descriptors, and gates; the
  self-referential domain-boundary register was removed.

### Fixed (post-audit review pass)

- Inbound channel messages are no longer lost during a transient OpenCode
  outage: a transient bound-session or session-create failure now signals
  retry (Telegram cursor holds; WhatsApp returns 503 so Meta retries)
  instead of acknowledging the message as processed, while genuine poison
  updates are still skipped.
- Legacy channel allowlist rules (created before per-sender actor trust)
  can be healed in-band: a valid claim code from an already-trusted target
  merges the sender into the rule's `userIds`, and a startup alert flags
  actor-less rules that would otherwise silently stop forwarding free text
  (Discord DMs and group chats especially).
- Supervisor prompts are tracked in-flight and carry an abort timeout, so a
  hung transport can no longer double-dispatch a second turn into the same
  session.
- Service-manager `start` falls back to a direct daemon when the systemd
  user bus is unreachable; `stop` verifies the daemon actually stopped
  before reporting success and preserves a live daemon's PID file; the PID
  path now honors `OPENCODE_GATEWAY_CONFIG_DIR`.
- Audit-ledger retention deletes in bounded chunks off the boot critical
  path, and the per-append event-cap probe is throttled so it cannot become
  a delete-nothing table scan once durable rows exceed the cap.
- Removed stale attestations of the (now absent) shutdown/restart human
  gate from the MCP tool, security-policy catalog, and API docs; fixed
  dangling references to deleted `soak` and `/certification` surfaces;
  the `journalctl` log read now has a timeout so a wedged journal cannot
  stall the daemon; `node:sqlite` file-permission hardening now covers the
  leadership DB's WAL/SHM sidecars; unknown channel commands default to
  privileged (fail-closed).

### Removed

- Dead and self-referential machinery (~36k lines net): milestone report
  builders, the channel certification/proof-contract stack, dogfood and
  agent-arena harnesses, the evidence-taxonomy tower, three overlapping
  soak/scale-proof harnesses, the design-only RBAC and extension-governance
  contracts, the Postgres backend preview (storage is sqlite-only), and
  eight unreachable modules that shipped in the npm package (one imported
  vitest at runtime). All consumers (CLI, dashboard, readiness, routes,
  MCP tools, docs) trimmed to match; a knip gate in CI now prevents dead
  files and exports from regrowing.

### Fixed

- Restarts no longer discard in-flight work: the writer daemon adopts
  orphaned run leases on startup and on standby-to-writer promotion, so a
  predecessor's completions are accepted instead of being fenced for an
  hour and re-run. Fencing against live competitors is unchanged.
- Real graceful shutdown: SIGINT/SIGTERM handlers stop pollers and
  adapters, close the HTTP server, release the writer leadership lease,
  and remove the PID file (5s force-exit deadline); `/shutdown` and
  `/restart` route through the same path, so restarts resume as writer
  immediately instead of waiting out the lease in standby.
- Telegram poison updates can no longer livelock a channel: the poll
  cursor always advances past attempted updates, with a redacted skip
  audit event.
- Notification dedupe events (`opencode.request.notified` and four
  siblings) are durable, so the event cap can no longer break documented
  idempotency.
- Supervisor prompts run outside the scheduler critical section; a hung
  OpenCode turn no longer stalls all scheduling.
- `opencode-gateway stop` and `start` are service-manager aware
  (launchctl/systemd) and lifecycle routes are no longer blocked by the
  destructive-action human gate; `install.sh` loads the supervised
  service instead of spawning an unsupervised detached daemon, and
  supports piped/non-interactive installs (`--yes`, `--dry-run`).
- Opening a database newer than the binary's schema is refused instead of
  silently restamping the version; `server.listen` failures exit cleanly
  with remediation instead of an uncaught exception.
- Daemon file logs rotate (10MB, keep 5); Linux service logs go to
  journald so the documented `journalctl` guidance works; `cli start` no
  longer hardcodes the macOS log path; service definitions no longer bake
  in install-time cwd and repo paths; the bin wrapper reports the real
  startup error.
- Transient OpenCode errors no longer abandon channel session bindings;
  corrupt channel-sync state is quarantined instead of halting inbound
  processing; CLI stop validates PID ownership before killing; worker
  fleet accepts exactly one result per run; SSE client ids no longer
  collide.

### Security

- Free-text channel ingress now requires per-sender actor trust by
  default (new `security.trustTargetMembersForFreeText` escape hatch);
  the trust gate fails closed for providers without an allowlist; SQLite
  WAL/SHM sidecars are owner-only; the WhatsApp verify token compares in
  constant time; Telegram polling errors and channel-sync failures are
  redacted before logging.

### Changed

- Node.js floor raised to 22.13 (first release where `node:sqlite` loads
  unflagged), with a friendly preflight message instead of a stack trace.
- Audit ledger retention (365 days / 200k rows) with a hash-chain anchor
  so verification survives pruning, plus a serving index for the
  per-append dedupe probe; delivered/dead-letter outbox rows are pruned.
- Scheduler whole-state loads cut from 6+ to 4 per tick; work-store
  mutations serialize each row once instead of deep-cloning and double
  fingerprinting the full state; idle channel-sync polling backs off
  exponentially (3s-60s, reset on activity); SSE disconnects stalled
  clients and skips unchanged broadcasts; mission data is cached for 3s
  across dashboard tabs.

### Added

- PR CI now boots the real daemon HTTP server (auth ordering, 403 shape,
  CORS reflection, SSE lifecycle) and proves SQLite contention and
  writer/standby leadership across two OS processes; 52 test files
  migrated to unique temp dirs (full suite passes at 4 workers).

### Documentation

- Swept the post-v1.3.0 stale references: the module-boundary-budget page
  is regenerated from the enforced JSON, deleted-milestone pointers are
  rewritten or marked historical, channel-command/HTTP/CLI references are
  complete in both directions, alpha-era runbooks moved to history or
  refreshed as the beta operator-onboarding runbook.

## v1.3.0 - 2026-07-04

### Changed

- Replaced the M27-M59 milestone report machinery (79 modules, 112 test
  files, 243 operations documents, two 700-line gate scripts) with the
  claim registry (`src/claim-registry.ts`), lean release/safety gates, and
  a distilled decision log. Runtime behavior is unchanged; the claim
  boundary is identical and now machine-enforced end to end. The removed
  originals remain in Git history.
- README, docs landing page, and production-readiness page rewritten
  product-first; MkDocs navigation rebuilt (328 -> 69 pages); the release
  cockpit dashboard view now renders directly from the claim registry.
- CLI: milestone-flavored evidence subcommands removed; support proofs are
  `support proof` / `support incident-proof`; backend proof aliases are
  `fleet-scheduler` / `observability-plane`; new `release claims` prints
  the claim registry.

### Added

- MCP tool tiers: `GATEWAY_MCP_TOOLS=read|operate|admin` bounds which
  `gateway_*` tools an agent sees, enforced at registration time; tiers
  are cumulative and invariant-tested. Default remains the full surface
  for the local trusted operator.
- Daily bounded soak workflow: release smoke, stress suite, and a timed
  live daemon window with claim-boundary verification and redacted
  evidence artifacts. Explicitly not the multi-day elapsed soak that
  release-candidate claims require.

### Compatibility

- Initiative (roadmap) and Issue (task) vocabulary and all `gateway_*`
  tool, HTTP, CLI, and storage contracts remain supported and unchanged.

- M36 deepen/simplify public-beta hardening scope gate with bigger-finding register, claim boundary, downstream issue specs, dependency model, stop conditions, and parseable evidence summary without expanding release claims.
- M36 redacted evidence contract module with shared claim/redaction/validation/residual-risk vocabulary for evidence exports and support diagnosis, plus fail-closed validation for unsafe refs, secrets, raw channel targets, private transcript text, and unsupported public wording.
- M36 operator journey contract with shared current-action, wait-owner, permission-state, recovery-path, channel-capability, and proof-state vocabulary across OpenCode Web/TUI recovery links, permission waits, channel native-control truth, Mission Control, and support diagnosis.
- M36 orchestration replay timeline invariants requiring terminal delegated completions to target the expected parent OpenCode session receipt and requiring permission waits/resolutions to causally precede run completion while preserving timestamp-valid out-of-order replay.
- M36 service lifecycle plan command with shared setup/update/start/stop/restart/status/health/doctor/logs/backup/restore/incident/cleanup/uninstall vocabulary, dry-run cleanup target validation, and explicit manual uninstall boundaries.
- M36 simplification register with current owner boundaries, canonical setup routing defaults, direct service-log ownership, and explicit deferrals for broad high-risk refactors.
- M36 public-beta hardening decision closing the tranche as bounded local evidence with no release-claim expansion and routing M37 scale/trust follow-up.
- M37 production-ready scale/trust scope gate with trusted-boundary map, asset classification, threat register, issue dependency order, and evidence schema seed without expanding release claims.
- M37 capability-scoped security authorization matrix with generated route/action coverage, trusted-channel binding invariants, OpenCode-owned permission routing checks, exposed-mode fail-closed validation, support-safe redaction checks, readiness coverage, and `opencode-gateway security matrix`.
- M37 durable-state consistency proof with ownership mapping, migration/backup/rollback visibility, stale binding detection, readiness integration, and local-only durable-state claim boundaries.
- M37 agent-fleet capacity and backpressure proof with isolated preview state, configured-limit redaction, Mission Control proof command routing, retry-storm/cleanup/capacity evidence, and no arbitrary-scale claim expansion.
- M37 orchestration invariant proof with deterministic scheduler/delegation/channel receipt replay, known-bad fixtures for failed review gates, stale parent sessions, unsettled provider delivery, permission waits, and restart recovery.
- M37 channel provider trust certification with provider-neutral capability/proof states for Telegram, WhatsApp, Discord, OpenCode Web, and TUI, preserving typed-command fallback and blocked/deferred channel states.
- M37 support diagnosis and incident-bundle proof with shared trace roots, attention semantics, redacted support evidence, strict review-gate mode, and no managed-support claim expansion.
- M37 public release readiness decision closing the tranche as continue public local beta with bounded local scale/trust evidence, no release-claim expansion, residual-risk register, and M38 public-release architecture closure routing.
- M38 public-release journey map and claim gate with state vocabulary, install-to-support journey matrix, claim boundaries, dependency routing for M38-2/M38-3/M38-4, and parseable evidence summary without expanding release claims.
- M38 OpenCode session continuity and stale-link recovery certification so `/open`, `/switch`, `/bind session`, `/status`, HTTP session inspection, and latest-run links provide TUI, Mission Control, and session-evidence fallback instead of dead Web links when OpenCode sessions disappear.
- M38 permission decision UX and owner-routing certification so OpenCode question/permission waits show trusted-channel alignment, receipt ownership, forwarded-to-OpenCode reply wording, and reason-coded channel-security denials without claiming Gateway owns OpenCode permissions.
- M38 channel command/action/presence truth certification with a Telegram native command-manifest guard, explicit slash-command verb versus argument-autocomplete semantics, bounded trusted-inbound typing evidence, and WhatsApp/Discord fallback/deferred provider states without universal-channel claim expansion.
- M38 provider-neutral onboarding and proof-state contract with explicit Connect/Verify/Trust/Bind/Prove/Monitor flow, connector `proofState` policy/claim/status payloads, CLI/HTTP/Mission Control rendering, and bounded setup-readiness wording without WhatsApp/Discord live-readiness claim expansion.
- M38 bounded local agent-fleet lifecycle, budget/admission, recovery, cancellation/cleanup, retry, and duplicate-terminal-receipt certification with shared `lifecycleModel` output in CLI JSON, readiness, and Mission Control without arbitrary-scale or unattended-fleet claim expansion.
- M38 support-grade observability, redacted incident-bundle, and operator-handoff certification with `opencode-gateway support m38-proof`, M37 support-proof reuse, M38 dependency alignment, failure-class handoff actions, and bounded local support wording without managed-support claim expansion.
- M38 public-release architecture closure decision and residual-risk register, closing the tranche as continue public local beta with bounded local journey/session/permission/channel/onboarding/fleet/support evidence and no release-claim expansion.
- M39 release-candidate proof scope gate with bigger-finding register, evidence dependency map, stop conditions, claim matrix, and schema seed for elapsed soak, fresh Web/TUI/Telegram proof, WhatsApp/Discord proof or waiver, fleet safety, hosted/team/compliance boundaries, marketplace governance, and final release-candidate decision without expanding release claims.
- M39 WhatsApp/Discord provider-proof waiver renewal with exact live-proof blockers, future provider proof path, expiration triggers, and blocked live-readiness/universal-channel wording.
- M39 local fleet scale, cleanup, and kill-switch proof with fresh worker-fleet capacity/lifecycle output, emergency-stop denial, cleanup/recovery receipts, Mission Control rendering, and synthetic hundreds-agent benchmark evidence while keeping arbitrary-scale and unattended-operation claims blocked.
- M39 hosted/team, compliance, and managed-support boundary decision keeping self-hosted beta, hosted, SaaS, multi-tenant, compliance, managed-support, and hosted-worker claims blocked while naming the evidence required before those claims can move.
- M39 marketplace and agent-package governance readiness model for manifests, package surfaces, capabilities, grants, eval scorecards, promotion states, rollback evidence, and residual risks while keeping public marketplace, arbitrary third-party trust, hosted package execution, signed distribution, team-wide package RBAC, and unattended auto-update claims blocked.
- M40 world-class codebase and release-quality scope gate with executable issue-card equivalents, dependency map, stop conditions, claim matrix, and parseable evidence summary for module boundaries, typed evidence contracts, proof automation, release artifacts, local performance budgets, and simplicity cleanup without expanding release claims.
- M40 executable module boundary and dependency budget with owner-domain map, known cycle budget, forbidden import rules, `npm run boundaries:check`, release-check enforcement, and regression coverage for unauthorized cross-boundary imports without expanding release claims.
- M40 typed evidence, claim, proof, redaction, validation, residual-risk, evidence-ref, unsupported-claim, and safe-next-action contract consolidation across evidence exports and support diagnosis without expanding release claims.
- M40 deterministic proof-run automation via `opencode-gateway evidence proof-run`, capturing dry-run/live mode, command, elapsed time, operator action, channel and parent-session receipts, OpenCode-owned permission/recovery posture, redaction state, and shared evidence-contract state without expanding release claims.
- M40 supply-chain, install, and release-artifact hardening with `npm run release:artifacts`, package builds that exclude compiled test fixtures, mandatory/advisory evidence semantics, package tarball sha256 integrity, direct dependency license posture, install/update/rollback documentation checks, and explicit unsigned/local-beta provenance boundaries without expanding release claims.
- M40 local performance, scale, and responsiveness budgets via `opencode-gateway performance budgets`, covering bounded Mission Control windows, channel status, readiness/queue status, proof/evidence export windows, incident/support bundle windows, and worker-fleet capacity/backpressure without arbitrary-scale or hosted/team claim expansion.
- M40 simplicity and ownership cleanup with a machine-checkable M40-7 register, deletion of the unused channel native slash wrapper so `channel-actions` remains the single native slash registry owner, and explicit M41 routing for broader work-store, Mission Control, evidence pipeline, and CLI cleanup without release-claim expansion.
- M40 world-class codebase and release-quality decision closing the tranche as continue public local beta with bounded local quality evidence, M41 routing for larger runtime simplification and scale-proof work, and no release-claim expansion.
- M41 deep runtime simplification and scale-proof scope gate with bigger-finding register, production-agent-ready issue-card equivalents, dependency/parallelization plan, stop conditions, claim boundary, and parseable evidence summary without expanding release claims.
- M41 work-store mutation compatibility contract with explicit mutation entry points, old-record fixtures, required proof, backup/rollback gates, preview-backend gates, manifest coverage checks, and Postgres-compatible preview blockers for missing contract coverage without changing the supported local SQLite backend.
- M41 scheduler/worker runtime state-machine contract with explicit active/terminal run ownership helpers, transition/invariant validation, and live scheduler/work-store checks wired to the shared contract without release-claim expansion.
- M41 provider-neutral channel UX contract for slashable command verbs, typed/copy argument fallbacks, bounded Telegram typing/presence, Gateway-owned versus OpenCode-owned decision receipts, and WhatsApp/Discord deferred states without universal-channel or WhatsApp-live claim expansion.
- M41 Mission Control data-plane V2 contract with bounded source windows, shared dashboard/MCP/support source-state vocabulary, support-safe summaries, and high-volume local read-model evidence without hosted, unattended-production, or arbitrary-scale claim expansion.
- M41 Evidence Pipeline V2 contract with one evidence-contract owner for redaction, claim-state, validation, evidence refs, residual risks, and decision gates across evidence exports, proof runs, support diagnosis, and incident bundles without release-claim expansion.
- M41 deterministic runtime simulation harness covering local delegated work, channel rendering, permission waits, stale-session recovery, duplicate terminal receipts, channel delivery failures, budget gates, and evidence emission without live-provider or release-claim expansion.
- M41 simplicity cleanup with a shared proof redaction scan owner, duplicate proof-run/runtime-simulation scanner deletion, rejected cleanup-candidate register, and no release-claim expansion.
- M41 deep runtime quality decision closing the tranche as bounded local runtime quality hardening complete, routing M42 release-proof/live-operator certification, and keeping release-candidate, production, hosted/team, arbitrary-scale, universal-channel, marketplace, compliance, managed-support, and unattended-operation claims blocked.
- M42 release-proof and live-operator certification scope gate with evidence lanes for seven-day elapsed local soak, fresh Web/TUI/Telegram live proof, WhatsApp/Discord proof or waiver, release-operations rerun, support handoff refresh, and final exact wording while keeping release-candidate and broader claims blocked until the final M42 decision.
- M42 WhatsApp/Discord provider-proof waiver renewal keeping live provider, provider parity, hosted webhook, provider-managed onboarding, universal-channel, release-candidate, production, and unattended provider-channel claims blocked until fresh redacted provider proof replaces the waiver.
- M42 release-operations and service-lifecycle certification rerun with fresh release-artifact, release metadata, service lifecycle, isolated release smoke, setup/update, backup/recovery, credential isolation, daemon health, readiness, dashboard, log, restart, and redacted incident bundle evidence while preserving manual uninstall/autostart, advisory audit/provenance, release-candidate, production, hosted/team, universal-channel, arbitrary-scale, compliance, managed-support, and unattended-operation bounds.
- M42 support, incident, and operator handoff refresh with current M42 proof-state routing, support-safe collection guidance, redaction rules, handoff classes, and explicit blockers for missing seven-day elapsed soak and fresh Web/TUI/Telegram live operator proof without managed-support or release-claim expansion.
- M20 WhatsApp first-beta pilot waiver closeout for JOE-163, accepting Telegram as the narrow live beta channel while keeping WhatsApp-live, parity, universal-channel, and readiness claims blocked until fresh redacted provider proof exists.
- M20 first beta operator pilot closeout for JOE-164, recording a blocked-but-useful live pilot with passing Telegram proof, passing release smoke backup/recovery, blocked readiness/support/human-gate posture, and no wider beta or WhatsApp-live claim expansion.
- M20 beta evidence pack and launch decision for JOE-165, choosing `PAUSE_FOR_FIXES` with an honest channel matrix, validation record, active stop conditions, and next-tranche routing without approving wider beta invites or public launch wording.
- M21 WhatsApp direct Cloud API parity blocker closeout for JOE-183 with current CLI blocker evidence, exact safe next actions, and no WhatsApp beta-parity or live-readiness claim expansion.
- M36 validation gate map with release-check enforcement, explicit CI skip semantics, deterministic remote-crabbox timeout fixture hardening, and quick-mode soak timing classification for full-suite reliability.
- M23 public local beta release decision, residual-risk register, and share-safe evidence bundle.
- M24 hosted/team-scale product boundary decision with deployment-mode matrix and blocked-claim map.
- M24 durable backend strategy with domain inventory, migration/rollback contract, and readiness backend posture.
- M24 identity/RBAC/capability-grant model with principal/resource definitions, privileged operation mapping, and readiness authorization posture.
- M24 secrets and credential lifecycle model with Gateway/channel/OpenCode/MCP credential inventory, redaction boundaries, rotation runbook, and readiness secret posture.
- M24 scheduler/worker-fleet protocol with mode boundaries, coordinator/worker roles, lease transitions, failure recovery, and machine-checkable invariants for later multi-host validation.
- M24 audit, retention, and incident evidence design with event taxonomy, retention classes, shareable evidence boundaries, and readiness audit posture.
- M24 remote execution sandbox and worker environment contract with mode matrix, policy surfaces, failure modes, redaction boundaries, and contract tests for local/default versus remote worker invariants.
- M24 tenant quota, cost accounting, budget admission, and abuse-control model with deterministic admission fixtures, redacted cost events, storm suppression rules, and readiness quota posture.
- M24 extension governance model for connectors, MCPs, skills, OpenCode tools, agent profiles, teams, blueprints, and future agent packages, including manifest validation, trust tiers, capability declarations, rollback flow, and readiness posture.
- M24 deployment topology, SLO, and disaster-recovery model with local-only release boundary, self-hosted/hosted mode contracts, probe definitions, claim validation fixtures, and readiness deployment posture.
- M24 hosted/team-scale readiness decision record with a proceed-bounded decision into M25 implementation foundations while preserving local-only public release wording.
- M25 work-store repository domain contracts and backup-compatible schema manifest summaries for future backend migration work, without changing the supported `local_sqlite` runtime.
- M25 Postgres-compatible backend preview adapter with disabled-by-default config, schema/transaction/read-projection plans, manifest comparison, and value-free readiness posture.
- M25 identity/RBAC primitives with explicit local-trusted compatibility grants, redacted trusted-channel principal mapping, and a deny-by-default evaluator that remains foundation-only until later M25 enforcement gates.
- M25 secret-reference and local vault adapter foundation with scoped in-memory injection guardrails, value-free readiness metadata, and hosted/team vault claims still unsupported.
- M25 self-hosted preview proof pack with controlled topology, health, backup/restore, cutover, rollback, DR, worker, secret, audit, quota, channel, redaction, and operator-acceptance gates.
- M25 extension manifest trust-policy and rollback-evidence preview with approved/blocked/unknown fail-closed states, operator-visible capability/grant disclosure, and bounded local asset governance.
- M25 self-hosted/team-scale implementation readiness decision record with a proceed-bounded decision into M26 codebase health and no expansion of local-only public beta claims.
- M26 deep module and simplicity finding register with ranked orchestration, channel readiness, Mission Control, work-store, test seam, and deletion candidates for production-agent execution.
- M26 architecture handoff map with module ownership, action/calculation/data boundaries, change-routing guidance, diagrams, and production-agent validation checklist.
- M26 codebase health readiness decision and residual-risk register with a proceed-bounded path into M27 release-candidate and team-preview activation planning.
- M27 release-candidate and team-preview activation plan with claim matrix, dependency map, evidence map, redaction rules, and closeout criteria.
- M27 release-candidate soak assessment harness and CLI (`soak rc-runbook`, `soak rc-assess`) with workflow coverage gates, stale/incomplete/failed classification, and redacted evidence output for JOE-255 review.
- M27 selected-surface team-preview authorization evaluator for HTTP, MCP, channel commands, worker actions, admin operations, and evidence exports with redacted `authz.team_preview.decision` audit evidence.
- M27 secrets lifecycle operator UX with value-free rotation, revocation, scoped-injection, and audit posture in CLI, readiness, and Mission Control.
- M27 backend activation operator surface with value-free `backend status`, consistency scan, migration preflight, cutover dry-run, rollback dry-run, Mission Control posture, and activation runbook for bounded self-hosted preview evidence.
- M27 worker-fleet activation operator surface with value-free `worker-fleet status`, simulation, failure drills, stale recovery, Mission Control posture, and activation runbook for bounded worker preview evidence.
- M27 channel certification matrix with per-provider workflow status, live-proof boundaries, recovery parity, Mission Control rendering, readiness posture, and evidence-export summaries.
- M27 redacted release-review evidence pack with issue coverage, gate status, missing/stale/failing blockers, release-claim boundary, and audited evidence-export generation.
- M27 readiness decision and residual-risk register that keeps Gateway in public local beta while recording bounded preview foundations and missing proof gates.
- M28 strategic product-scale activation plan with claim matrix, dependency map, issue evidence map, redaction policy, closeout criteria, and recommended first execution slice for hosted, tenant-isolation, worker-fleet, agent-package, eval, channel, observability, and benchmark work.
- M28 hosted control-plane tenancy contract with deployment mode matrix, control-plane and worker-plane custody boundaries, route/MCP/channel surface changes, migration implications, blocked claims, and implementation slices before any hosted preview.
- M28 bounded tenant-isolation authorization proof with cross-tenant, missing-scope, revoked-principal, stale-grant, channel, worker, evidence-export, and redacted readiness fixtures without hosted multi-tenant release claims.
- M28 backend consistency proof with work-store domain invariant scans, migration manifest compatibility, backup freshness, rollback safety, read-model checksums, readiness/Mission Control posture, and value-free CLI evidence without hosted or multi-tenant storage claims.
- M28 worker-fleet gate proof with worker classes, sandbox cleanup admission, quota/cost backpressure, denied-action audit evidence, Mission Control/readiness posture, and hundreds-of-queued-tasks scale fixture without hosted or unattended worker claims.
- M28 governed agent package distribution preview with fail-closed manifest compatibility checks, least-privilege asset/channel/budget/gate disclosure, deterministic diff/apply/rollback preview, and package-attributed team assembly receipts without marketplace or third-party trust claims.
- M28 continuous Agent Arena eval gate with isolated promotion/rollback proof, blocked-scorecard promotion denial, cross-role team orchestration evidence, readiness/Mission Control posture, and redacted scorecard/decision summaries without arbitrary agent-quality claims.
- M28 channel ecosystem certification contracts with adapter SDK posture, recovery-parity checks, explicit waived/deferred states, readiness/Mission Control/evidence surfacing, and redacted provider proof boundaries without universal channel parity claims.
- M28 support observability contract with audit-ledger trace coverage, local/preview service-level boundaries, audited operator actions, incident bundle posture, Mission Control/readiness surfacing, and explicit unsupported hosted/managed-support claims.
- M28 hundreds-agent benchmark lab with `soak scale --mode hundreds`, scenario thresholds, queue/storage/notification/failure/budget metrics, redacted reports, and bounded scale-claim language.
- M28 strategic product-scale readiness decision and residual-risk register with a proceed-bounded closeout into M29, preserving the public local beta boundary while recording bounded proof foundations and blocked hosted/SaaS/team-production/compliance/unattended claims.
- M29 finding register, quality bar, and architecture decision map with ranked audit findings, issue ownership, execution dependencies, safe parallelization, and no-claim-expansion guardrails for codebase/runtime reliability work.
- M29 typed contract hardening inventory plus fail-closed HTTP JSON object-root validation for daemon route and webhook bodies.
- M29 central security policy facade with reason-coded decisions, redacted evidence envelopes, HTTP exposed-mode integration, and denial-proof fixtures for channel, admin route, package, secret, and cross-scope access.
- M29 orchestration state-machine registry with replay transition invariants for task/run lifecycle regressions and duplicate non-idempotent completions.
- M29 runtime lifecycle diagnostics for blocked starts, stale active environments, retained resources, cleanup failures, missing/abandoned workspaces, and missing artifact refs in environment views.
- M29 incident bundle source freshness, failure classification, redaction manifest, and output-window metadata for degraded-mode operator support.
- M29 codebase simplification and ownership register with ranked cleanup candidates, canonical module owners, and bounded deferrals for larger refactors.
- M29 architecture navigation, troubleshooting triage, and agent handoff template for safer maintainer and worker-agent changes.
- M29 codebase/runtime reliability readiness decision and residual-risk register with a proceed-bounded closeout into M30 release-candidate evidence planning.
- M30 release-candidate evidence plan with claim-boundary questions, issue-to-proof matrix, dependency map, stop conditions, waiver vocabulary, validation gates, and public-copy guardrails before any release wording changes.
- M30 security-policy migration closeout with MCP request policy wrapping, privileged channel denial evidence, worker/package/secret/evidence denial fixtures, and an explicit sensitive-surface migration matrix.
- M30 JOE-277 fresh evidence pack with isolated release smoke, quick synthetic scale/recovery, local durable delegation/progress drill summaries, and explicit blocked/deferred claim gates before any release-candidate wording changes.
- M30 JOE-279 live-channel proof pack with fresh Telegram WF3 live proof, Web/TUI partial local-surface classification, WhatsApp blocked/operator-deferred state, Discord deferred state, and a redacted channel matrix for M30 decision input.
- M30 JOE-280 self-hosted/team preview proof drill with backend preflight, dedicated backup verification, recovery/rollback/cutover blocker evidence, channel posture, and explicit no-claim-change boundaries.
- M30 JOE-281 worker-fleet lifecycle/quota drill evidence with isolated `--store` proof commands, lifecycle/failure/gate proof passes, 240-task backpressure fixture, and explicit no-hosted/no-unattended claim boundaries.
- M30 release-operations certification with isolated release smoke, temp service lifecycle, backup/recovery/rollback, incident bundle generation, and manual bounds for real service autostart and uninstall.
- M30 public beta support handoff pack with safe evidence collection, incident bundle sharing rules, current proof interpretation, blocked/degraded workflow examples, and explicit no-claim-expansion boundaries.
- M30 release-candidate graduation decision closing the tranche as `continue beta` with no release-claim expansion and a residual-risk register feeding M31.
- M31 world-class Gateway scope gate with operator journey map, surface classification, execution map, stop conditions, and no release-claim expansion.
- M31 canonical channel action registry generating typed command coverage, Telegram native slash commands, Telegram/WhatsApp command menus, capability-boundary classification, `/channels/capabilities` action parity, and the Mission Control Channels action table.
- M31 security drift and redaction proof command/readiness check covering sensitive capability-boundary entries, central policy surface states, and share-safe denial fixtures without release-claim expansion.
- M31 fleet supervision proof command/readiness check covering capacity backpressure, quota admission reason codes, storm suppression, worker-fleet preview drills, and blocked hosted/unattended scale claims without release-claim expansion.
- M31 domain-boundary register and readiness check covering owner modules, edge adapters, forbidden crossings, interface-level tests, and deferred high-risk simplification candidates without release-claim expansion.
- M31 support diagnosis cockpit covering running/stale/permission/degraded/failure/safe-evidence/next-action operator questions across CLI, HTTP, observability, and readiness without release-claim expansion.
- M31 public-release excellence decision and residual-risk register closing the tranche as `continue beta` with local excellence foundations and no release-claim expansion.
- M32 release-soak and channel-continuity certification plan with evidence vocabulary, proof ledger contract, execution map, stop conditions, and no release-claim expansion before final readiness evidence.
- M32 beta-soak ledger workflow with pause/resume/interruption commands, redacted ledger export, run IDs, safe next-proof guidance, and pass refusal when elapsed duration or proof streams are incomplete.
- M32 Web/TUI continuity recovery proof with structured stale-session recovery JSON, channel-safe `/open` fallback text, and redacted evidence for selected Session/Project continuity.
- M32 Telegram beta continuity proof matrix with native slash-command drift guards, callback typing/ack regression coverage, and explicit live-drill-pending claim boundary.
- M32 WhatsApp operator-deferred provider waiver with deterministic adapter evidence, missing live-provider gate matrix, rerun checklist, and explicit no-WhatsApp/no-universal-channel claim boundary.
- M32 Mission Control support diagnosis proof-state panel with additive `SupportDiagnosisReport.proofStreams`, `m32_certification` operator question, redacted evidence refs, and truthful partial/waived/deferred states.
- M32 release-soak and channel-continuity readiness decision closing the tranche as `continue beta` with no release-claim expansion, explicit proof-state matrix, residual-risk register, and M33 next-tranche recommendation.
- M33 deepen-and-simplify runtime architecture scope gate with ranked bigger-findings register, owner-module/test map, safe parallelization rules, and no release-claim expansion.
- M33 work-store bindings mutation port with channel/HTTP project-binding callers, mirrored channel binding contract tests, and backend-preview transaction-plan alignment without changing the supported `local_sqlite` runtime.
- M33 Mission Control source-state query contract with freshness metadata, severity, safe next actions, dashboard/MCP source summaries, stale/degraded regression coverage, and a bounded quick-soak render budget aligned with the existing local hundreds-agent envelope.
- M33 channel action registry v2 with provider-native slash/action coverage metadata, bounded Telegram typing policy, WhatsApp/Discord fallback truthfulness, Mission Control surfacing, and no release-claim expansion.
- M33 delegation progress route receipts with durable delivery state, retry/stale-parent/orphaned classifications, route-receipt proof fallback, storage doctor invariants, and no release-claim expansion.
- M33 unified operator decision control plane with canonical owner/state/next-action summaries for Gateway gates, completion proposals, OpenCode questions/permissions, and fail-closed channel actions without bypassing OpenCode ownership.
- M33 dependency snapshot budget with local cycle/fan-in/fan-out evidence, low-risk canonical-owner cleanup, and deferred high-risk deletion register without release-claim expansion.
- M33 maintainability readiness decision closing the deepen/simplify tranche as continue-beta, proceed-bounded into M34, with no release-claim expansion and a claim/residual-risk matrix.
- M34 production-grade control-plane scope gate with ranked finding register, downstream issue specs, safe parallelization rules, and no release-claim expansion.
- M34 daemon leadership and single-writer fencing with standby JSON-route mutation refusal, redacted scheduler lease-fence metadata, readiness/support diagnosis surfacing, and no release-claim expansion.
- M34 durable-state lifecycle audit with retention-class inventory, read-only workflow-event compaction dry-run, durable receipt drift repair guidance, audit-ledger chain/hash scans, storage-doctor surfacing, and no release-claim expansion.
- M34 approval and permission UX proof with operator-decision surface matrices across Web/TUI recovery, trusted channels, CLI/MCP, Mission Control, request notifications, Needs Attention, and support diagnosis without bypassing OpenCode ownership.
- M34 worker-fleet isolation and backpressure proof with value-free isolation controls, operator-visible queue/budget/cancellation/cleanup states, supervision readiness surfacing, and bounded local preview claims.
- M34 orchestration replay and fault-injection proof with delegated route receipts, OpenCode permission waits, review-gate failure classification, cancellation/recovery fixtures, owner-specific safe next actions, and no release-claim expansion.
- M34 local public-beta release-operations certification with first-class release-smoke certification JSON, redacted incident-bundle support handoff proof, backup/recovery evidence, loopback daemon/dashboard smoke, and explicit manual cleanup/uninstall bounds.
- M34 production control-plane readiness decision closing the bigger-findings milestone as continue-beta with bounded local control-plane evidence, explicit residual risks, M35 release-evidence issue cards, and no release-claim expansion.
- M35 public local-beta release-evidence scope gate with claim lock, evidence vocabulary, live-proof prerequisites, stop conditions, issue-card specs, and no release-claim expansion before soak/channel/service proof.
- M35 fresh Telegram and Web/TUI operator proof with live delegated-work evidence, local `opencode` project/session binding recovery for Web/TUI continuity, explicit OpenCode-owned permission boundaries, and bounded Telegram slash/typing UX limitations.
- M35 service lifecycle and uninstall proof with enhanced release-smoke readiness, daemon log capture, temporary daemon restart evidence, backup/recovery, redacted incident bundle, and explicit manual uninstall/autostart bounds.
- M35 WhatsApp operator-deferred provider waiver renewal with exact live-proof blockers, operator setup path, redaction boundaries, and no WhatsApp-live or universal-channel claim expansion.
- M35 seven-day local beta soak closeout record classifying elapsed soak evidence as deferred, with daily snapshot contract, stop conditions, and no release-candidate or production claim expansion.
- M35 public local-beta release decision renewing the one-trusted-local-operator beta boundary from M34/M35 evidence while keeping elapsed-soak, WhatsApp-live, universal-channel, hosted/team, release-candidate, production, arbitrary-scale, compliance, marketplace, managed-support, and unattended-operation claims blocked or deferred.

### Changed

- README, production readiness docs, and operator cockpit release-claim copy now use the M23 public local beta boundary instead of the earlier M22-only decision.
- Public release copy now links hosted, team, multi-tenant, remote-worker, and marketplace claims to explicit M24 evidence gates.
- Readiness and storage doctor output now expose `local_sqlite` backend posture and unsupported hosted/team caveats.
- Storage readiness and doctor output now report `postgres_compatible_preview` as an experimental optional integration foundation when explicitly selected, while keeping effective public-beta persistence on `local_sqlite`.
- M24 readiness introduced `security_authorization_model` as local-trusted compatibility with hosted/team RBAC explicitly bounded rather than release-ready.
- Readiness now reports `security_secret_lifecycle` with value-free configured input metadata, local config warnings, legacy HTTP token warnings, and hard WhatsApp app-secret prerequisite failures.
- Readiness now reports `scheduler_worker_fleet_protocol` with the current single-host local coordinator boundary and design-only multi-host/hosted statuses.
- Readiness now reports `compliance_audit_retention` with supported local redacted evidence and design-only compliance ledger/hosted audit posture.
- Readiness now reports `runtime_remote_execution_contract` with the supported local-process default, opt-in local container/operator remote preview statuses, and design-only/unsupported self-hosted and hosted worker postures.
- Readiness now reports `governance_quota_budget_model` with local governance support and explicit design-only/unsupported posture for tenant quotas and hosted abuse controls.
- Readiness now reports `governance_extension_model` with Gateway-owned local asset support, fail-closed manifest preview checks, rollback-evidence posture, and explicit unsupported posture for marketplace enforcement and third-party auto-update.
- Readiness now reports `operations_deployment_topology` with the local-only public beta deployment boundary, M25 self-hosted preview proof-pack posture, and explicit unsupported posture for remote-worker and hosted modes.
- `security_authorization_model` readiness now reports local-trusted compatibility plus selected-surface M27 team-preview enforcement while keeping hosted, SaaS, multi-tenant, and organization-wide RBAC unsupported.
- `security_authorization_model` readiness now also reports the M28 bounded tenant-isolation proof status, representative paths, negative fixtures, and unsupported hosted/multi-tenant claims without exposing raw tenant identifiers.
- `security_secret_lifecycle` readiness now reports the M27 bounded team-preview secret lifecycle posture, value-free `secretref_*` records, rotation health, revocation state, scoped injection guardrails, and deny-by-default local adapter caveats.
- Storage readiness now reports M27 backend activation state, supported dry-run commands, cutover/rollback proof requirements, and unsupported backend modes while preserving `local_sqlite` as the effective default persistence.
- Worker-fleet readiness now reports M27 activation state, result acceptance gates, capacity/recovery blockers, cleanup-failure proof posture, and unsupported worker modes while preserving the local single-daemon scheduler as the supported default.
- Channel readiness now reports M27 certification state by named provider and workflow, keeping WhatsApp, Discord, fixture-only, stale-proof, and unsupported channel claims visibly partial/deferred unless current redacted live evidence exists.
- README and production readiness now cite the M27 continue-beta closeout, making local RC, self-hosted beta, team-production, hosted, multi-tenant, WhatsApp-live, compliance, marketplace, and unattended production claims explicitly deferred until fresh evidence and a later decision approve them.
- Scheduler capacity-hold and transient-runtime retry timing now flow through explicit orchestration kernel calculations with interface-level tests.
- Channel native action delivery now uses a shared provider-neutral plan so Telegram, Discord, and WhatsApp controls preserve command identifiers or fall back to text instead of silently mutating actions.
- Channel service health now derives adapter status, remediation, and redacted evidence from an explicit connector lifecycle policy calculation so configured channels stay degraded until trust, binding, webhook, and proof prerequisites align.
- Mission Control high-volume windows now flow through a typed view-model calculation module with explicit source states, pagination/search contracts, observability contracts, and evidence-window selection for dashboard reuse.
- Scheduler run, lease, and dispatch receipt mutations now flow through a dedicated work-store run/lease port aligned with the local SQLite backend and Postgres-compatible preview transaction plan.
- Delegation progress routing now has an interface-level read-model seam and production-shaped fake for ordering, dedupe, and retry-cooldown tests without broad SQLite fixture setup.
- `gateway_dashboard` now renders from the shared Mission Control dashboard summary calculation instead of maintaining a separate MCP-only summary path.
- Worker-fleet CLI proof commands now accept `--store <state-db-path>` so release evidence can run against an isolated SQLite store instead of mutating live Gateway operator state.
- Adapter contract tests now import the canonical fixture pack directly from `src/testing` instead of through a test-only re-export wrapper.

## v1.2.0 - 2026-06-13

### Added

- OpenCode-native Gateway MCP proxy for service, scheduler, roadmap, task, run, event, channel, request, session, and OpenCode asset operations.
- Repo-shipped Gateway OpenCode agent team: `gateway-assistant`, `gateway-planner`, `gateway-coordinator`, `gateway-implementer`, `gateway-reviewer`, `gateway-verifier`, `gateway-supervisor`, and `gateway-auditor`.
- Repo-shipped Gateway skills: `gateway-assistant`, `gateway-planner`, `gateway-coordinator`, `gateway-stage`, `gateway-review-gate`, and `gateway-supervisor`.
- Durable SQLite work store for roadmaps, tasks, runs, workflow events, and channel bindings.
- Scheduler pipeline with strict structured stage results and default `implement -> review -> verify` gates, including spec-driven review/verify for non-code deliverables.
- Telegram and WhatsApp adapters that route into persistent OpenCode sessions and sync session output back to channels.
- Local dashboard focused on attention, active work, roadmaps, Gateway sessions, completed work, profiles, and events.
- Public MkDocs Material documentation structure with grouped getting-started, concepts, configuration, API, operations, and development sections.
- MIT license metadata and repository license file.

### Changed

- `gateway-assistant` is the default user-facing agent for normal OpenCode, Telegram, and WhatsApp interactions.
- Product-facing copy now introduces Gateway Method names alongside compatibility names: Initiative (roadmap) and Issue (task). Existing `gateway_roadmap_*`, `gateway_task_*`, CLI `task`, slash-command `/tasks` and `/roadmaps`, HTTP routes, IDs, and storage tables remain supported.
- Gateway config now reflects only current product state: OpenCode URL, daemon port, heartbeat, channel sync, scheduler, profiles, and channels.
- Observability artifacts now live under `~/.config/opencode-gateway/observability`.
- macOS LaunchAgent label is now `com.opencode-gateway.daemon`.
- Recent Gateway session sidecar records now use `startedAt` terminology and persist to `sessions.json`.

### Removed

- Prototype-era Gateway-owned runtime surfaces that duplicated OpenCode responsibilities.
- Prototype-era local artifact surfaces that were not part of durable Gateway state.
- Direct worker-spawn MCP tools and HTTP routes.
- Automatic permission-answering rules; OpenCode-native questions and permissions remain the source of truth.
- Prototype worker inspection endpoints superseded by `/session-state` and OpenCode session routes.
