---
title: Packaging and Gateway Product Modes
description: Product names, package boundaries, release channels, and support policy for Open Cowork Desktop, Cloud, and Gateway.
---

# Packaging and Gateway Product Modes

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

Do not use `OpenCode Gateway` for Open Cowork product surfaces; OpenCode is
the runtime and Open Cowork owns the Gateway product modes above. If a doc is
specifically about the separate external
[`opencode-gateway`](https://github.com/joe-broadhead/opencode-gateway)
project, name it explicitly as **OpenCode Gateway** and mark it as an external
integration rather than an Open Cowork Gateway mode.

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

## Release Channels

| Channel | Meaning | Required evidence |
| --- | --- | --- |
| `master` source | Latest merged source. Not a release channel. | CI on `master` |
| `v0.x` preview | Public OSS preview. APIs and packaging may still move. | CI, docs, checksums, SBOM/provenance, explicit unsigned macOS notice while applicable |
| private hosted beta | Managed BYOK beta for design partners. May use private ops evidence outside this repo. | private beta evidence, launch evidence manifest, BYOK redaction, restore/failover drills |
| public beta | Public hosted BYOK. No enterprise promise yet. | load/soak, supply-chain, abuse, billing, support, and deployment evidence |
| `v1.x` stable | Broad OSS release baseline. | signed/notarized macOS or explicit platform policy, stable docs, state-change notes, release gates |
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
- `open-cowork.config.json` and deploy examples use placeholders for private
  domains, project ids, customer names, prices, and secrets.
- Release notes state the accepted launch tier: preview, private hosted beta,
  public beta, stable, or enterprise-ready.

## Validation

Run these checks after editing packaging, naming, product-mode, or release docs:

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


## Env naming disambiguation (channel vs standalone)

| Binary | Package | Product mode value | Env family |
| --- | --- | --- | --- |
| Cloud Channel Gateway | `apps/gateway` | `cloud_channel` only | `OPEN_COWORK_GATEWAY_*` (includes `OPEN_COWORK_GATEWAY_PRODUCT_MODE`) |
| Standalone Gateway | `apps/standalone-gateway` | `standalone` only | `OPEN_COWORK_STANDALONE_GATEWAY_*` |

`OPEN_COWORK_GATEWAY_PRODUCT_MODE` is **not** a switch that turns `apps/gateway` into Standalone.
Setting it to `standalone` or `hybrid` fails closed and names the correct binary in the error message.
