---
title: Downstream Contract
description: Versioned configuration, branding, packaging, and extension contract for downstream Open Cowork distributions.
---

# Downstream Contract

This page is the versioned contract for downstream distributions. It defines
which customizations are supported through config, assets, deployment manifests,
and adapters without source forks.

Open Cowork remains a product layer on top of OpenCode:

- OpenCode owns execution, runtime behavior, tools, permissions, questions,
  MCP execution, sessions, and native skills.
- Open Cowork owns Desktop, Cloud, Gateway, projection, policy, configuration,
  branding, packaging, and deployment ergonomics.

If a downstream customization requires patching OpenCode execution semantics or
adding a second runtime/control plane in Gateway, it is outside this contract.

## Contract Version

`open-cowork.config.json` must declare:

```json
{
  "contractVersion": 1
}
```

Version `1` covers the supported Desktop, Cloud, and Gateway distribution
surface in this repository. The JSON schema rejects unknown contract versions,
and partial overlays may omit the field because they merge over the built-in
default. Downstream packages should pin the repository release tag or commit
that owns the schema they validate against.

The contract version is for deployer-facing configuration compatibility. It is
separate from app release version, database migration version, settings storage
version, and OpenCode SDK/runtime version.

## Configuration Classes

Use the right supply path for each kind of value.

| Class | Examples | Source of truth | Public repo rule |
| --- | --- | --- | --- |
| Runtime config | `branding`, `cloudDesktop`, `cloud.publicBranding`, `cloud.features`, `cloud.profiles`, `gateway.branding`, `gateway.providers`, `i18n`, `telemetry.enabled` | `open-cowork.config.json` and downstream overlays | Placeholders and generic examples only. No raw secrets. |
| Packaging-time config | app id, bundle id, installer metadata, release source, icons, app resources, downstream skills/MCP bundles | package scripts, `branding` assets, CI/release overlays | Keep upstream back-compat ids unless deliberately creating a distinct downstream distribution. |
| Infrastructure config | database URL refs, object-store adapter, secret/KMS refs, OIDC issuer/client refs, gateway public URL, worker replicas, checkpoints, PDBs, topology spread | Helm, Compose, cloud provider manifests, process manager env | Use env refs and placeholders. No project ids, account ids, customer domains, credentials, prices, or launch evidence. |
| Private downstream config | real domains, customer/org data, SaaS pricing, Stripe ids, launch rosters, support rotations, incident evidence | private deployment or operations repo | Never committed to this public repo. |

## Supported Fields

The version 1 contract covers these deployer-owned surfaces.

| Surface | Config key or artifact | Supported customization |
| --- | --- | --- |
| Product identity | `branding.name`, `branding.appId`, `branding.dataDirName`, `branding.helpUrl`, `branding.projectNamespace` | Desktop app identity and on-disk namespace. `opencowork` remains only for documented back-compat defaults. |
| Desktop shell | `branding.sidebar`, `branding.home`, bundled `branding/` assets | Sidebar, first-run, home/composer copy, local image assets, theme selection. |
| Legal and support links | `branding.helpUrl`, `cloud.publicBranding.*Url`, `gateway.branding.*Url` | HTTPS public links, with `mailto:` allowed only where explicitly documented. |
| Cloud Desktop sync | `cloudDesktop` | Managed cloud orgs, user-added connection policy, cache mode, cache encryption fallback. |
| Cloud Web branding | `cloud.publicBranding` | Workbench/admin product name, logo URL, public legal/support links, dashboard copy, token labels, and theme tokens. |
| Cloud auth | `cloud.auth` | `none`, header demo/proxy mode with signed headers, or OIDC. Public deployments should use OIDC or signed trusted-proxy headers. |
| Cloud storage | `cloud.storage` | Control-plane store and object-store adapter selection. Multi-worker deployments need shared object storage and checkpoints. |
| Cloud profiles/policy | `cloud.defaultProfile`, `cloud.profiles`, `cloud.features`, `cloud.runtime`, `cloud.projectSources` | Agent/tool/MCP allowlists, product feature flags, runtime hardening, project source policy. |
| Billing mode | `cloud.billing` | `none` and `stub` for OSS self-host; managed adapters such as Stripe behind provider-neutral billing interfaces. |
| Abuse and quotas | `cloud.abuse` | Rate limits, prompt limits, worker/session caps, artifact byte caps, gateway delivery caps. |
| Gateway identity | `gateway.branding` | Channel-facing product name, legal/support links, dashboard labels. |
| Gateway cloud binding | env/deployment secrets | `OPEN_COWORK_CLOUD_BASE_URL`, `OPEN_COWORK_GATEWAY_SERVICE_TOKEN`, `OPEN_COWORK_GATEWAY_CLOUD_REQUEST_TIMEOUT_MS`, and loopback-only insecure HTTP policy. Runtime `gateway.cloud` JSON values and `gateway.timeouts.cloudRequestMs` are ignored by the gateway process. |
| Gateway process | `gateway.server`, `gateway.metrics`, `gateway.diagnostics`, `gateway.logging` | Host/port, public base URL, operator token, metrics/diagnostics exposure, log level. |
| Gateway channels | `gateway.providers` | Provider enablement, channel binding ids, credentials via env placeholders, provider settings. |
| Updates and telemetry | `updates`, `telemetry` | Optional release source and downstream-owned telemetry endpoint. Upstream defaults to local/no remote telemetry. |
| Runtime content | downstream `skills/` and `mcps/` roots | Add or replace app-managed skill bundles and bundled MCP packages referenced by config. |

Unsupported source-patch paths include editing renderer components for branding,
hardcoding cloud URLs in code, adding provider credentials to checked-in config,
adding Gateway runtime ownership, importing OpenCode SDK from clients, or
branching core cloud code on one provider's project/account identifiers.

## Branding Coverage

Downstream branding must flow through config and assets:

- Desktop renderer: `branding`, `branding.sidebar`, `branding.home`, local
  `branding/` assets, and release packaging metadata.
- Cloud Web: `cloud.publicBranding`, `cloud.publicBranding.dashboard`, and
  public theme tokens.
- Gateway: `gateway.branding`, provider display setup docs, and channel setup
  labels where the provider supports them.
- Docs/examples: downstream example files and docs should use public-safe
  placeholder brands such as Acme Cowork.
- Release artifacts: packager-supported names, icons, bundle ids, update feed
  labels, and manual fallback URLs.

Back-compat names such as `com.opencowork.desktop` and `.opencowork/` are
allowed only where docs identify them as migration or bundle-id compatibility.

## Extension Contracts

Downstream extension work must start in the layer that owns the concept.

| Extension point | Owning modules or artifacts | Required boundary |
| --- | --- | --- |
| Gateway channel providers | `packages/gateway-channel`, `packages/gateway-provider-*`, `apps/gateway/src/provider-registry.ts`, `apps/gateway/src/provider-readiness.ts` | Providers normalize channel I/O only. No OpenCode SDK imports, no direct control-plane DB access, no runtime ownership. |
| Billing adapters | `apps/desktop/src/main/cloud/billing-adapter.ts`, `stub-billing-adapter.ts`, `stripe-billing-adapter.ts` | Core services consume provider-neutral subscription and entitlement records. Provider SDK imports stay behind adapters. |
| Object-store adapters | `apps/desktop/src/main/cloud/object-store.ts` and deployment object-store config | Callers use object-store interfaces. Artifact, snapshot, and checkpoint code must not branch on cloud vendor ids. |
| Secret/KMS adapters | `apps/desktop/src/main/cloud/secret-adapter.ts`, `byok-secret-store.ts`, secret ref resolvers | Secrets are refs or encrypted envelopes. Plaintext reveal is limited to the owning runtime role. |
| Runtime profiles and policy packs | `cloud.profiles`, `cloud.runtime`, `cloud-config.ts`, `runtime-config-builder.ts` | Cloud profiles force app-managed runtime config by default and must not enable machine config or arbitrary local stdio MCPs without explicit policy. |
| Worker pool modes | `docs/managed-workers.md`, `managed-worker-types.ts`, `services/managed-worker-service.ts`, deployment manifests | Add modes only with trust-model docs, lifecycle tests, and deployment gates. Customer-hosted workers remain deferred unless separately designed. |
| Cloud Web modules and admin panels | `apps/website/src`, `docs/cloud-web-workbench.md`, route/API metadata tests | Web remains a cloud API client. It must not import stores, runtime adapters, secret adapters, or provider-specific internals. |
| BYOK provider validation/injection | `byok-secret-store.ts`, `runtime-config-builder.ts`, `opencode-runtime-adapter.ts`, `cloud-config.ts` | Provider keys enter OpenCode runtime config as provider options, never process env, logs, renderer state, diagnostics, or cache. |
| Deployment recipes | `deploy/`, `helm/`, `docker-compose*.yml`, deployment validators | Public recipes are provider-neutral templates. Real ids, domains, prices, credentials, signed URLs, and launch evidence stay private. |

## Template Hygiene

Public templates and docs may include placeholders such as `PROJECT`,
`ACCOUNT_ID`, `REGION`, `VERSION`, `registry.example.com`, or
`cowork.example.com`. They must not include:

- provider keys, API tokens, cookie secrets, OAuth refresh/access tokens, MCP
  secrets, webhook secrets, or BYOK plaintext
- real cloud project ids, account ids, subscription ids, tenant ids, bucket
  names, registry names, or provider-hosted URLs
- real customer names, customer domains, support rosters, incident evidence, or
  launch go/no-go values
- Stripe price/product/account ids or private managed-SaaS price values
- signed URL query strings or object keys that reveal private artifact paths
- mutable production image tags such as `latest` or `stable`
- branding changes that require source patches instead of config/assets

Run `pnpm deploy:validate` and `pnpm lint` before publishing downstream-facing
changes. When docs change, also run `pnpm docs:build`.

## Completion Checklist

A downstream distribution is inside the version 1 contract when:

- `open-cowork.config.json` validates with `contractVersion: 1`
- Desktop, Cloud Web, and Gateway branding come from config/assets
- self-host installs can keep `cloud.billing.provider=none` or `stub`
- secrets are supplied by env refs or the secret adapter, not committed config
- Cloud profiles define allowed agents/tools/MCPs and runtime hardening
- Gateway providers are explicit and signed where public
- images are pinned by release tag or digest
- public templates contain placeholders only
- extension changes preserve the OpenCode execution boundary
