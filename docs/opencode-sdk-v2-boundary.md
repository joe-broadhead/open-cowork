# OpenCode SDK v2 Boundary

Open Cowork is a product layer on top of OpenCode. OpenCode owns execution:
sessions, tools, permissions, questions, MCP behavior, native skills,
compaction, and event stream semantics. Open Cowork owns composition: desktop
and web UI, cloud control plane, projection, policy, sync, workflows, gateway
adapters, deployment, and product ergonomics.

The repository enforces that boundary with package-boundary tests. New OpenCode
SDK imports must be intentional, documented here, and limited to runtime
composition or SDK-event normalization code.

OpenCode compatibility assumptions that intentionally ship with Open Cowork are
listed in `apps/desktop/src/main/opencode-compatibility.ts`. Each entry names
its category, owner, source version, product modes, tests, and removal condition
when it is a shim or blocked policy. Runtime diagnostics export this registry
beside provider, model, MCP, and skill provenance so SDK drift, capability
state, and plugin policy are visible before release.

Run `pnpm proof:opencode:compatibility` before release and after every
OpenCode SDK/runtime bump. The command validates the same registry exported by
diagnostics and fails closed on missing bundled OpenCode version metadata,
unknown compatibility states, private assumptions, source-version drift,
missing proving tests, and shim/blocked entries that do not name removal
conditions. The fixture in
`tests/fixtures/opencode-compatibility-registry.json` records the intentional
registry shape; changing it is a compatibility review, not a snapshot refresh.

## Import Rules

- Cloud Channel Gateway packages must not import `@opencode-ai/sdk`,
  `opencode-ai`, direct Postgres clients, or cloud control-plane store
  implementations.
- Standalone Gateway is a separate execution authority. Its SDK usage is
  limited to the documented private OpenCode adapter in
  `apps/standalone-gateway/src/opencode.ts`.
- **Durable Gateway** (`products/gateway`, package `cowork-gateway`) is a
  **product partition** that coordinates OpenCode via its own daemon/MCP and
  may declare `@opencode-ai/sdk` at the **same pin as Desktop/Cloud (1.18.1)**.
  It currently uses the classic client entry + `client.session.*` call shapes
  (V2 field migration is a follow-up). It is not part of the Desktop Electron
  runtime-host path and must not be imported by `apps/desktop` or
  `packages/app`.
- Web, website, renderer, preload, and `@open-cowork/cloud-client` code must
  not import `@opencode-ai/sdk`.
- Desktop and cloud runtime code may import the SDK only in the files listed
  below.
- After SDK events are normalized, desktop, cloud, and gateway code should use
  Open Cowork's shared cloud projection event contract from
  `packages/shared/src/cloud-session-projection.ts`.
- BYOK credentials must enter OpenCode through runtime config provider options,
  never through process environment variables.

## Allowed SDK Import Paths

These files are the current SDK boundary. If a path no longer needs the SDK,
remove the import and remove it from this list. If a new file needs the SDK,
first decide whether the concept belongs in OpenCode runtime composition or in
Open Cowork product state.

The OpenCode runtime substrate (config composition, the managed/runtime server,
session loading, agent/permission/skill composition) now lives in
`@open-cowork/runtime-host` so the desktop main process and the cloud server can
share it. The remaining `apps/desktop/src/main` entries are product seams that
still touch SDK event/types at the desktop edge.

- `packages/cloud-server/src/app.ts`
- `packages/cloud-server/src/byok-runtime-config.ts`
- `packages/cloud-server/src/opencode-runtime-adapter.ts`
- `packages/cloud-server/src/runtime-adapter.ts`
- `packages/cloud-server/src/worker-scoped-runtime-adapter.ts`
- `apps/desktop/src/main/durable-session-events.ts`
- `apps/desktop/src/main/event-subscriptions.ts`
- `apps/desktop/src/main/events.ts`
- `apps/desktop/src/main/ipc/context.ts`
- `apps/desktop/src/main/ipc/provider-handlers.ts`
- `apps/desktop/src/main/runtime-mcp-status-polling.ts`

Desktop residual seams and removal plan: [desktop-composition-shell.md](desktop-composition-shell.md) (JOE-842).
`question-normalization` moved to `@open-cowork/runtime-host` (no SDK import).
- `apps/standalone-gateway/src/opencode.ts`
- `packages/runtime-host/src/agent-config.ts`
- `packages/runtime-host/src/agent-prompts.ts`
- `packages/runtime-host/src/opencode-adapter.ts`
- `packages/runtime-host/src/opencode-client-kernel.ts`
- `packages/runtime-host/src/opencode-v2.ts`
- `packages/runtime-host/src/permission-config.ts`
- `packages/runtime-host/src/provider-utils.ts`
- `packages/runtime-host/src/runtime-config-builder.ts`
- `packages/runtime-host/src/runtime-managed-server-core.ts`
- `packages/runtime-host/src/runtime-managed-server.ts`
- `packages/runtime-host/src/runtime-node-managed-server.ts`
- `packages/runtime-host/src/runtime-skill-verifier.ts`
- `packages/runtime-host/src/runtime-state.ts`
- `packages/runtime-host/src/runtime.ts`
- `packages/runtime-host/src/session-history-loader.ts`
- `products/gateway/src/opencode-client.ts` (classic entry at pin 1.18.1; residual `client.session.*` call shapes)
- `products/gateway/src/gateway-runtime.ts`
- `products/gateway/src/channel-sync.ts`
- `products/gateway/src/opencode-session-runtime.ts`
- `products/gateway/src/live.ts`
- `products/gateway/src/heartbeat.ts`
- `products/gateway/src/scheduler.ts`
- `products/gateway/src/observability.ts`

## Native V2 Capability Gaps

The production boundary uses `client.v2.*` wherever OpenCode 1.18.1 exposes a
working native route. A small classic-client allowlist remains for capabilities
that the generated V2 client does not yet provide. The boundary test pins every
remaining call by file, method, and count so this list cannot expand silently:

- Session actions without working native V2 routes: `session.command`,
  `session.delete`, `session.diff`, `session.fork`, `session.share`,
  `session.summarize`, `session.todo`, `session.unshare`, and `session.update`.
  OpenCode 1.18.1 generates `v2.session.compact`, but its server implementation
  returns `OperationUnavailable`; the classic summarizer remains the qualified
  route until the pinned runtime implements V2 compaction.
- MCP lifecycle/authentication, which has no native V2 group:
  `mcp.auth.authenticate`, `mcp.auth.remove`, `mcp.connect`, `mcp.disconnect`,
  and `mcp.status`.
- Explorer operations without working V2 equivalents: `file.status`,
  `find.symbols`, and `find.text`. The generated `file.read` V2 method does not
  expose the wildcard path required by `/api/fs/read/*`, so `file.read` remains
  classic until the SDK can address a file. Directory listing and file finding
  already use `v2.fs.list` and `v2.fs.find`.
- Runtime tool discovery: `tool.list`; V2 exposes agents, commands, skills,
  providers, and models, but not the effective tool catalog.

Remove an allowlist entry as soon as the pinned SDK exposes a working native V2
equivalent. Do not emulate these OpenCode-owned behaviors in Open Cowork.

**Status on OpenCode 1.18.1 (verified):** no allowlist row is burnable yet.
**JOE-845 decision:** full classic-allowlist burn-down is **Won't Do** on this
pin — do not invent V2 APIs. Track residuals and reopen on every OpenCode bump
via [opencode-classic-sdk-burndown.md](opencode-classic-sdk-burndown.md).

| Gap | Why it stays classic |
|-----|----------------------|
| `session.summarize` | Generated `v2.session.compact` exists but server returns `OperationUnavailable`. |
| `session.command` / `delete` / `diff` / `fork` / `share` / `todo` / `unshare` / `update` | No working native V2 routes on the pin. |
| MCP `auth.*` / `connect` / `disconnect` / `status` | No V2 MCP group. |
| `file.read` | Generated `v2.fs.read` does not expose the wildcard path for `/api/fs/read/*`. |
| `file.status`, `find.symbols`, `find.text` | No working V2 equivalents (`v2.fs.list` / `v2.fs.find` already cover list/find-files). |
| `tool.list` | V2 catalogs agents/commands/skills/providers/models, not the effective tool set. |

Burn-down is gated on an OpenCode SDK/runtime bump that proves each method,
then removes the exact allowlist entry in `tests/opencode-sdk-boundary.test.ts`
and switches the call site to `client.v2.*`. See the residual registry and bump
checklist in [opencode-classic-sdk-burndown.md](opencode-classic-sdk-burndown.md).

## Shared Event Contract

The OpenCode SDK event stream is normalized **once** by the canonical translator
in `@open-cowork/shared` (`packages/shared/src/opencode-event-translator.ts`).
Desktop, Cloud, and Standalone Gateway fan out **after** translation only:

```text
OpenCode SDK event
  -> normalizeOpencodeEventEnvelope + classifyOpencodeSdkEvent  (shared)
  -> surface fan-out:
       Desktop live  -> SessionEngine handlers (IPC / view model)
       Cloud         -> opencode-runtime-adapter payload shapes
                        -> CloudRuntimeEvent / CloudSessionEventType
                        -> shared cloud projection reducer
       Standalone    -> translateOpencodeEventForStandalone
                        -> channel-safe StandaloneRuntimeEvent
  -> desktop/web/gateway rendering
```

Rules (JOE-838):

- Do not re-parse raw SDK envelopes in surface code. Use
  `normalizeOpencodeEventEnvelope` / `normalizeRuntimeEventEnvelope`.
- Product kind decisions (permission.requested, tool.call, …) live in
  `classifyOpencodeSdkEvent`. Surfaces must not invent parallel type maps.
- Shared fixtures: `tests/fixtures/opencode-sdk-v2-events.json` plus
  `tests/opencode-event-translator.test.ts` and
  `tests/opencode-sdk-event-projection.test.ts`.

Cloud Channel Gateway rendering consumes `@open-cowork/cloud-client` session
events. It should never receive SDK client objects, SDK event envelopes, or
OpenCode subprocess handles. If a Cloud Channel Gateway feature needs more
detail, add that detail to the shared cloud event contract and projection tests
rather than importing the SDK.

Projection causality is modeled in the same shared contract, not in SDK event
objects. Use `createCloudProjectionFenceToken`,
`createCloudProjectionCheckpoint`, `cloudProjectionFenceObserved`, and
`createCloudAutomationEventEnvelope` from
`packages/shared/src/cloud-session-projection.ts` when a Cloud, Gateway,
workflow, paired Desktop, or automation path needs to prove that a mutation has
been observed by product projection. Fence identities must use exact
tenant/workspace/session/workflow-run/client ids; fuzzy or suffix matching is
not part of the contract.

Standalone Gateway has its own private OpenCode runtime boundary. SDK client
objects and raw SDK events must stay inside
`apps/standalone-gateway/src/opencode.ts`; the rest of the standalone app
should consume normalized standalone events and durable Gateway repository
records. Each channel delivery or queued job supplies a stable admission key,
which the adapter maps to the native V2 prompt `id`. After admission, the
adapter consumes `v2.session.events` from the returned `admittedSeq` rather
than relying on the lossy global event tail. This preserves fast completions
and crash retries without re-executing tool side effects. A bounded execution
deadline interrupts the native session if no terminal event arrives.

Desktop local runtime uses the same durable admission contract:

- `v2.event.subscribe` remains the process-level control plane (permissions,
  questions, untracked sessions, heartbeats).
- After each local `v2.session.prompt` admission, Desktop tracks that session
  on `v2.session.events` from `admittedSeq` and advances an `after` cursor from
  observed `durable.seq` values.
- While a session is durable-tracked, global-stream transcript
  (`session.next.*`, classic `message.*`) and idle terminals for that session
  are suppressed so two SSE tails cannot double-project.
- Shared helpers live in
  `packages/runtime-host/src/opencode-durable-session-events.ts`; the Desktop
  hub is `apps/desktop/src/main/durable-session-events.ts`.

### Classic vs `session.next` family ownership

OpenCode may emit both classic `message.part.*` and native `session.next.*` for
the same turn. Open Cowork receive-side ownership is:

1. Prefer `session.next.*` for live transcript once a message (or tool
   `callID`) has been observed on the native family.
2. Classic `message.part.delta` / `message.part.updated` for that message or
   call id is suppressed thereafter.
3. Classic handlers remain for history-shaped events and turns that never emit
   native events.

Idle multi-signal dedupe (`session.status` idle, `session.idle`, non-tool
`session.next.step.ended`) is unchanged and lives in
`event-runtime-handlers.ts`.

## SDK v2 Upgrade Checklist

Use this checklist for every OpenCode SDK or `opencode-ai` runtime bump:

- Confirm `apps/desktop/package.json` pins both `@opencode-ai/sdk` and
  `opencode-ai`, then update `pnpm-lock.yaml`. `packages/runtime-host/package.json`
  pins both `@opencode-ai/sdk` and `opencode-ai` (it is the node + SDK runtime
  substrate shared by the desktop main process and the cloud server, and it
  resolves the bundled OpenCode CLI); keep its pins in lockstep.
- Run `pnpm proof:opencode:compatibility` and resolve any registry drift before
  accepting the bump.
- Run `pnpm typecheck` first. SDK type drift in runtime config, client calls, or
  server options is treated as real drift.
- Verify `packages/runtime-host/src/runtime-config-builder.ts` still emits
  SDK-native config for providers, agents, skills, MCPs, permissions, and model
  defaults.
- Verify `packages/cloud-server/src/byok-runtime-config.ts` still injects BYOK
  provider credentials through `provider.<id>.options` only.
- Update SDK event fixtures for assistant message parts, tool calls,
  permission requests/resolutions, question requests/resolutions, todos, status,
  idle, and errors.
- Verify cloud event normalization maps every projection-critical SDK event into
  `CloudSessionEventType`.
- Verify permission and question round-trips still work through desktop, web,
  cloud worker, and gateway approval flows.
- Verify tool-call projection preserves tool id, name, status, input, output,
  attachments, and task-run association where the SDK provides them.
- Verify cloud worker startup still launches OpenCode through the runtime
  adapter and does not require Electron-only process APIs.
- Run the portability proof for runtime home/session resume assumptions:
  `pnpm proof:cloud:opencode-portability`.
- Run boundary and projection tests:
  `node --no-warnings --experimental-sqlite --experimental-strip-types --test tests/opencode-sdk-boundary.test.ts tests/opencode-sdk-event-projection.test.ts tests/cloud-opencode-runtime-adapter.test.ts tests/cloud-session-projection-contract.test.ts tests/gateway-package-boundary.test.ts`.
- Run the BYOK runtime injection tests:
  `node --no-warnings --experimental-sqlite --experimental-strip-types --test tests/byok-runtime-injection.test.ts tests/byok-boundary-regression.test.ts`.
- Run gateway renderer tests after `pnpm --filter @open-cowork/channel-gateway build`:
  `node --no-warnings --experimental-strip-types --test apps/channel-gateway/src/event-renderer.test.ts`.
