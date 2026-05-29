# Roadmap

Last updated: 2026-05-29.

Open Cowork is now planned and verified as a three-surface product over one
OpenCode-backed control plane:

- **Desktop:** local-first Electron app with optional cloud workspaces.
- **Cloud:** web app, API, worker, scheduler, control plane, BYOK, policy, and
  object storage.
- **Gateway:** headless channel adapter for Telegram, Slack, email, webhooks,
  and later channels.

The product promise is **workspace-scoped product sync**, not peer-to-peer sync
and not runtime replication. Cloud workspaces sync across desktop, web, and
gateway because every surface reads and writes the same tenant-scoped cloud
control plane. Local desktop workspaces stay private unless the user explicitly
copies selected state into cloud.

## First Principle

Open Cowork is a product layer on top of OpenCode, not a second runtime.

- **OpenCode owns execution:** sessions, child sessions, MCP execution,
  approvals, questions, compaction, native skills, streaming events, tool
  semantics, and agent runtime behavior.
- **Open Cowork owns composition:** desktop UI, packaging, branding,
  configuration, capability curation, event projection, workflow state,
  workspaces, cloud control plane, gateway adapters, and user-facing
  ergonomics.

If a roadmap item starts to replace OpenCode runtime behavior, it should be
simplified or removed.

## Product Thesis

Open Cowork should be useful in three deployment modes:

- **Local desktop:** a user runs OpenCode locally through a polished desktop
  product layer with no cloud dependency.
- **Self-hosted cloud:** an organization runs desktop, cloud, and gateway on its
  own infrastructure with its own branding, auth, storage, secrets, profiles,
  tools, agents, MCPs, and gateway providers.
- **Managed BYOK SaaS:** Open Cowork can be hosted as a service where customers
  bring their own provider keys and pay for managed sync, cloud execution,
  policy, gateway channels, reliability, and operations.

The business value is hosted convenience and operational reliability. The open
source product remains deployable without commercial lock-in.

## Non-Negotiable Product Promises

1. OpenCode owns execution. Open Cowork never becomes a second agent runtime.
2. Cloud workspaces sync. Desktop cloud workspace, browser cloud app, and
   gateway continue the same cloud sessions.
3. Local stays local. Local desktop sessions, files, MCPs, and credentials are
   never uploaded implicitly.
4. Gateway is headless and cloud-backed. It can run on a VPS, but it does not
   own session, runtime, or control-plane state.
5. Downstream deployers can configure the product without forking core code:
   branding, cloud URL, auth, profiles, tools, agents, MCPs, features, object
   store, secrets, quotas, and gateway providers.
6. Hosted SaaS stays BYOK. Managed Open Cowork can charge for hosted
   cloud/gateway/sync while users bring their own provider keys.
7. OSS self-host remains first-class. Billing and managed-service features must
   not block self-hosted cloud/gateway deployments.

## Strategic Roadmap

The three-surface roadmap is tracked by
[issue #448](https://github.com/joe-broadhead/open-cowork/issues/448). The child
issues below are the source of truth for implementation scope and acceptance.

### Phase 1: Product Contract And UX Semantics

Make the three-surface model explicit in docs, UI language, API support
matrices, and tests.

Tracked by #449.

Acceptance:

- Desktop, cloud, and gateway are described as coordinated surfaces over one
  OpenCode-backed control plane.
- Workspace state is clearly scoped as local or cloud.
- Local-only and cloud-safe actions are distinct in UI and docs.
- OpenCode/Open Cowork ownership boundaries are documented and tested.

### Phase 2: Seamless Cloud Continuation

Prove the flagship flow: start or continue a cloud thread from desktop, web,
and gateway with live state, approvals, questions, tools, and artifacts intact.

Tracked by #456.

Acceptance:

- A desktop-created cloud thread is visible in web.
- A gateway prompt continues the same cloud thread.
- Permission/question events round-trip through the shared cloud event contract.
- Desktop can restart and hydrate from durable cloud projections without
  corrupting cached cursors.

### Phase 3: Explicit Local-To-Cloud Import

Add a safe, consent-driven import/copy flow for selected local session state and
artifacts. No implicit upload.

Tracked by #457.

Acceptance:

- The user must choose **Copy to Cloud** explicitly from a local thread.
- The UI previews message, attachment, artifact, project-source, and excluded
  counts before upload.
- Local project source and host paths are excluded by default.
- Import payload validation rejects raw local paths and secret-like values.

### Phase 4: Cloud Project Context

Make cloud coding useful by giving workers a safe project source: git checkout,
uploaded workspace snapshot, or managed object-store workspace.

Tracked by #458.

Acceptance:

- Cloud thread creation can use a configured Git source or explicit uploaded
  snapshot.
- Snapshot inventory shows included/excluded files and size limits.
- Workers restore project context through cloud-safe storage.
- Local files are never uploaded implicitly.

### Phase 5: Downstream And Managed Productization

Unify branding/configuration across desktop, cloud, and gateway, then harden
SaaS BYOK and self-host deployment recipes.

Tracked by #459 and #463.

Acceptance:

- A downstream organization can configure product name, logo, cloud URL, auth,
  profiles, tools, agents, MCPs, object store, secret adapter, quotas, and
  gateway providers without source patches.
- Docker Compose and Helm deployments cover cloud and gateway.
- Cloud deployment references cover provider-neutral storage and secrets.
- Managed BYOK SaaS flows expose key status only; raw keys never leave the
  write path or worker runtime config boundary.

### Phase 6: Gateway Expansion

Promote gateway from Telegram/webhook foundation to a real headless product with
Slack and email first, then additional channels.

Tracked by #460.

Acceptance:

- Gateway is a cloud client/channel adapter, not an OpenCode runtime owner.
- Telegram, Slack, email, and webhook providers share one capability-driven
  rendering model.
- Approvals/questions work through inline controls where supported and token or
  link fallback where not.
- Gateway can self-host on a VPS with service-token auth and no direct
  control-plane database ownership.

### Phase 7: Production Refactor And Security Gates

Reduce cloud core coupling, harden OpenCode SDK boundaries, and add global
privacy/security/concurrency gates.

Tracked by #461, #462, and #464.

Acceptance:

- Gateway and client packages have zero direct OpenCode SDK imports.
- Only cloud worker/runtime code imports OpenCode SDK runtime surfaces.
- Raw provider keys, OAuth refresh tokens, MCP secrets, local file contents, and
  machine paths are absent from read APIs, renderer state, logs, diagnostics,
  and gateway payloads.
- Cloud control-plane domains are split behind service/store boundaries.
- Postgres concurrency gates cover leases, commands, events, deliveries,
  quotas, and scheduler claims.

## Core Product Loop

The desktop product loop remains:

```text
intake -> setup thread -> agent/tool selection -> saved workflow -> run thread -> history
```

The stable vocabulary is:

- **Chat** for direct work with OpenCode.
- **Agents** for reusable OpenCode-native workers.
- **Tools & Skills** for scoped authority and repeatable know-how.
- **Workflows** for reviewed recurring work around OpenCode-native execution.
- **Threads** for history and recall.
- **Artifacts** for generated files, charts, reports, and saved outputs.

Primary navigation should support one of those concepts or the workspace
surface that chooses where those concepts execute.

## Verification Gates

Completion of the strategic roadmap requires evidence from current code, tests,
and deployment artifacts:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:e2e` when UI/runtime paths are touched
- `pnpm perf:check` for renderer/runtime-sensitive work
- `uv run mkdocs build --strict` or CI docs build when docs are touched
- `git diff --check`
- Real Postgres concurrency tests with `OPEN_COWORK_TEST_POSTGRES_URL`
- Gateway provider/channel matrix tests
- Desktop cloud continuation E2E tests
- No-raw-secret boundary tests
- Package boundary tests for OpenCode SDK imports

## Non-Goals

These concepts remain outside the core product unless they collapse cleanly into
Chat, Agents, Tools & Skills, Workflows, Threads, or Workspaces:

- a parallel agent runtime outside OpenCode
- peer-to-peer runtime replication between desktop and cloud
- implicit upload of local files, local MCPs, local credentials, or machine
  runtime config
- team dashboards that bypass thread/workflow review
- self-directed proposal loops that create work without a user-defined workflow

This does not exclude user-invoked improvement work through bundled skills and
agents. The non-goal is an always-on autonomous work surface that creates work
without a user request.
