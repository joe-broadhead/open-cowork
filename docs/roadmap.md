# Roadmap

Last updated: 2026-07-05.

Open Cowork is now planned as a multi-authority product over OpenCode:

- **Desktop:** local-first Electron app with local workspaces, optional cloud
  workspaces, and future outbound pairing.
- **Cloud:** web app, API, worker, scheduler, control plane, BYOK, policy,
  object storage, and optional Cloud Channel Gateway.
- **Gateway:** either a Cloud Channel Gateway adapter or a Standalone Team
  Gateway execution appliance with private OpenCode and Gateway Postgres.

The product promise is **workspace-scoped product sync**, not peer-to-peer sync
and not runtime-home replication. Cloud workspaces sync across Desktop, Cloud
Web, and Cloud Channel Gateway because every surface reads and writes the same
tenant-scoped Cloud control plane. Local Desktop and Standalone Gateway
workspaces stay private unless a user explicitly imports, pairs, registers, or
syncs through a documented connector.

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

Open Cowork should be useful in every supported deployment mode:

- **Local desktop:** a user runs OpenCode locally through a polished desktop
  product layer with no cloud dependency.
- **Gateway-only:** a user or team runs an always-on private Gateway OpenCode
  appliance on a VPS, private server, or Kubernetes without Cloud.
- **Self-hosted cloud:** an organization runs desktop, cloud, and gateway on its
  own infrastructure with its own branding, auth, storage, secrets, profiles,
  tools, agents, MCPs, and gateway providers.
- **Hybrid:** Desktop, Gateway, and Cloud can be combined through explicit
  workspace authorities, Cloud registration, and outbound Desktop pairing.
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
4. Gateway mode is explicit. Cloud Channel Gateway is headless and
   cloud-backed; Standalone Team Gateway may own private OpenCode and Gateway
   Postgres without requiring Cloud.
5. Downstream deployers can configure the product without forking core code:
   branding, cloud URL, auth, profiles, tools, agents, MCPs, features, object
   store, secrets, quotas, and gateway providers.
6. Hosted SaaS stays BYOK. Managed Open Cowork can charge for hosted
   cloud/gateway/sync while users bring their own provider keys.
7. OSS self-host remains first-class. Billing and managed-service features must
   not block self-hosted cloud/gateway deployments.

## Strategic Roadmap

The multi-authority roadmap was tracked by
[issue #575](https://github.com/joe-broadhead/open-cowork/issues/575), which is
now closed along with its child issues; the work it scoped has shipped. Those
child issues remain the historical record of implementation scope and
acceptance. The canonical workspace and authority semantics live in the
[Product Contract](product-contract.md). Optional Cloud registration for
Standalone Gateway workspaces and edge capacity is defined in
[Cloud Gateway Registration](cloud-gateway-registration.md). Shared team,
workflow, schedule, watch, and delegation nouns are defined in the
[Coordination Model](coordination-model.md).

- [#576](https://github.com/joe-broadhead/open-cowork/issues/576) - execution
  authority and workspace support contract.
- [#577](https://github.com/joe-broadhead/open-cowork/issues/577) - split Cloud
  Channel Gateway and Standalone Team Gateway modes.
- [#578](https://github.com/joe-broadhead/open-cowork/issues/578) -
  instance-aware channel provider platform.
- [#579](https://github.com/joe-broadhead/open-cowork/issues/579) - Standalone
  Gateway execution appliance.
- [#580](https://github.com/joe-broadhead/open-cowork/issues/580) - Desktop
  outbound pairing connector.
- [#581](https://github.com/joe-broadhead/open-cowork/issues/581) - Gateway and
  paired Desktop workspaces in Desktop.
- [#582](https://github.com/joe-broadhead/open-cowork/issues/582) - Cloud edge
  execution and Gateway registration.
- [#583](https://github.com/joe-broadhead/open-cowork/issues/583) - unified
  teams, workflows, schedules, watches, and delegation.
- [#584](https://github.com/joe-broadhead/open-cowork/issues/584) - enterprise
  and solo deployment topology kits.
- [#585](https://github.com/joe-broadhead/open-cowork/issues/585) - production
  security, policy, audit, and compliance gates for hybrid modes.
- [#586](https://github.com/joe-broadhead/open-cowork/issues/586) - setup,
  onboarding, and health center.
- [#587](https://github.com/joe-broadhead/open-cowork/issues/587) - OSS
  packaging, docs, and migration strategy for merged Gateway products.

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
- `pnpm docs:build` or CI docs build when docs are touched
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
