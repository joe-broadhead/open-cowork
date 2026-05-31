# Roadmap

Last updated: 2026-05-31.

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

The active launch roadmap is tracked by
[issue #547](https://github.com/joe-broadhead/open-cowork/issues/547). The
child issues below are the source of truth for remaining implementation scope
and acceptance.

### Phase 1: Product Contract And UX Semantics

Make the three-surface model explicit in one canonical contract, shared status
vocabulary, docs links, and regression tests.

Tracked by [#548](https://github.com/joe-broadhead/open-cowork/issues/548).

Acceptance:

- [Product Contract](product-contract.md) defines Desktop Local, Desktop Cloud,
  Cloud Web, Gateway Channel, and Admin/Operator behavior.
- Workspace state is clearly scoped as local or cloud.
- Local-only and cloud-safe actions are distinct in UI, docs, and support
  verdicts.
- OpenCode/Open Cowork ownership boundaries are documented and tested.

### Phase 2: Cloud Web Workbench Completion

Complete Cloud Web as a production end-user and admin workbench, including
browser quality and route/API evidence.

Tracked by [#549](https://github.com/joe-broadhead/open-cowork/issues/549).

Acceptance:

- Cloud threads can be started and continued from Web, Desktop Cloud, and
  Gateway where a channel is bound.
- SessionView parity covers messages, tool traces, approvals, questions,
  artifacts, todos, cost/status/errors, and reload hydration.
- Admin surfaces cover members, policy, BYOK, quotas, workers, Gateway, audit,
  usage, and diagnostics with role checks and redaction.
- Browser E2E, accessibility, and performance gates pass.

### Phase 3: Gateway Appliance v1

Make Gateway a production-grade headless Cloud client for self-hosted and
managed channel deployments.

Tracked by [#550](https://github.com/joe-broadhead/open-cowork/issues/550).

Acceptance:

- Gateway can self-host on a VPS/internal host with scoped service-token auth.
- Telegram, Slack, Email, Webhook, CLI, and later providers share one
  capability-driven rendering model.
- Approvals/questions work through inline controls where supported and
  token/link fallback where not.
- Gateway has no OpenCode SDK imports and no direct control-plane database
  ownership.

### Phase 4: Downstream Distribution Contract

Freeze the configuration, branding, packaging, and extension contracts that
let organizations ship internal or managed distributions without source
patches.

Tracked by [#551](https://github.com/joe-broadhead/open-cowork/issues/551).

Acceptance:

- A downstream organization can configure product name, logo, cloud URL, auth,
  profiles, tools, agents, MCPs, object store, secret adapter, quotas, billing
  mode, and Gateway providers without core source patches.
- Public examples use placeholders only.
- Extension docs map each seam to concrete modules and forbidden imports.
- Validators catch private-value leakage and branding regressions.

### Phase 5: Reference Deployments

Prove provider-neutral deployment with GCP first, while keeping real project
values outside the public repo.

Tracked by [#552](https://github.com/joe-broadhead/open-cowork/issues/552).

Acceptance:

- GCP deploys from a clean tmp/private repo using public templates.
- No real GCP project ids, account ids, private domains, customer names,
  prices, or secrets are committed.
- Cloud, Desktop connection, Gateway, worker, artifact, workflow, and restore
  smoke checks have a shared contract.
- AWS, Azure, DigitalOcean, Kubernetes, and VPS recipes stay adapter/config
  differences only.

### Phase 6: Managed BYOK SaaS Readiness

Prepare the open-source/public pieces needed by a downstream managed BYOK SaaS
repo without mixing private values into this repo.

Tracked by [#553](https://github.com/joe-broadhead/open-cowork/issues/553).

Acceptance:

- Self-host deployments work with billing disabled or stubbed.
- BYOK plaintext is never readable over HTTP and is revealed only in the
  worker/runtime role as allowed.
- Billing and entitlement gates block expensive managed execution before worker
  spawn/claim where possible.
- Public/private boundaries for onboarding, billing, support, evidence, and
  private launch values are documented and validated.

### Phase 7: Launch Evidence

Back launch claims with repeatable load, soak, failover, restore, security,
release, browser, Gateway, deployment, and private-value evidence.

Tracked by [#554](https://github.com/joe-broadhead/open-cowork/issues/554).

Acceptance:

- Evidence states which launch tier is proven: local/self-host beta, private
  hosted beta, public hosted beta, general availability, or enterprise-scale.
- Release gates fail closed when a surface-specific check is missing.
- Load/failover/restore/security findings create narrow follow-up issues.
- Public evidence templates contain no real project ids, domains, customers,
  prices, support rosters, or secrets.

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
