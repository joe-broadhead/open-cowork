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

- `apps/desktop/src/main/agent-config.ts`
- `apps/desktop/src/main/agent-prompts.ts`
- `apps/desktop/src/main/cloud/app.ts`
- `apps/desktop/src/main/cloud/byok-runtime-config.ts`
- `apps/desktop/src/main/cloud/opencode-runtime-adapter.ts`
- `apps/desktop/src/main/cloud/worker-scoped-runtime-adapter.ts`
- `apps/desktop/src/main/event-subscriptions.ts`
- `apps/desktop/src/main/events.ts`
- `apps/desktop/src/main/ipc/context.ts`
- `apps/desktop/src/main/opencode-adapter.ts`
- `apps/desktop/src/main/permission-config.ts`
- `apps/desktop/src/main/question-normalization.ts`
- `apps/desktop/src/main/runtime-config-builder.ts`
- `apps/desktop/src/main/runtime-managed-server-core.ts`
- `apps/desktop/src/main/runtime-managed-server.ts`
- `apps/desktop/src/main/runtime-mcp-status-polling.ts`
- `apps/desktop/src/main/runtime-node-managed-server.ts`
- `apps/desktop/src/main/runtime-skill-verifier.ts`
- `apps/desktop/src/main/runtime-state.ts`
- `apps/desktop/src/main/runtime.ts`
- `apps/desktop/src/main/session-history-loader.ts`
- `apps/standalone-gateway/src/opencode.ts`

## Shared Event Contract

The OpenCode SDK event stream is normalized once at the runtime boundary:

```text
OpenCode SDK event
  -> opencode-runtime-adapter.ts
  -> CloudRuntimeEvent / CloudSessionEventType
  -> shared cloud projection reducer
  -> desktop/web/gateway rendering
```

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
records.

## SDK v2 Upgrade Checklist

Use this checklist for every OpenCode SDK or `opencode-ai` runtime bump:

- Confirm `apps/desktop/package.json` pins both `@opencode-ai/sdk` and
  `opencode-ai`, then update `pnpm-lock.yaml`.
- Run `pnpm proof:opencode:compatibility` and resolve any registry drift before
  accepting the bump.
- Run `pnpm typecheck` first. SDK type drift in runtime config, client calls, or
  server options is treated as real drift.
- Verify `apps/desktop/src/main/runtime-config-builder.ts` still emits
  SDK-native config for providers, agents, skills, MCPs, permissions, and model
  defaults.
- Verify `apps/desktop/src/main/cloud/byok-runtime-config.ts` still injects BYOK
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
- Run gateway renderer tests after `pnpm --filter @open-cowork/gateway build`:
  `node --no-warnings --experimental-strip-types --test apps/gateway/src/event-renderer.test.ts`.
