---
title: OSS Packaging and Gateway Migration
description: Product names, package boundaries, release channels, and migration guidance for Open Cowork Desktop, Cloud, and Gateway.
---

# OSS Packaging and Gateway Migration

Open Cowork is one open-source product family with multiple deployable
surfaces. The names below are the public names to use in docs, releases,
support, and downstream builds.

The most important rule is unchanged: Open Cowork is a product layer on top of
OpenCode. It should not become a second OpenCode runtime.

## Product Names

| Public name | Status | Owning code | Release artifact |
| --- | --- | --- | --- |
| Open Cowork Desktop | Supported | `apps/desktop` | macOS `.dmg`/`.zip`, Linux `.AppImage`/`.deb` |
| Open Cowork Cloud | Supported for self-host beta and private hosted beta | cloud server code under `packages/cloud-server`; the browser UI is the unified renderer (`packages/app/src`) served by the cloud at `GET /` | `open-cowork-cloud` OCI image and Helm/Compose assets |
| Open Cowork Gateway | Supported as a cloud channel adapter | `apps/gateway`, `packages/gateway-*` | `open-cowork-gateway` OCI image and Helm/Compose assets |
| Open Cowork Standalone Gateway | Supported as a Gateway-only execution appliance | `apps/standalone-gateway` | source package and `open-cowork-gateway-standalone` CLI; OCI image can be added after the release gate exists |
| Open Cowork Mobile | Reserved | none yet | no artifact |
| Open Cowork Teams | Reserved product/edition name | team and org policy surfaces across Cloud/Gateway | no separate runtime |

Use **Open Cowork Gateway** as the user-facing umbrella. Be precise in
operator docs:

- **Cloud Channel Gateway** means `apps/gateway`: it connects chat providers
  to Open Cowork Cloud through HTTP/SSE and never spawns OpenCode.
- **Standalone Gateway** means `apps/standalone-gateway`: it owns a private
  OpenCode runtime and Gateway Postgres for Gateway-only deployments.

Do not use `OpenCode Gateway` for new Open Cowork docs except when describing
the historical standalone prototype.

## Package and Image Names

| Surface | Package or image | Stability |
| --- | --- | --- |
| Desktop app | `@open-cowork/desktop` workspace package | internal workspace package |
| Cloud image | `ghcr.io/<owner>/open-cowork-cloud:<tag>` | release image |
| Cloud Helm chart | `helm/open-cowork-cloud` | release/deployment asset |
| Cloud Channel Gateway app | `@open-cowork/gateway` workspace package | internal workspace package |
| Cloud Channel Gateway image | `ghcr.io/<owner>/open-cowork-gateway:<tag>` | release image |
| Cloud Channel Gateway Helm chart | `helm/open-cowork-gateway` | release/deployment asset |
| Standalone Gateway app | `@open-cowork/standalone-gateway` workspace package | internal workspace package |
| Standalone Gateway CLI | `open-cowork-gateway-standalone` | source-built CLI |
| Shared API client | `@open-cowork/cloud-client` | workspace source package; public SDK packaging requires its own release checklist |
| Shared contracts | `@open-cowork/shared` | internal/shared workspace package |

The release workflow publishes Desktop artifacts plus Cloud and Gateway OCI
images. Workspace packages are not automatically public npm packages. If a
package is promoted to a public SDK, it needs semver, API stability docs,
README examples, changelog entries, and package-level provenance.

## Compatibility Alias Policy

Historical names may remain only as explicit compatibility aliases:

| Historical name | Policy |
| --- | --- |
| `opencode-agent-gateway` repository | Historical prototype source. New users should use this `open-cowork` repo. |
| `opencode-gateway` npm package | Distinct upstream tool, not a legacy alias. [`opencode-gateway`](https://github.com/joe-broadhead/opencode-gateway) is an independently maintained OpenCode durable work coordinator (Initiatives/Issues, scheduler, human gates, Mission Control) that Open Cowork integrates as an optional local MCP (`opencode-gateway mcp --tools operate`, tools exposed as `gateway_*`). It is separate from **Open Cowork Gateway** / **Standalone Gateway** (the channel adapters) despite the name overlap; do not treat the two as the same product. |
| `ghcr.io/<owner>/opencode-gateway` image | Legacy image name. Do not publish new primary releases there unless it is an explicit alias to the matching Open Cowork image digest. |
| `gateway.config.yaml` | Legacy standalone config name. Keep readable in migration docs, but new Open Cowork deployments should use `open-cowork.config.json` plus environment or secret-manager values. |
| legacy unhyphenated Open Cowork spelling | Back-compat only for existing app ids, on-disk namespaces, or migration notes. New public docs should use `open-cowork`. |

Compatibility aliases must not hide a product-mode change. A user moving from
the old standalone prototype to Cloud Channel Gateway is moving from a
Gateway-owned runtime to Cloud-owned execution. That requires an explicit
deployment decision.

## Product Modes

| Mode | User promise | Execution authority | Best for |
| --- | --- | --- | --- |
| Desktop local | Private local OpenCode workspace | Desktop-managed local runtime | individual desktop use, offline/local projects |
| Cloud workspace | Synced browser/desktop/gateway cloud sessions | Cloud workers | team sync, managed BYOK, web workbench |
| Cloud Channel Gateway | Chat access to Cloud workspaces | Cloud workers; Gateway is a client | Telegram/Slack/email access to Cloud |
| Standalone Gateway | Chat-first private appliance | Standalone Gateway plus private OpenCode | VPS, private server, no Cloud dependency |
| Full hybrid | Desktop local plus Cloud plus Gateway | per-thread authority | organizations that want local privacy and cloud collaboration |

The same product may expose multiple modes, but one thread has exactly one
execution authority. Local threads stay local. Cloud threads sync through
Cloud. Gateway messages belong either to a Cloud Channel Gateway session or to
a Standalone Gateway session; they should not be merged implicitly.

## Migration From `opencode-agent-gateway`

The old gateway prototype has useful concepts and configuration, but its
durable state is not the same as Open Cowork Cloud state.

### Choose the destination first

| If the old deployment was... | Recommended destination |
| --- | --- |
| A Telegram or webhook bot running its own OpenCode server and Postgres | Open Cowork Standalone Gateway |
| A bot that should share sessions with Desktop and Web | Open Cowork Cloud plus Cloud Channel Gateway |
| A local development mock or provider contract test bed | Cloud Channel Gateway with fake provider in explicit loopback demo mode, or provider package tests |
| A manager/team orchestration prototype | Keep as Standalone Gateway until the Cloud team-orchestration contract is implemented |

### Configuration inventory

Before switching, inventory these values from the old deployment:

- provider tokens and webhook secrets
- allowed users, admins, chats, and provider subject ids
- workspace roots and worktree roots
- OpenCode server URL and auth
- database URL
- upload/artifact storage path
- backup and retention policy
- scheduler/background job settings
- admin dashboard token and exposure policy

Do not paste old secrets into docs, issue comments, screenshots, or the public
repo. Move them through environment variables or a secret manager.

### Config mapping

| Old prototype concept | Cloud Channel Gateway | Standalone Gateway |
| --- | --- | --- |
| `providers.telegram.instances[].botTokenEnv` | `OPEN_COWORK_GATEWAY_TELEGRAM_BOT_TOKEN` or `gateway.providers.telegram[]` with env placeholders | `OPEN_COWORK_STANDALONE_GATEWAY_TELEGRAM_BOT_TOKEN` |
| signed bridge provider | `OPEN_COWORK_GATEWAY_WEBHOOK_SHARED_SECRET` or gateway provider config | standalone webhook provider secret |
| `admin.tokenEnv` | `OPEN_COWORK_GATEWAY_ADMIN_TOKEN` for operator routes | `OPEN_COWORK_STANDALONE_GATEWAY_ADMIN_TOKEN` |
| `database.urlEnv` | not used by `apps/gateway`; Cloud owns Postgres | `OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_URL` |
| `opencode.*` | not used by `apps/gateway`; Cloud workers own OpenCode | `OPEN_COWORK_STANDALONE_GATEWAY_OPENCODE_URL` |
| workspace/worktree roots | Cloud project sources and uploaded snapshots | standalone workspace/worktree policy |
| scheduler/background jobs | Cloud workflows and deliveries | standalone scheduler/background jobs |
| dashboard | Cloud Web admin or Gateway operator endpoints | standalone dashboard |

### State migration policy

There is no safe automatic database migration from the old
`opencode-agent-gateway` Postgres schema into Open Cowork Cloud. The old schema
owned runtime, conversation, workspace, job, and OpenCode session state. Cloud
uses tenant-scoped sessions, commands, events, projections, artifacts,
workflows, policies, BYOK refs, and channel bindings.

Supported migration path:

1. Export old transcripts, audit records, and artifact manifests for archive.
2. Stand up Open Cowork Cloud or Standalone Gateway with fresh durable state.
3. Recreate provider bindings and allowlists from the inventory.
4. Recreate scheduled workflows or standalone jobs explicitly.
5. Reconnect users to new sessions.
6. Keep the old database read-only until the retention window expires.

Do not import old OpenCode runtime homes, provider keys, local project paths, or
stdio MCP command definitions into Cloud automatically. Cloud-safe equivalents
must be expressed as project sources, secret refs, remote MCPs, profile policy,
or explicit artifact uploads.

## Release Channels

| Channel | Meaning | Required evidence |
| --- | --- | --- |
| `master` source | Latest merged source. Not a release channel. | CI on `master` |
| `v0.x` preview | Public OSS preview. APIs and packaging may still move. | CI, docs, checksums, SBOM/provenance, explicit unsigned macOS notice while applicable |
| private hosted beta | Managed BYOK beta for design partners. May use private ops evidence outside this repo. | private beta evidence, launch evidence manifest, BYOK redaction, restore/failover drills |
| public beta | Public hosted BYOK. No enterprise promise yet. | load/soak, supply-chain, abuse, billing, support, and deployment evidence |
| `v1.x` stable | Broad OSS release baseline. | signed/notarized macOS or explicit platform policy, stable docs, migration notes, release gates |
| enterprise-ready | Downstream/internal enterprise deployments. | SSO/OIDC, audit/export, backup/restore, operator runbooks, support SLA, tenant isolation evidence |

Cloud and Gateway images must use the same release tag as the source release
and should be deployed by digest from the image evidence files. Do not deploy
`latest` for shared, beta, or production environments.

## Support Policy

| Deployment | Support expectation |
| --- | --- |
| OSS local desktop | GitHub issues, docs, and community best effort. |
| OSS self-host Cloud/Gateway | GitHub issues plus deployment readiness docs. Operators own their infrastructure, secrets, backups, and cloud bills. |
| Internal enterprise downstream | The downstream owner controls branding, OIDC, infra, private config, and support process. Keep private values outside the public repo. |
| Managed BYOK SaaS | Commercial operator owns uptime, billing, incident response, backup/restore, token handling, customer support, and private launch evidence. |
| Security issues | Use `SECURITY.md`; do not file public issues with exploit details or secrets. |

Support docs must be honest about launch tier. The public repo can claim local
self-host beta evidence. Managed SaaS or enterprise claims need private
operations evidence before being marketed as GA.

## Release Checklist Additions

Before a release that touches Desktop, Cloud, Gateway, packaging, or docs:

- Product names in README, docs, release notes, images, and Helm/Compose
  examples match this page.
- Cloud Channel Gateway and Standalone Gateway are not described as the same
  product mode.
- Any compatibility alias points to the matching Open Cowork artifact digest or
  package version and warns about legacy status.
- Gateway migration notes are current for the old `opencode-agent-gateway`
  concepts.
- `open-cowork.config.json` and deploy examples use placeholders for private
  domains, project ids, customer names, prices, and secrets.
- Release notes state the accepted launch tier: preview, private hosted beta,
  public beta, stable, or enterprise-ready.

## Validation

Run these checks after editing packaging, naming, migration, or release docs:

```bash
pnpm docs:build
git diff --check
```

For release-sensitive edits, also run:

```bash
pnpm deploy:validate
pnpm deploy:launch:validate
pnpm ops:validate
```
